import { randomUUID } from "node:crypto";

import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { clipContext } from "@/lib/api/clips";
import { firstRow, rpcOrThrow, withApi, type SupabaseClient } from "@/lib/api/handler";
import type { TaskRow } from "@/lib/api/shapes";
import { applyToClip } from "@/lib/editor/apply";
import { ensureEditorProject } from "@/lib/editor/project";
import { wakeWorker } from "@/lib/modal";
import { planById } from "@/lib/pricing";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("dismiss"), reason: z.string().trim().max(400).optional() }),
]);

type Pack = { id: string; status: string; clips: { clip_id: string }[] };

/**
 * Chỉnh clip trước khi dựng bản tải về (học Palmier §B1/§C1): bỏ khoảng lặng,
 * phụ đề 4 chữ giữ qua khoảng nghỉ ngắn. Brand Kit đã áp lúc project được tạo.
 * Op nào không áp được (clip không có phụ đề) thì bỏ qua — vẫn xuất clip.
 */
const POLISH = [
  { op: "remove_silence", min_pause: 0.5, padding: 0.15 },
  { op: "set_caption_breaks", max_words: 4, hold_gap: 0.4 },
];

async function planResolution(supabase: SupabaseClient, userId: string): Promise<720 | 1080> {
  const { data } = await supabase.from("profiles").select("plan").eq("id", userId).maybeSingle<{ plan: string }>();
  return (planById(data?.plan ?? "free") ?? planById("free"))?.maxExportResolution ?? 720;
}

/** Một clip: project editor (tạo nếu chưa mở) → chỉnh → chụp revision → xếp export trên worker. */
async function exportClip(supabase: SupabaseClient, clipId: string, resolution: 720 | 1080): Promise<string> {
  const context = await clipContext(supabase, clipId);
  let project = await ensureEditorProject(supabase, context, clipId);
  for (const op of POLISH) {
    try {
      const applied = await applyToClip(supabase, context, clipId, [op], { checkpoint: null });
      project = { ...project, document_hash: applied.project.document_hash, version: applied.project.version };
    } catch (error) {
      console.warn("[cmo] video pack: bỏ qua bước chỉnh", op.op, error instanceof Error ? error.message : error);
    }
  }
  const revision = firstRow(
    await rpcOrThrow<{ id: string } | { id: string }[]>(supabase, "snapshot_editor_revision", {
      p_clip_id: clipId,
      p_document_hash: project.document_hash,
    }),
  );
  if (!revision) throw new ApiError(500, "Could not prepare a clip for download.");
  const task = firstRow(
    await rpcOrThrow<TaskRow | TaskRow[]>(supabase, "request_document_export", {
      p_clip_id: clipId,
      p_revision_id: revision.id,
      p_request_id: randomUUID(),
      p_resolution: resolution,
    }),
  );
  if (!task) throw new ApiError(500, "Could not start a clip export.");
  await wakeWorker({ task_id: task.id });
  return task.id;
}

/**
 * Người dùng quyết một gói video. Duyệt = chỉnh + dựng bản tải về cho từng clip
 * (dưới quyền CỦA họ — RPC editor chỉ nhận người dùng). Không đăng gì: tải về
 * rồi tự đăng, như W3.
 */
export const POST = withApi(
  { body, rateLimit: { bucket: "presets", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, user, body, params }) => {
    const id = params.id;
    if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) throw new ApiError(404, "Video pack not found.");
    if (body.action === "dismiss") {
      return rpcOrThrow(supabase, "cmo_decide_video_pack", { p_id: id, p_action: "dismissed", p_exports: [], p_reason: body.reason ?? null });
    }
    const { data } = await supabase.from("video_packs").select("id, status, clips").eq("id", id).maybeSingle();
    const pack = data as Pack | null;
    if (!pack) throw new ApiError(404, "Video pack not found.");
    if (pack.status !== "in_review") throw new ApiError(409, "This video pack was already decided.");
    const resolution = await planResolution(supabase, user.id);
    const exports: { clip_id: string; task_id: string }[] = [];
    for (const clip of pack.clips) {
      exports.push({ clip_id: clip.clip_id, task_id: await exportClip(supabase, clip.clip_id, resolution) });
    }
    return rpcOrThrow(supabase, "cmo_decide_video_pack", { p_id: id, p_action: "approved", p_exports: exports, p_reason: null });
  },
);
