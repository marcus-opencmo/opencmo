/**
 * Export của editor ở MỘT chỗ: nút Export (`/editor/revision` + `/clips/[id]/exports`)
 * và tool `request_export` của Assistant đi cùng đường, nên agent không thể xuất
 * ra thứ nút Export không xuất được (hay vượt hạn mức gói).
 *
 * Hai bước, như trước: chụp revision bất biến (đối chiếu vân tay của bản đang
 * thấy), rồi xếp task `render_document` trỏ vào revision đó.
 */

import { normalizeManifest } from "@opencmo/clip-assets";
import { validate, type ClipDocument } from "@opencmo/clip-doc";
import { applyOps, OpError, readFrame } from "@opencmo/editor-core";

import type { ClipContext } from "@/lib/api/clips";
import { ApiError } from "@/lib/api/errors";
import { firstRow, rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import type { TaskRow } from "@/lib/api/shapes";
import { readEditorProject, serverMedia, serverOpContext } from "@/lib/editor/apply";
import { wakeWorker } from "@/lib/modal";
import { planById } from "@/lib/pricing";

/** Khung theo nền tảng (học Palmier §C4): Reels/TikTok/Shorts 9:16, feed 4:5 và 1:1, YouTube 16:9. */
export const EXPORT_FRAMES = {
  "9:16": { width: 1080, height: 1920 },
  "4:5": { width: 1080, height: 1350 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
} as const;
export type ExportFrame = keyof typeof EXPORT_FRAMES;
export const EXPORT_FRAME_NAMES = Object.keys(EXPORT_FRAMES) as [ExportFrame, ...ExportFrame[]];

/** Khung hiện tại của document theo tên nền tảng; khung lạ (tự đặt) thì null. */
export function frameName(document: ClipDocument): ExportFrame | null {
  const current = readFrame(document);
  if (!current) return null;
  return EXPORT_FRAME_NAMES.find((name) => EXPORT_FRAMES[name].width === current.width && EXPORT_FRAMES[name].height === current.height) ?? null;
}

/**
 * Chụp project thành revision export. `frame` khác khung hiện tại: đổi khung
 * (`set_frame`, cùng bám mặt và dựng lại bố cục như trong editor) trên BẢN SAO
 * rồi chụp bản sao — project người dùng đang sửa không đổi.
 */
export async function snapshotForExport(
  supabase: SupabaseClient,
  context: ClipContext,
  clipId: string,
  documentHash: string,
  frame?: ExportFrame,
): Promise<{ id: string }> {
  const params = { p_clip_id: clipId, p_document_hash: documentHash };
  if (!frame) return rpcOrThrow(supabase, "snapshot_editor_revision", params);

  const project = await readEditorProject(supabase, clipId);
  if (project.document_hash !== documentHash) {
    throw new ApiError(409, "This project changed while it was being exported. Try again.");
  }
  if (frameName(project.document) === frame) return rpcOrThrow(supabase, "snapshot_editor_revision", params);
  const target = EXPORT_FRAMES[frame];
  const manifest = normalizeManifest(project.manifest);
  const media = await serverMedia(supabase, context, clipId, project.document, manifest);
  let variant;
  try {
    variant = (await applyOps(project.document, [{ op: "set_frame", ...target }], serverOpContext(supabase, context, clipId, media))).document;
    validate(variant);
  } catch (err) {
    if (err instanceof OpError) throw new ApiError(422, err.message);
    throw err;
  }
  return rpcOrThrow(supabase, "snapshot_editor_variant", { ...params, p_document: variant, p_label: frame });
}

/** Gói của người dùng: độ phân giải bản xuất và số lượt export mỗi ngày. */
export async function exportPlan(supabase: SupabaseClient, userId: string) {
  const { data: profile, error } = await supabase.from("profiles").select("plan").eq("id", userId).maybeSingle<{ plan: string }>();
  if (error) throw new ApiError(500, "Could not read your export plan. Please try again.");
  const plan = planById(profile?.plan ?? "free") ?? planById("free");
  if (!plan) throw new ApiError(500, "Could not read your export plan. Please try again.");
  return { name: plan.name, resolution: plan.maxExportResolution, perDay: plan.exportsPerDay };
}

/** Xếp task `render_document` cho một revision đã chụp, rồi đánh thức worker. */
export async function startDocumentExport(
  supabase: SupabaseClient,
  clipId: string,
  revisionId: string,
  requestId: string,
  resolution: 720 | 1080,
): Promise<TaskRow> {
  const task = firstRow(
    await rpcOrThrow<TaskRow | TaskRow[]>(supabase, "request_document_export", {
      p_clip_id: clipId,
      p_revision_id: revisionId,
      p_request_id: requestId,
      p_resolution: resolution,
    }),
  );
  if (!task) throw new ApiError(500, "Could not start the export. Please try again.");
  await wakeWorker({ task_id: task.id });
  return task;
}
