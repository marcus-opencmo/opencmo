import { ApiError } from "@/lib/api/errors";
import { clipContext } from "@/lib/api/clips";
import { notFound, rpcOrThrow, withApi, type SupabaseClient } from "@/lib/api/handler";
import { canonicalJson } from "@opencmo/clip-doc";

import { EDITED_AFTER_MESSAGE, turnOpen, unchangedSince, writtenVersions, type ToolCallRow } from "@/lib/agent/undo-guard";
import { readEditorProject, type EditorProjectRow } from "@/lib/editor/apply";
import { projectDocument, saveDocument } from "@/lib/editor/document";

export const dynamic = "force-dynamic";

/** Finished tool calls of a turn, for the versions it wrote. */
async function turnCalls(supabase: SupabaseClient, turnId: string): Promise<ToolCallRow[]> {
  const { data } = await supabase.from("agent_tool_calls").select("name, result").eq("turn_id", turnId).eq("status", "done");
  return (data ?? []) as ToolCallRow[];
}

async function revisionDocument(supabase: SupabaseClient, revisionId: string) {
  const { data: revision } = await supabase
    .from("editor_revisions")
    .select("document")
    .eq("id", revisionId)
    .maybeSingle();
  if (!revision) throw notFound("That version is no longer available.");
  return projectDocument(revision as { document: unknown });
}

/**
 * Puts ONE clip back to a checkpoint. The current version is checkpointed first, so a mistaken Undo
 * can be recovered from Version history. The checkpoint's document is saved against the version
 * just read: any tab with this clip open gets a 409 on its next autosave and reloads, like after
 * any write from elsewhere.
 */
async function restoreClip(
  supabase: SupabaseClient,
  clipId: string,
  revisionId: string,
  number: number,
  check: (project: EditorProjectRow) => Promise<boolean>,
): Promise<EditorProjectRow> {
  const document = await revisionDocument(supabase, revisionId);
  const project = await readEditorProject(supabase, clipId);
  if (canonicalJson(project.document) === canonicalJson(document)) return project;
  if (!(await check(project))) throw new ApiError(409, EDITED_AFTER_MESSAGE);
  await rpcOrThrow(supabase, "checkpoint_editor_project", {
    p_clip_id: clipId,
    p_kind: "manual",
    p_label: `Before undoing assistant request ${number}`,
  });
  return saveDocument(supabase, clipId, project.version, document);
}

/**
 * Undoes one Assistant turn: puts the clip back to the checkpoint taken BEFORE the turn's first
 * write (`agent_turns.checkpoint_id`, spec §5).
 *
 * Only the newest turn not yet undone: its checkpoint predates it, so undoing an older turn would
 * also erase the turns after it. A clip the user edited after the turn is refused, not restored.
 */
export const POST = withApi({}, async ({ supabase, params }) => {
  const number = Number(params.number);
  if (!/^[0-9a-f-]{36}$/.test(params.id ?? "") || !Number.isInteger(number) || number < 1) {
    throw notFound("Assistant turn not found.");
  }

  const { data: sessionRow } = await supabase
    .from("agent_sessions")
    .select("id, clip_id")
    .eq("id", params.id)
    .maybeSingle();
  if (!sessionRow) throw notFound("Assistant session not found.");
  // Only a clip chat changes a clip; the CMO chat never takes a checkpoint.
  const clipId = (sessionRow as { clip_id: string | null }).clip_id;

  const { data: turn } = await supabase
    .from("agent_turns")
    .select("id, status, checkpoint_id")
    .eq("session_id", params.id)
    .eq("number", number)
    .maybeSingle();
  if (!turn) throw notFound("Assistant turn not found.");
  const row = turn as { id: string; status: string; checkpoint_id: string | null };
  if (turnOpen(row.status)) {
    throw new ApiError(409, "Wait for the assistant to finish before undoing.");
  }
  // Old project-chat sessions (removed with clipping) have no clip: their history is read-only.
  if (!clipId) throw new ApiError(410, "Undo is not available for project chats. Restore a version from Version history in the editor.");
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

  // The oldest newer turn that wrote (already undone, checked above): its undo is where the clip stands now.
  const { data: nextRow } = await supabase
    .from("agent_turns")
    .select("id")
    .eq("session_id", params.id)
    .gt("number", number)
    .not("checkpoint_id", "is", null)
    .order("number", { ascending: true })
    .limit(1)
    .maybeSingle();
  const next = nextRow as { id: string } | null;
  const written = writtenVersions(await turnCalls(supabase, row.id));

  await clipContext(supabase, clipId);
  const nextCheckpoint = next ? await turnCheckpoint(supabase, next.id) : undefined;
  const later = next
    ? {
        written: writtenVersions(await turnCalls(supabase, next.id)),
        checkpoint: nextCheckpoint ? () => revisionDocument(supabase, nextCheckpoint) : undefined,
      }
    : null;
  const project = await restoreClip(supabase, clipId, row.checkpoint_id, number, (current) => unchangedSince(current, written, later));
  await rpcOrThrow(supabase, "agent_mark_undone", { p_turn_id: row.id });
  return {
    project: { clip_id: project.clip_id, document: project.document, document_hash: project.document_hash, version: project.version },
  };
});

/** The checkpoint a turn took before its first write. */
async function turnCheckpoint(supabase: SupabaseClient, turnId: string): Promise<string | undefined> {
  const { data } = await supabase.from("agent_turns").select("checkpoint_id").eq("id", turnId).maybeSingle();
  return (data as { checkpoint_id: string | null } | null)?.checkpoint_id ?? undefined;
}
