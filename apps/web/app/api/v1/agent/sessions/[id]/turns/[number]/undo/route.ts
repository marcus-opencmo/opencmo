import { ApiError } from "@/lib/api/errors";
import { clipContext } from "@/lib/api/clips";
import { notFound, rpcOrThrow, withApi, type SupabaseClient } from "@/lib/api/handler";
import { canonicalJson } from "@opencmo/clip-doc";

import { readEditorProject, type EditorProjectRow } from "@/lib/editor/apply";
import { projectDocument, saveDocument } from "@/lib/editor/document";

export const dynamic = "force-dynamic";

/**
 * Đưa MỘT clip về một checkpoint. Bản hiện tại được chụp thành checkpoint
 * trước — "Undo" nhầm thì lấy lại từ Version history. Lưu document của
 * checkpoint với version vừa đọc: tab nào đang mở clip này nhận 409
 * ở lượt autosave kế tiếp và tải lại, như mọi lượt ghi từ nơi khác.
 */
async function restoreClip(supabase: SupabaseClient, clipId: string, revisionId: string, number: number): Promise<EditorProjectRow> {
  const { data: revision } = await supabase
    .from("editor_revisions")
    .select("document")
    .eq("id", revisionId)
    .maybeSingle();
  if (!revision) throw notFound("That version is no longer available.");
  const saved = revision as { document: unknown };
  const document = projectDocument(saved);
  const project = await readEditorProject(supabase, clipId);
  if (canonicalJson(project.document) === canonicalJson(document)) return project;
  await rpcOrThrow(supabase, "checkpoint_editor_project", {
    p_clip_id: clipId,
    p_kind: "manual",
    p_label: `Before undoing assistant request ${number}`,
  });
  return saveDocument(supabase, clipId, project.version, document);
}

/**
 * Undo một lượt Assistant: đưa (các) clip về checkpoint chụp TRƯỚC lượt ghi
 * đầu tiên của lượt đó trên từng clip (spec §5).
 *
 * - Phiên clip: một checkpoint, của lượt (`agent_turns.checkpoint_id`).
 * - Phiên project: checkpoint từng clip nằm trong kết quả `apply_to_clips`;
 *   clip nào được đổi nhiều lần trong lượt thì lấy checkpoint ĐẦU TIÊN.
 *
 * Chỉ lượt ghi mới nhất chưa hoàn tác: checkpoint là bản trước lượt đó, undo
 * một lượt cũ hơn là xoá luôn các lượt sau nó.
 */
export const POST = withApi({}, async ({ supabase, params }) => {
  const number = Number(params.number);
  if (!/^[0-9a-f-]{36}$/.test(params.id ?? "") || !Number.isInteger(number) || number < 1) {
    throw notFound("Assistant turn not found.");
  }

  const { data: sessionRow } = await supabase
    .from("agent_sessions")
    .select("id, clip_id, job_id")
    .eq("id", params.id)
    .maybeSingle();
  if (!sessionRow) throw notFound("Assistant session not found.");
  const session = sessionRow as { id: string; clip_id: string | null; job_id: string | null };

  const { data: turn } = await supabase
    .from("agent_turns")
    .select("id, status, checkpoint_id")
    .eq("session_id", params.id)
    .eq("number", number)
    .maybeSingle();
  if (!turn) throw notFound("Assistant turn not found.");
  const row = turn as { id: string; status: string; checkpoint_id: string | null };
  if (["running", "awaiting_browser", "awaiting_approval"].includes(row.status)) {
    throw new ApiError(409, "Wait for the assistant to finish before undoing.");
  }
  if (!row.checkpoint_id) throw new ApiError(422, "This request did not change the clip.");
  const { data: newer } = await supabase
    .from("agent_turns")
    .select("number")
    .eq("session_id", params.id)
    .gt("number", number)
    .not("checkpoint_id", "is", null)
    .is("undone_at", null)
    .limit(1);
  if (newer?.length) throw new ApiError(409, "Undo the newer requests first.");

  if (session.clip_id) {
    await clipContext(supabase, session.clip_id);
    const project = await restoreClip(supabase, session.clip_id, row.checkpoint_id, number);
    await rpcOrThrow(supabase, "agent_mark_undone", { p_turn_id: row.id });
    return {
      project: { clip_id: project.clip_id, document: project.document, document_hash: project.document_hash, version: project.version },
    };
  }

  // Phiên project: checkpoint ĐẦU TIÊN của từng clip trong lượt.
  const { data: calls } = await supabase
    .from("agent_tool_calls")
    .select("result, created_at")
    .eq("turn_id", row.id)
    .eq("name", "apply_to_clips")
    .order("created_at", { ascending: true });
  const firstCheckpoint = new Map<string, string>();
  for (const call of (calls ?? []) as { result: { clips?: { clip_id: string; checkpoint_id?: string }[] } | null }[]) {
    for (const clip of call.result?.clips ?? []) {
      if (clip.checkpoint_id && !firstCheckpoint.has(clip.clip_id)) firstCheckpoint.set(clip.clip_id, clip.checkpoint_id);
    }
  }

  const clips: { clip_id: string; ok: boolean; error?: string }[] = [];
  for (const [clipId, revisionId] of firstCheckpoint) {
    try {
      await clipContext(supabase, clipId);
      await restoreClip(supabase, clipId, revisionId, number);
      clips.push({ clip_id: clipId, ok: true });
    } catch (err) {
      clips.push({ clip_id: clipId, ok: false, error: err instanceof ApiError ? err.message : "This clip could not be restored." });
      if (!(err instanceof ApiError)) console.error("[agent] undo clip lỗi", err);
    }
  }
  if (clips.length && clips.every((clip) => !clip.ok)) {
    throw new ApiError(409, clips[0]!.error ?? "The clips could not be restored.");
  }
  await rpcOrThrow(supabase, "agent_mark_undone", { p_turn_id: row.id });
  return { clips };
});
