/**
 * The Post image squad (P5 B4, `studio.md` §8): a document of one slide, so it shares the slide ops, the Brand Kit and
 * `render_stills`. The picture is a frame of the founder's video or a captured page, with the title as a text layer;
 * with neither, the title sits on the Brand Kit background. Nothing is generated, so nothing spends credits.
 *
 * A frame must be in the edit's own library: the worker only reads media of the task's job. So the edit is made in the
 * source video's job and takes the frame's library record.
 */

import { addAsset, normalizeManifest } from "@opencmo/clip-assets";
import { CAPTURE_SRC_PREFIX, SLIDE_TEXT_MAX } from "@opencmo/editor-core";

import { clipContext } from "@/lib/api/clips";
import { firstRow, rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import { defaultBrandKit } from "@/lib/brand";
import { applyToClip, readEditorProject } from "@/lib/editor/apply";
import { saveDocument } from "@/lib/editor/document";
import { ensureProject } from "@/lib/editor/project";
import { wakeWorker } from "@/lib/modal";
import { saveFrame } from "@/lib/mcp/save-frame";

import { PostImageBriefSchema, type BuiltPostImage, type PostImageBrief, type StudioContext } from "../types";
import { stillsRequestId } from "./build";

/** The closest frame each platform shows whole (`jobs.aspect` has no 4:5). A YouTube image is its thumbnail. */
export function postImageAspect(platform: string): "9:16" | "1:1" | "16:9" {
  if (platform === "tiktok_caption") return "9:16";
  if (platform === "x" || platform === "youtube") return "16:9";
  return "1:1";
}

/** A new frame is probed by the worker first, and the export refuses media that is not ready. */
const READY_TRIES = 30;
const READY_WAIT_MS = 1000;

async function assetReady(supabase: SupabaseClient, mediaId: string): Promise<boolean> {
  for (let attempt = 0; attempt < READY_TRIES; attempt++) {
    const { data, error } = await supabase.from("media_assets").select("status").eq("id", mediaId).maybeSingle<{ status: string }>();
    if (error) throw new Error(`media_assets read: ${error.message}`);
    if (data?.status === "ready") return true;
    if (!data || data.status === "error") return false;
    await new Promise((resolve) => setTimeout(resolve, READY_WAIT_MS));
  }
  return false;
}

/**
 * The frame's library path on the edit, or null when it cannot be had (looking is not set up, the video changed): the
 * image then falls back to the plain background rather than failing the post.
 */
async function frameOnEdit(ctx: StudioContext, source: { clipId: string; time: number }, editId: string): Promise<string | null> {
  const saved = await saveFrame(ctx.supabase, ctx.userId, { clip_id: source.clipId, time: source.time });
  if ("error" in saved) {
    console.warn(`[studio] post image frame of ${source.clipId}: ${saved.error}`);
    return null;
  }
  const path = String(saved.data.path);
  const record = normalizeManifest((await readEditorProject(ctx.supabase, source.clipId)).manifest).assets.find((asset) => asset.path === path);
  const mediaId = (record?.cloud as { mediaId?: string } | undefined)?.mediaId;
  if (!record || !mediaId || !(await assetReady(ctx.supabase, mediaId))) return null;
  const edit = await readEditorProject(ctx.supabase, editId);
  await saveDocument(ctx.supabase, editId, edit.version, edit.document, { manifest: addAsset(normalizeManifest(edit.manifest), record).manifest });
  return path;
}

export async function buildPostImage(ctx: StudioContext, input: PostImageBrief): Promise<BuiltPostImage> {
  const brief = PostImageBriefSchema.parse(input);
  if (brief.title.length > SLIDE_TEXT_MAX.heading) return { kind: "invalid", message: `The image's title is over ${SLIDE_TEXT_MAX.heading} characters.` };
  const frame = brief.source && "clipId" in brief.source ? brief.source : null;

  const clipId = await rpcOrThrow<string>(ctx.supabase, "create_post_image_edit", {
    p_name: brief.title.slice(0, 60),
    p_aspect: postImageAspect(brief.platform),
    p_source_clip: frame?.clipId ?? null,
  });
  const context = await clipContext(ctx.supabase, clipId);
  await ensureProject(ctx.supabase, context, clipId);

  const src = frame ? await frameOnEdit(ctx, frame, clipId) : brief.source && "captureId" in brief.source ? `${CAPTURE_SRC_PREFIX}${brief.source.captureId}` : null;
  const kit = await defaultBrandKit(ctx.supabase);
  const ops = [{ op: "add_slide", heading: brief.title, ...(src ? { background: { src } } : {}) }, ...(kit ? [{ op: "apply_brand", kit: kit.kit, frame: false }] : [])];
  await applyToClip(ctx.supabase, context, clipId, ops, { checkpoint: null });

  const project = await readEditorProject(ctx.supabase, clipId);
  const revision = await rpcOrThrow<{ id: string }>(ctx.supabase, "snapshot_editor_revision", { p_clip_id: clipId, p_document_hash: project.document_hash });
  const stills = firstRow(await rpcOrThrow<{ id: string } | { id: string }[]>(ctx.supabase, "request_stills_export", { p_clip_id: clipId, p_revision_id: revision.id, p_request_id: stillsRequestId(clipId, project.document_hash) }));
  if (!stills) throw new Error("request_stills_export returned no task.");
  await rpcOrThrow(ctx.supabase, "studio_post_image_rendering", { p_order_id: ctx.orderId ?? null, p_clip_id: clipId, p_post_id: brief.postId, p_stills_task: stills.id });
  await wakeWorker({ task_id: stills.id });
  return { kind: "rendering", clipId, stillsTaskId: stills.id };
}
