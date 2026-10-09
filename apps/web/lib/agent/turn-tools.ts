import "server-only";

/**
 * Hai tool của phiên clip cần biết lượt người dùng (học Palmier `undo`, `send_feedback`):
 *
 * - `undo`: đưa clip về checkpoint chụp trước lượt ghi ĐẦU TIÊN của yêu cầu này — mọi
 *   thay đổi agent làm trong yêu cầu đang chạy, không đụng yêu cầu trước. Checkpoint
 *   giữ nguyên, nên nút Undo của lượt vẫn đúng.
 * - `send_feedback`: báo đội sản phẩm một giới hạn hay lỗi, ghi qua RPC `send_feedback`.
 */

import { canonicalJson } from "@opencmo/clip-doc";
import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import { readEditorProject } from "@/lib/editor/apply";
import { projectDocument, saveDocument } from "@/lib/editor/document";

import { spec, type ToolOutcome } from "./tools";

const undoInput = z.object({});
const exportsInput = z.object({
  action: z.enum(["list", "cancel"]),
  export_id: z.string().uuid().optional().describe("Required for cancel: an id from action=list."),
});
const feedbackInput = z.object({
  category: z.enum(["missing_capability", "wrong_result", "confusing_ux", "failure", "suggestion"]).describe("What kind of problem this is."),
  summary: z.string().trim().min(1).max(300).describe("One-line paraphrased summary in English. Becomes the report's subject."),
  details: z.string().trim().max(4000).optional().describe("Paraphrased: what the user was trying to do and what was missing or went wrong. No verbatim user text, no personal data."),
  severity: z.enum(["low", "medium", "high"]).optional().describe("How much this blocked the user."),
});

export const TURN_TOOL_SPECS = [
  spec(
    "undo",
    "Undo every change you made to the clip in THIS request (back to how it was before your first edit of the request). Earlier requests are not touched. Use it when your edits went the wrong way and starting over is cleaner than reversing them one by one. Re-read get_project_state afterwards: ids of elements you added are gone.",
    undoInput,
  ),
  spec(
    "manage_exports",
    "List or cancel this clip's exports. action=list returns them newest first with id, status (queued, running, done, failed, cancelled), progress and size. action=cancel stops one that is queued or running — only when the user asks, or to undo an export you just started by mistake.",
    exportsInput,
  ),
  spec(
    "send_feedback",
    "Report a limitation or bug of this editor to the OpenCMO team so they can improve it: a capability or tool is missing, a result is clearly off, or the user hits a rough edge. It sends directly with no confirmation, so PARAPHRASE in English: never copy the user's words, file names or personal details. Tell the user you sent it.",
    feedbackInput,
  ),
];

export const TURN_TOOLS = new Set(TURN_TOOL_SPECS.map((tool) => tool.name));

type Env = { supabase: SupabaseClient; clipId: string; turnId: string };

export async function runTurnTool(name: string, input: unknown, env: Env): Promise<ToolOutcome> {
  try {
    if (name === "undo") return await undoTurn(env);
    if (name === "manage_exports") return await manageExports(input, env);
    const parsed = feedbackInput.safeParse(input ?? {});
    if (!parsed.success) {
      return { ok: false, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues[0]?.message ?? "Invalid input." }), summary: "Could not send feedback" };
    }
    await rpcOrThrow(env.supabase, "send_feedback", {
      p_category: parsed.data.category,
      p_summary: parsed.data.summary,
      p_details: parsed.data.details ?? null,
      p_severity: parsed.data.severity ?? null,
      p_clip_id: env.clipId,
    });
    return { ok: true, content: JSON.stringify({ ok: true, sent: true }), summary: "Sent feedback to the OpenCMO team" };
  } catch (err) {
    const message = err instanceof ApiError && err.status < 500 ? err.message : "This could not be done.";
    if (!(err instanceof ApiError)) console.error(`[agent] ${name} lỗi`, err);
    return { ok: false, content: JSON.stringify({ error: message }), summary: message };
  }
}

async function undoTurn({ supabase, clipId, turnId }: Env): Promise<ToolOutcome> {
  const { data: turn } = await supabase.from("agent_turns").select("checkpoint_id").eq("id", turnId).maybeSingle();
  const checkpointId = (turn as { checkpoint_id: string | null } | null)?.checkpoint_id ?? null;
  if (!checkpointId) {
    return { ok: true, content: JSON.stringify({ ok: true, changed: false, message: "You have not changed the clip in this request yet." }), summary: "Nothing to undo" };
  }
  const { data: revision } = await supabase.from("editor_revisions").select("document").eq("id", checkpointId).maybeSingle();
  if (!revision) return { ok: false, content: JSON.stringify({ error: "The version from before this request is no longer available." }), summary: "Could not undo" };
  const document = projectDocument(revision as { document: unknown });
  const project = await readEditorProject(supabase, clipId);
  if (canonicalJson(project.document) === canonicalJson(document)) {
    return { ok: true, content: JSON.stringify({ ok: true, changed: false, message: "The clip is already as it was before this request." }), summary: "Nothing to undo" };
  }
  const saved = await saveDocument(supabase, clipId, project.version, document);
  return {
    ok: true,
    content: JSON.stringify({ ok: true, changed: true, version: saved.version, message: "Back to how the clip was before this request." }),
    summary: "Undid this request's changes",
    version: saved.version,
  };
}

async function manageExports(input: unknown, { supabase, clipId }: Env): Promise<ToolOutcome> {
  const parsed = exportsInput.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues[0]?.message ?? "Invalid input." }), summary: "Could not read exports" };
  if (parsed.data.action === "cancel") {
    if (!parsed.data.export_id) return { ok: false, content: JSON.stringify({ INVALID_INPUT: "Pass export_id from action=list." }), summary: "Could not cancel" };
    const { data: owned } = await supabase.from("tasks").select("id").eq("id", parsed.data.export_id).eq("clip_id", clipId).maybeSingle();
    if (!owned) return { ok: false, content: JSON.stringify({ error: "That export is not one of this clip's." }), summary: "Export not found" };
    const task = await rpcOrThrow<{ status: string }>(supabase, "cancel_export", { p_task_id: parsed.data.export_id });
    return { ok: true, content: JSON.stringify({ ok: true, status: task.status }), summary: "Cancelled the export" };
  }
  const { data } = await supabase
    .from("tasks")
    .select("id, status, progress, bytes, width, height, error, created_at, finished_at")
    .eq("clip_id", clipId)
    .eq("kind", "render_document")
    .order("created_at", { ascending: false })
    .limit(20);
  const exports = ((data ?? []) as Record<string, unknown>[]).map((row) =>
    Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)),
  );
  return { ok: true, content: JSON.stringify({ exports }), summary: exports.length ? `Read ${exports.length} ${exports.length === 1 ? "export" : "exports"}` : "No exports yet" };
}
