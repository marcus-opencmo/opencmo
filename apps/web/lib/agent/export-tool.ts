/**
 * Tool `request_export` của Assistant trong editor (review Palmier lần 2, D2):
 * agent xuất MP4 để người dùng tải về, kèm bản theo khung nền tảng khác.
 *
 * Luôn qua THẺ DUYỆT: export không tốn credit nhưng ăn vào số lượt export mỗi
 * ngày của gói, và tạo ra file người dùng sẽ đăng — họ phải thấy khung nào, độ
 * phân giải nào trước khi bấm. Vân tay document ghim lúc báo giá: thứ được
 * xuất đúng là thứ đã duyệt; sửa thêm sau đó thì export từ chối và agent hỏi lại.
 *
 * Chạy cùng đường với nút Export (`lib/editor/export.ts`).
 */

import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { ClipContext } from "@/lib/api/clips";
import { ApiError } from "@/lib/api/errors";
import type { SupabaseClient } from "@/lib/api/handler";
import { readEditorProject } from "@/lib/editor/apply";
import { EXPORT_FRAME_NAMES, exportPlan, frameName, snapshotForExport, startDocumentExport, type ExportFrame } from "@/lib/editor/export";

import { spec, type ToolOutcome, type ToolSpec } from "./tools";

export const exportInput = z.object({
  frames: z
    .array(z.enum(EXPORT_FRAME_NAMES))
    .min(1)
    .max(EXPORT_FRAME_NAMES.length)
    .optional()
    .describe("Frames to export: 9:16 (Reels, TikTok, Shorts), 4:5 and 1:1 (feeds), 16:9 (YouTube). Omit for the clip's current frame only."),
});

export const EXPORT_TOOL: ToolSpec = {
  ...spec(
    "request_export",
    "Render the clip to MP4 files the user can download, optionally also as copies in other platform frames (the user's project keeps its frame; each copy is reframed on its own copy, with face tracking, like set_frame). Only when the user asks to export, download, or get files for a platform. Run check first and fix what it reports. The user approves on a card; no credits, but each file uses one of the plan's daily exports. After approval the files render in the background and appear in the chat with a Download button.",
    exportInput,
  ),
  approval: true,
};

/** Đã báo giá: đúng các khung và đúng bản document người dùng duyệt. */
export type PreparedExport = { frames: ExportFrame[]; current: ExportFrame | null; document_hash: string };

const NAMES: Record<ExportFrame, string> = { "9:16": "9:16 (Reels, TikTok, Shorts)", "4:5": "4:5 (feed)", "1:1": "1:1 (square feed)", "16:9": "16:9 (YouTube)" };

async function userId(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new ApiError(401, "Sign in to export.");
  return data.user.id;
}

export async function prepareExport(supabase: SupabaseClient, clipId: string, input: unknown): Promise<PreparedExport | string> {
  const parsed = exportInput.safeParse(input ?? {});
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "Invalid input.";
  const project = await readEditorProject(supabase, clipId);
  const current = frameName(project.document);
  const frames = [...new Set(parsed.data.frames ?? (current ? [current] : ["9:16" as const]))];
  return { frames, current, document_hash: project.document_hash };
}

export async function exportCard(supabase: SupabaseClient, clipId: string, prepared: PreparedExport) {
  const plan = await exportPlan(supabase, await userId(supabase));
  const count = prepared.frames.length;
  return {
    clips: [{ id: clipId, label: "This clip" }],
    changes: [
      ...prepared.frames.map((frame) =>
        frame === prepared.current ? `Export ${NAMES[frame]} at ${plan.resolution}p` : `Export a ${NAMES[frame]} copy at ${plan.resolution}p. Your project stays as it is.`,
      ),
      `Uses ${count} of your ${plan.perDay} exports a day on the ${plan.name} plan. No credits.`,
    ],
    credits: 0,
  };
}

type ExportEnv = { supabase: SupabaseClient; context: ClipContext; clipId: string };

/** Người dùng đã Approve: chụp từng bản rồi xếp task, dừng ở bản lỗi đầu tiên. */
export async function runExport(env: ExportEnv, prepared: PreparedExport): Promise<ToolOutcome> {
  const { resolution } = await exportPlan(env.supabase, await userId(env.supabase));
  const started: { frame: ExportFrame; task_id: string }[] = [];
  let failure: string | null = null;
  for (const frame of prepared.frames) {
    try {
      const revision = await snapshotForExport(env.supabase, env.context, env.clipId, prepared.document_hash, frame === prepared.current ? undefined : frame);
      const task = await startDocumentExport(env.supabase, env.clipId, revision.id, randomUUID(), resolution);
      started.push({ frame, task_id: task.id });
    } catch (err) {
      if (!(err instanceof ApiError)) console.error("[agent] request_export lỗi", err);
      failure = err instanceof ApiError && err.status < 500 ? err.message : "Could not start the export. Please try again.";
      break;
    }
  }
  const view = started.length ? { exports: started } : undefined;
  if (!started.length) return { ok: false, content: JSON.stringify({ error: failure }), summary: failure ?? "Could not start the export" };
  const names = started.map((item) => item.frame).join(", ");
  return {
    ok: true,
    content: JSON.stringify({
      ok: true,
      started: started.map((item) => item.frame),
      ...(failure ? { not_started: prepared.frames.slice(started.length), error: failure } : {}),
      note: "The files are rendering. Each shows in the chat with a Download button when ready; the user does not need to do anything else.",
    }),
    summary: failure ? `Exporting ${names}. ${failure}` : `Exporting ${names}`,
    ...(view ? { view } : {}),
  };
}
