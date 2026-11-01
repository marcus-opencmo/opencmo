/**
 * `renderShort` (P2 B3): a short's own edit rendered by the existing `render_document` queue, from a
 * brain order, with no editor open. It runs under the owner's short-lived user JWT
 * (`lib/mcp/auth.ts` `clientFor`), so the export RPCs check ownership, the in-flight cap and the
 * plan's resolution exactly as for the Export button; the service role never touches the edit.
 */

import { createHash } from "node:crypto";

import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow } from "@/lib/api/handler";
import { readEditorProject } from "@/lib/editor/apply";
import { exportPlan, startDocumentExport } from "@/lib/editor/export";

import type { RenderedShort, StudioContext } from "./types";

/**
 * One request per edit and document: a retried order step gets the task already queued (the
 * revision snapshot is reused for the same hash), never a second render.
 */
export function renderRequestId(clipId: string, documentHash: string): string {
  return requestIdFrom("render_edit", clipId, documentHash);
}

/** A stable request id (UUID-shaped, version 5 bits) for one kind of render of one document. */
export function requestIdFrom(namespace: string, clipId: string, documentHash: string): string {
  const hex = createHash("sha256").update(`${namespace}:${clipId}:${documentHash}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The edit as it is saved now, through the Export button's queue; returns the `render_document` task id. */
export async function renderEdit(ctx: StudioContext, clipId: string): Promise<string> {
  const project = await readEditorProject(ctx.supabase, clipId);
  const revision = await rpcOrThrow<{ id: string }>(ctx.supabase, "snapshot_editor_revision", { p_clip_id: clipId, p_document_hash: project.document_hash });
  const { resolution } = await exportPlan(ctx.supabase, ctx.userId);
  const task = await startDocumentExport(ctx.supabase, clipId, revision.id, renderRequestId(clipId, project.document_hash), resolution);
  return task.id;
}

export async function renderShort(ctx: StudioContext, shortClipId: string): Promise<RenderedShort> {
  const { data: clip, error } = await ctx.supabase.from("clips").select("kind").eq("id", shortClipId).maybeSingle<{ kind: string }>();
  if (error) throw new Error(`clips read: ${error.message}`);
  if (!clip) return { kind: "refused", message: "This short no longer exists." };
  if (clip.kind !== "short") return { kind: "refused", message: "Only a short is rendered this way." };
  try {
    return { kind: "queued", taskId: await renderEdit(ctx, shortClipId) };
  } catch (err) {
    // A refusal the founder can act on (daily limit, 20 in flight, a changed edit) goes to the order.
    if (err instanceof ApiError && err.status < 500) return { kind: "refused", message: err.message };
    throw err;
  }
}
