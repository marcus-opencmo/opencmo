/**
 * Page captures for proof B-roll (docs/style-skills-build.md, Track C), as the web sees them.
 *
 * `capture_create` (RPC) checks the address, the 24 h cache and the 30-a-day cap, and queues a
 * `capture_page` task; the worker captures the page in a sandbox with no secrets and stores
 * `page.png` + `page.boxes.json` in the private `captures` bucket. Everything here reads under the
 * user's RLS: a capture id from a document or a tool call is never trusted to be the caller's.
 */

import { z } from "zod";

import type { ProofCapture } from "@opencmo/editor-core";

import { rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import { wakeWorker } from "@/lib/modal";
import { signedObjectUrl } from "@/lib/storage";

export const CAPTURES_BUCKET = "captures";

export type CaptureStatus = "pending" | "ready" | "failed";

export type CaptureRow = {
  id: string;
  url: string;
  status: CaptureStatus;
  error: string | null;
  title: string | null;
  width: number | null;
  height: number | null;
  image_path: string | null;
  boxes_path: string | null;
  task_id: string | null;
  created_at: string;
};

const COLUMNS = "id, url, status, error, title, width, height, image_path, boxes_path, task_id, created_at";

/** One word of the captured page and where it sits, in CSS pixels of the page. */
export const CaptureRunSchema = z.object({
  text: z.string().max(2000),
  rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});

/** `page.boxes.json` as the worker writes it (opencmo/capture/page.py). */
export const CaptureBoxesSchema = z.object({
  url: z.string().max(4096),
  title: z.string().max(300),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scale: z.number().positive(),
  runs: z.array(CaptureRunSchema).max(20_000),
});
export type CaptureBoxes = z.infer<typeof CaptureBoxesSchema>;

export const captureIdSchema = z.string().uuid();

/**
 * Asks for a capture and wakes the worker, so the page is ready in seconds rather than at the
 * next sweep. The RPC's refusals (address not allowed, daily limit) reach the user verbatim.
 */
export async function createCapture(supabase: SupabaseClient, url: string): Promise<{ capture_id: string; status: CaptureStatus }> {
  const id = await rpcOrThrow<string>(supabase, "capture_create", { p_url: url });
  const row = await readCapture(supabase, id);
  if (row?.status === "pending" && row.task_id) await wakeWorker({ task_id: row.task_id });
  return { capture_id: id, status: row?.status ?? "pending" };
}

/** This user's capture by id, or null (another user's capture reads as missing). */
export async function readCapture(supabase: SupabaseClient, id: string): Promise<CaptureRow | null> {
  if (!captureIdSchema.safeParse(id).success) return null;
  const { data, error } = await supabase.from("page_captures").select(COLUMNS).eq("id", id).maybeSingle();
  if (error || !data) return null;
  return data as CaptureRow;
}

/** Signed links to a ready capture's files, signed with the user's own session (RLS of the bucket). */
export async function captureUrls(row: CaptureRow): Promise<{ image_url: string; boxes_url: string } | null> {
  if (row.status !== "ready" || !row.image_path || !row.boxes_path) return null;
  const [image_url, boxes_url] = await Promise.all([
    signedObjectUrl(CAPTURES_BUCKET, row.image_path),
    signedObjectUrl(CAPTURES_BUCKET, row.boxes_path),
  ]);
  return { image_url, boxes_url };
}

/** The word boxes of a ready capture; null when they cannot be read or are not what the worker writes. */
export async function readCaptureBoxes(row: CaptureRow): Promise<CaptureBoxes | null> {
  if (row.status !== "ready" || !row.boxes_path) return null;
  try {
    const response = await fetch(await signedObjectUrl(CAPTURES_BUCKET, row.boxes_path), { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const parsed = CaptureBoxesSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * What `add_proof` reads (`ProofContext.proofCapture`): status, and once ready the page size and its
 * word boxes. A ready capture whose boxes cannot be read counts as failed, never as empty.
 */
export async function readProofCapture(supabase: SupabaseClient, id: string): Promise<ProofCapture | null> {
  const row = await readCapture(supabase, id);
  if (!row) return null;
  if (row.status !== "ready") {
    return { status: row.status, ...(row.error ? { error: row.error } : {}), url: row.url, width: row.width ?? 1280, height: row.height ?? 1, runs: [] };
  }
  const boxes = await readCaptureBoxes(row);
  if (!boxes) return { status: "failed", error: "The captured page could not be read. Capture it again.", url: row.url, width: 1280, height: 1, runs: [] };
  return { status: "ready", url: boxes.url, width: boxes.width, height: boxes.height, runs: boxes.runs };
}
