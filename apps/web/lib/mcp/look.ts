/**
 * Look and listen over MCP (editor-MCP plan, item 1): the bodies of capture_frame, inspect_color, media_grab
 * and media_waveform. In the app these run in the user's browser; over MCP there is no browser, so
 * the clip is drawn on the worker by the export's own renderer (`opencmo/worker/look.py` →
 * `clip-export look`).
 *
 * The document and the library manifest are read here under the user's RLS (the same read the
 * studio tools make), then posted to the worker's `look` endpoint with `OPENCMO_LOOK_TOKEN`. Not the
 * worker token: the MCP container faces the internet and must not hold it (`deploy_env.py`
 * FORBIDDEN). The worker checks the clip belongs to that user again before it fetches a byte.
 *
 * Free for the user, but each call costs us worker time: capped per user per hour (`mcp_look`).
 *
 * UNTESTED against a deployed worker (2026-10-20): the endpoint `modal_app.look` needs O4's
 * `modal deploy modal_app.py` and the `OPENCMO_LOOK_URL` / `OPENCMO_LOOK_TOKEN` secrets. The worker
 * side is covered by `tests/test_worker_look.py` and `clip-export/src/look.test.ts`, this file by
 * `packages/mcp-server/src/server.check.ts` (not set up → a clear error, never a hang).
 */

import { z } from "zod";

import { clipContext, type ClipContext } from "@/lib/api/clips";
import type { SupabaseClient } from "@/lib/api/handler";
import { ensureProject, type EditorProject } from "@/lib/editor/project";

/** At most this many frames per call, like the in-app `capture`. */
export const MAX_LOOK_TIMES = 12;
export const LOOK_LIMIT = 60;
/** Under Modal's 150 s cut for web endpoints; a call decodes at most 12 frames. */
const LOOK_TIMEOUT_MS = 120_000;

export const NOT_SET_UP = "Looking at frames is not set up on this server yet. Give the user open_in_editor's link instead.";
const FAILED = "Could not draw the frames. Try again in a minute.";

const seconds = z.number().min(0);
export const captureFrameInput = z.object({
  clip_id: z.string().uuid().describe("The clip to look at (from list_clips)."),
  times: z.array(seconds).max(MAX_LOOK_TIMES).optional().describe("Clip-timeline seconds to draw, up to 12."),
  start: seconds.optional().describe("With count: spread frames from here (clip seconds)."),
  end: seconds.optional().describe("With count: spread frames up to here (clip seconds)."),
  count: z.number().int().min(1).max(MAX_LOOK_TIMES).optional().describe("How many evenly spread frames when times is not given (default 6)."),
  grid: z.boolean().optional().describe("Draw the 0.25/0.5/0.75 guides (default true)."),
});
export const inspectColorInput = z.object({
  clip_id: z.string().uuid(),
  time: seconds.optional().describe("Clip-timeline second to measure (default 0)."),
  element_id: z.string().max(200).optional().describe("Measure only this layer's box (an id from capture_frame's layers)."),
});
export const mediaGrabInput = z.object({
  clip_id: z.string().uuid(),
  path: z.string().min(1).max(500).describe("The library path of a video or image in this project (list_library)."),
  times: z.array(seconds).max(MAX_LOOK_TIMES).optional().describe("Seconds of the file to show."),
  count: z.number().int().min(1).max(MAX_LOOK_TIMES).optional(),
});
export const mediaWaveformInput = z.object({
  clip_id: z.string().uuid(),
  path: z.string().min(1).max(500).optional().describe("A library file; default: the clip's own video (SOURCE seconds, as in get_transcript)."),
  start: seconds.optional(),
  end: seconds.optional(),
  threshold_db: z.number().min(-90).max(0).optional().describe("Quieter than this is silence (default -35)."),
  min_silence: z.number().min(0.05).max(10).optional().describe("Shortest silence to list, seconds (default 0.4)."),
});

export type LookOp = "capture" | "inspect_color" | "frame" | "grab" | "waveform";
export type LookAnswer = { images: string[]; data: Record<string, unknown> } | { error: string };

/** The clip's context and project, read under the user's RLS before the worker is asked. */
export type LookedAt = { context: ClipContext; project: EditorProject };

/** The worker's answer, or an error sentence. Throws only on a programming error. */
export async function requestLook(
  supabase: SupabaseClient,
  userId: string,
  op: LookOp,
  input: { clip_id: string } & Record<string, unknown>,
): Promise<LookAnswer> {
  return (await lookAt(supabase, userId, op, input)).answer;
}

/** `requestLook` that also hands back the clip and project it read, for a caller that writes next. */
export async function lookAt(
  supabase: SupabaseClient,
  userId: string,
  op: LookOp,
  input: { clip_id: string } & Record<string, unknown>,
): Promise<{ answer: LookAnswer; seen?: LookedAt }> {
  const url = process.env.OPENCMO_LOOK_URL;
  const token = process.env.OPENCMO_LOOK_TOKEN;
  if (!url || !token) return { answer: { error: NOT_SET_UP } };

  const { clip_id, ...params } = input;
  let context: ClipContext;
  try {
    context = await clipContext(supabase, clip_id);
  } catch {
    return { answer: { error: "That clip was not found. Use list_clips to find its id." } };
  }

  // Counted once the clip is the caller's (a wrong id does not spend the hour's looks), and before
  // `ensureProject`, which can write a project row: a refused look does no work.
  const { data: allowed, error: limited } = await supabase.rpc("rate_limit_hit", { p_bucket: "mcp_look", p_limit: LOOK_LIMIT, p_window_seconds: 3600 });
  if (limited) {
    console.error("[mcp] look rate limit", limited.message);
    return { answer: { error: FAILED } };
  }
  if (allowed === false) return { answer: { error: `You can look at frames ${LOOK_LIMIT} times an hour. Try again later, or give the user open_in_editor's link.` } };

  let seen: LookedAt;
  try {
    seen = { context, project: await ensureProject(supabase, context, clip_id) };
  } catch {
    return { answer: { error: "That clip was not found. Use list_clips to find its id." } };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, user_id: userId, clip_id, op, input: params, document: seen.project.document, manifest: seen.project.manifest ?? null }),
      signal: AbortSignal.timeout(LOOK_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[mcp] look unreachable", error);
    return { answer: { error: FAILED } };
  }
  if (!res.ok) {
    console.error("[mcp] look", res.status, (await res.text()).slice(0, 500));
    return { answer: { error: FAILED } };
  }
  let body: LookAnswer;
  try {
    body = (await res.json()) as LookAnswer;
  } catch (error) {
    // A gateway or cold-start page can answer 200 with HTML.
    console.error("[mcp] look answered without JSON", error);
    return { answer: { error: FAILED } };
  }
  if (!body || typeof body !== "object") return { answer: { error: FAILED } };
  if ("error" in body) return { answer: { error: String(body.error) } };
  if (!Array.isArray(body.images)) return { answer: { error: FAILED } };
  return { answer: body, seen };
}
