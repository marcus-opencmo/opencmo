/**
 * Version history over MCP (editor-MCP plan, item 1): MCP has no `undo`, so without these a bad edit could
 * only be reverted by the user in the editor's Version history.
 *
 * - `list_versions`: the checkpoints of a clip (`editor_revisions`, immutable), newest first, and
 *   whether the engine's original exists. No documents in the list, like the editor's dialog.
 * - `restore_version`: the same thing the editor's Restore does, a normal save of the old
 *   document behind the optimistic lock (`save_editor_document`). A checkpoint of the current
 *   document is taken first, so a restore can itself be restored.
 *
 * Everything runs under the user's RLS: someone else's clip or version reads as not found.
 */

import { canonicalJson, DocumentInvalidError, validate, type ClipDocument } from "@opencmo/clip-doc";
import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import { saveDocument } from "@/lib/editor/document";

export const listVersionsInput = z.object({ clip_id: z.string().uuid().describe("The clip (from list_clips).") });
export const restoreVersionInput = z.object({
  clip_id: z.string().uuid(),
  version: z.union([z.literal("original"), z.string().uuid()]).describe('A version id from list_versions, or "original" for the edit as the engine made it.'),
});

type RevisionRow = { id: string; number: number; kind: "export" | "agent" | "manual"; label: string | null; created_at: string };
type ProjectRow = { clip_id: string; version: number; document: unknown; generated_document: unknown };

export type VersionsAnswer = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

const NOT_FOUND = "That clip was not found. Use list_clips to find its id.";

async function project(supabase: SupabaseClient, clipId: string): Promise<ProjectRow | null> {
  const { data } = await supabase.from("editor_projects").select("clip_id, version, document, generated_document").eq("clip_id", clipId).maybeSingle();
  return (data as ProjectRow | null) ?? null;
}

export async function listVersions(supabase: SupabaseClient, clipId: string): Promise<VersionsAnswer> {
  const [current, { data }] = await Promise.all([
    project(supabase, clipId),
    supabase.from("editor_revisions").select("id, number, kind, label, created_at").eq("clip_id", clipId).order("number", { ascending: false }).limit(50),
  ]);
  if (!current) return { ok: false, message: NOT_FOUND };
  const versions = ((data ?? []) as RevisionRow[]).map((row) => ({ id: row.id, number: row.number, kind: row.kind, label: row.label, created_at: row.created_at }));
  return { ok: true, value: { original: current.generated_document != null, versions, message: `${versions.length} saved ${versions.length === 1 ? "version" : "versions"}. Restore one with restore_version; the current edit is kept as a version first.` } };
}

export async function restoreVersion(supabase: SupabaseClient, clipId: string, version: string): Promise<VersionsAnswer> {
  const current = await project(supabase, clipId);
  if (!current) return { ok: false, message: NOT_FOUND };
  let document: unknown;
  let label: string;
  if (version === "original") {
    if (current.generated_document == null) return { ok: false, message: "This edit has no original version to go back to." };
    document = current.generated_document;
    label = "the original";
  } else {
    const { data } = await supabase.from("editor_revisions").select("id, number, document").eq("clip_id", clipId).eq("id", version).maybeSingle();
    const row = data as { id: string; number: number; document: unknown } | null;
    if (!row) return { ok: false, message: "That version is no longer available. Use list_versions to see the ones there are." };
    document = row.document;
    label = `version ${row.number}`;
  }
  // Validated before anything is written: a version this editor can no longer read leaves no trace.
  let restored: ClipDocument;
  try {
    restored = validate(document);
  } catch (err) {
    if (err instanceof DocumentInvalidError) return { ok: false, message: `${label[0]!.toUpperCase()}${label.slice(1)} was saved by an older editor and cannot be restored. Pick another version.` };
    throw err;
  }
  if (canonicalJson(restored) === canonicalJson(current.document)) {
    return { ok: true, value: { restored: label, version: current.version, kept_as: null, unchanged: true, message: `The edit already matches ${label}; nothing changed.` } };
  }
  // Keep what is there now, so this restore can be undone the same way.
  // Tied to the version read above: an edit saved since refuses here, before a checkpoint for a
  // restore that will not happen lands in Version history.
  let checkpoint: RevisionRow;
  let saved;
  try {
    checkpoint = await rpcOrThrow<RevisionRow>(supabase, "checkpoint_editor_project", {
      p_clip_id: clipId,
      p_kind: "agent",
      p_label: `MCP: before restoring ${label}`,
      p_expected_version: current.version,
    });
    saved = await saveDocument(supabase, clipId, current.version, restored);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      return { ok: false, message: "The edit changed while restoring (the editor or the Assistant saved it). Call list_versions and restore again." };
    }
    throw err;
  }
  return {
    ok: true,
    value: { restored: label, version: saved.version, kept_as: checkpoint?.id ?? null, message: `Restored ${label}. The edit before it is kept as a version.` },
  };
}
