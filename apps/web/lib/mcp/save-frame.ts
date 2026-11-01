/**
 * `save_frame` over MCP (editor-MCP plan, item 1): one frame of the clip, without text or captions, saved to
 * the library folder Frames so `generate_media` can use it as `start_image` / `end_image`.
 *
 * It takes the same steps as the editor's upload (`components/editor/library/store.ts`), every write
 * through an ownership-checking RPC under the user's RLS:
 * 1. the worker draws the frame (`look` op `frame`, the export's renderer, text left out);
 * 2. `reserve_upload` for `media/<user>/<project>/<uuid>.jpg`, then the bytes go to Storage with the
 *    user's own token (Storage RLS refuses an object without that reservation);
 * 3. `register_media_asset` creates the asset and queues its probe task (one transaction), then the
 *    worker is woken;
 * 4. the library record is added to the project's manifest with `save_editor_document`.
 *
 * The bytes pass through the MCP server on Modal, never through Next.js on Vercel (web rule 3).
 *
 * The project version is the one read before the upload: if the editor or the Assistant saves in
 * between, the manifest save loses the optimistic lock and the new asset is deleted again, so a
 * failed save leaves no orphan in the library or Storage.
 *
 * UNTESTED end to end (2026-10-20): needs a database, Storage, the deployed `look` endpoint and the
 * probe task; only the manifest step (`frameRecord`) runs in `save-frame.check.ts`. Note: an image
 * model needs fal budget, which is why the plan ranks this last.
 */

import { randomUUID } from "node:crypto";

import { addAsset, normalizeManifest, type Manifest } from "@opencmo/clip-assets";
import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import { saveDocument } from "@/lib/editor/document";
import { ensureProject } from "@/lib/editor/project";
import { wakeWorker } from "@/lib/modal";

import { lookAt } from "./look";

export const saveFrameInput = z.object({
  clip_id: z.string().uuid(),
  time: z.number().min(0).describe("Clip-timeline second of the frame."),
  name: z.string().trim().max(60).optional().describe("A file name for it, e.g. before-cut."),
});

export type SaveFrameAnswer = { images: string[]; data: Record<string, unknown> } | { error: string };

/** The manifest with the frame's record in Frames/ (a free path), and that record's path. */
export function frameRecord(
  manifest: unknown,
  frame: { stem: string; mediaId: string; width: number; height: number; now: string; id?: string },
): { manifest: Manifest; path: string } {
  const current = normalizeManifest(manifest);
  const folders = current.folders.includes("Frames") ? current.folders : [...current.folders, "Frames"];
  const path = `Frames/${frame.stem}.jpg`;
  const added = addAsset(
    { ...current, folders },
    {
      id: frame.id ?? randomUUID(),
      path,
      source: `assets/${path}`,
      type: "IMAGE",
      mimeType: "image/jpeg",
      createdAt: frame.now,
      width: frame.width,
      height: frame.height,
      cloud: { state: "synced", mediaId: frame.mediaId },
    },
  );
  return { manifest: added.manifest, path: added.record.path };
}

export const frameStem = (time: number, name?: string) => (name || `frame-${time.toFixed(1)}s`).replace(/[^\w.-]+/g, "-").slice(0, 60);

export async function saveFrame(supabase: SupabaseClient, userId: string, input: z.infer<typeof saveFrameInput>): Promise<SaveFrameAnswer> {
  const { answer: shot, seen } = await lookAt(supabase, userId, "frame", { clip_id: input.clip_id, time: input.time, edge: 1280 });
  if ("error" in shot) return shot;
  const base64 = shot.images[0];
  if (!base64 || !seen) return { error: "The frame could not be drawn." };
  const bytes = Buffer.from(base64, "base64");

  const { context } = seen;
  const jobId = context.clip.job_id;
  const objectName = `${userId}/${jobId}/${randomUUID()}.jpg`;
  // Same reservation and content type as the editor's upload (`/api/v1/uploads`, `upload-tus.ts`):
  // the reservation trigger admits `video/%` only, and the probe task reads the real type.
  await rpcOrThrow(supabase, "reserve_upload", { p_bucket: "media", p_object_name: objectName, p_size: bytes.length, p_content_type: "video/x-upload", p_project_id: jobId });
  const { error: uploadError } = await supabase.storage.from("media").upload(objectName, bytes, { contentType: "video/x-upload", upsert: false });
  if (uploadError) return { error: "The frame could not be saved to your media. Try again." };

  const stem = frameStem(input.time, input.name);
  const registered = await rpcOrThrow<{ asset: { id: string; status: string }; task_id: string | null }>(supabase, "register_media_asset", {
    p_job_id: jobId,
    p_storage_path: `media/${objectName}`,
    p_name: `${stem}.jpg`,
    p_request_id: randomUUID(),
  });
  const width = Number(shot.data.width) || 0;
  const height = Number(shot.data.height) || 0;
  const now = new Date().toISOString();
  // The look took seconds: save on the project as it is NOW (an open editor autosaves meanwhile),
  // once more if it moves again between this read and the save.
  const save = async () => {
    const current = await ensureProject(supabase, context, input.clip_id);
    const record = frameRecord(current.manifest, { stem, mediaId: registered.asset.id, width, height, now });
    await saveDocument(supabase, input.clip_id, current.version, current.document, { manifest: record.manifest });
    return record.path;
  };
  let path: string;
  try {
    path = await save().catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 409) return save();
      throw err;
    });
  } catch (err) {
    // The asset's delete trigger removes the Storage object too.
    await rpcOrThrow(supabase, "delete_media_asset", { p_asset_id: registered.asset.id }).catch((cleanup) => console.error("[mcp] save_frame cleanup", cleanup));
    if (err instanceof ApiError && err.status === 409) {
      return { error: "The edit changed while the frame was saved (the editor or the Assistant saved it). Call save_frame again." };
    }
    throw err;
  }
  // Only a frame that landed in the library is checked: woken before, a failed save left the
  // worker probing an object the cleanup had just deleted.
  if (registered.task_id) await wakeWorker({ task_id: registered.task_id });

  return {
    images: [base64],
    data: {
      path,
      saved: registered.asset.status === "ready",
      message:
        registered.asset.status === "ready"
          ? `Saved as ${path}. Use it as start_image or end_image.`
          : `Saved as ${path}; it is being checked and is usable as start_image or end_image in a few seconds (wait_for_media or list_library shows when).`,
    },
  };
}
