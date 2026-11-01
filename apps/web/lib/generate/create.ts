/**
 * Tạo một generation — MỘT đường cho route `/api/v1/generations` và tool
 * `generate_media` của Assistant: kiểm spec theo catalog (lớp 1), băm JCS,
 * `create_generation` (lớp 2: giá, quyền, đặt trước credit + task cùng giao
 * dịch), đánh thức worker.
 */

import { MASTER_SRC } from "@opencmo/editor-core";
import { priceOf, specSchema, type AiModel, type GenerationSpec } from "@opencmo/editor-core/generate";

import { ApiError } from "@/lib/api/errors";
import { hitRateLimit, rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import { wakeWorker } from "@/lib/modal";

import { availableModel, loadCatalog, specHash, type GenerationRow } from "./models";
import { moderateText, specText } from "./moderation";

export type CreateRequest = {
  jobId: string;
  clipId: string | null;
  model: string;
  spec: unknown;
  requestId: string;
};

/** Spec đã qua schema của model — thứ được băm và lưu. Ném 422 tiếng Anh. */
export function normalizeSpec(model: AiModel, spec: unknown): GenerationSpec {
  const parsed = specSchema(model).safeParse(spec);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? "Invalid generation request.");
  // Trường theo khả năng model ghép bằng spread có điều kiện: zod đã kiểm, kiểu suy ra thì quá rộng.
  return parsed.data as GenerationSpec;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_KEYS = ["startImage", "endImage"] as const;

/**
 * Ảnh đầu vào gửi lên dạng id (asset media hoặc lượt sinh đã xong) → tên object trong
 * bucket `media`. Đọc DƯỚI RLS và theo đúng project: id của người khác hay project khác
 * không ra đường dẫn nào. SQL vẫn kiểm chủ sở hữu + tồn tại (`ai_media_ref_ok`).
 */
export async function resolveMediaRefs(supabase: SupabaseClient, jobId: string, spec: unknown): Promise<unknown> {
  if (!spec || typeof spec !== "object") return spec;
  const input = spec as Record<string, unknown>;
  const toPath = async (value: unknown, noun = "image"): Promise<unknown> => {
    if (typeof value !== "string" || !UUID.test(value)) return value;
    const asset = await supabase.from("media_assets").select("storage_path, status").eq("id", value).eq("job_id", jobId).maybeSingle<{ storage_path: string; status: string }>();
    // Ảnh người dùng upload còn đang probe: chưa chắc là ảnh đọc được.
    if (asset.data?.status === "pending") throw new ApiError(422, `That ${noun} is still uploading. Try again in a moment.`);
    let path = asset.data?.status === "ready" ? asset.data.storage_path : undefined;
    if (!path) {
      const generation = await supabase.from("generations").select("media_asset_id, status").eq("id", value).eq("job_id", jobId).maybeSingle<{ media_asset_id: string | null; status: string }>();
      if (generation.data && generation.data.status !== "done") throw new ApiError(422, `That ${noun} is still generating. Try again when it is ready.`);
      if (generation.data?.media_asset_id) {
        const linked = await supabase.from("media_assets").select("storage_path").eq("id", generation.data.media_asset_id).maybeSingle<{ storage_path: string }>();
        path = linked.data?.storage_path;
      }
    }
    if (!path) throw new ApiError(422, `That ${noun} was not found in your media.`);
    return path.replace(/^media\//, "");
  };
  const out: Record<string, unknown> = { ...input };
  for (const key of IMAGE_KEYS) if (key in out) out[key] = await toPath(out[key]);
  if (Array.isArray(out.references)) out.references = await Promise.all(out.references.map((ref) => toPath(ref)));
  if ("sourceVideo" in out) out.sourceVideo = await toPath(out.sourceVideo, "video");
  return out;
}

type StorageRef = { bucket?: string; object?: string };

async function clipVideoRefs(supabase: SupabaseClient, request: CreateRequest): Promise<string[]> {
  if (!request.clipId) throw new ApiError(422, "Choose a video from your media to edit.");
  const job = await supabase.from("jobs").select("media_manifest").eq("id", request.jobId).maybeSingle<{ media_manifest: unknown }>();
  const manifest = (job.data?.media_manifest ?? {}) as { masters?: Record<string, StorageRef>; proxies?: Record<string, StorageRef> };
  return [manifest.masters?.[request.clipId], manifest.proxies?.[request.clipId]]
    .filter((entry): entry is Required<StorageRef> => Boolean(entry?.bucket && entry.object))
    .map((entry) => `${entry.bucket}:${entry.object}`);
}

/**
 * The same declaration must keep the same hash, or the editor's re-POST pays again. The clip's
 * video changes under it (the proxy first, a master once rendered, a new master after a re-render),
 * so a live generation of the same model on this clip that used one of the clip's current refs and
 * whose spec matches with that ref wins: the RPC then reuses it. The hash stays the hash of the
 * stored spec, which the worker checks.
 */
async function pinClipVideo(supabase: SupabaseClient, request: CreateRequest, model: AiModel, spec: GenerationSpec, refs: string[]): Promise<GenerationSpec> {
  const live = await supabase
    .from("generations")
    .select("spec, spec_hash")
    .eq("job_id", request.jobId)
    .eq("clip_id", request.clipId!)
    .eq("model", model.id)
    .in("status", ["queued", "running", "done"])
    .returns<{ spec: { sourceVideo?: unknown } | null; spec_hash: string }[]>();
  for (const row of live.data ?? []) {
    const ref = row.spec?.sourceVideo;
    if (typeof ref !== "string" || ref === spec.sourceVideo || !refs.includes(ref)) continue;
    const pinned = { ...spec, sourceVideo: ref } as GenerationSpec;
    if (specHash(model.id, pinned) === row.spec_hash) return pinned;
  }
  return spec;
}

/** Requests that can reach the paid moderation call, per user. `create_generation` has its own cap in SQL. */
export const GENERATION_RATE_LIMIT = { bucket: "generations", limit: 120, windowSeconds: 3600 } as const;

/**
 * True when `create_generation` will hand back a generation instead of making one: the same request id
 * (a retried POST), or a live generation with this hash (the editor picking up what the Assistant
 * started). Those were paid for and moderated when they were made, so the balance, the rate limit and
 * the moderation call are skipped: a low balance must not hide media the user already paid for.
 * Read under RLS, so only the caller's own rows count. SQL decides again inside its lock.
 */
async function reusable(supabase: SupabaseClient, request: CreateRequest, hash: string): Promise<boolean> {
  const task = await supabase.from("tasks").select("id").eq("request_id", request.requestId).maybeSingle<{ id: string }>();
  if (task.error) throw task.error;
  if (task.data) return true;
  const live = await supabase
    .from("generations")
    .select("status, media_asset_id")
    .eq("job_id", request.jobId)
    .eq("spec_hash", hash)
    .in("status", ["queued", "running", "done"])
    .returns<{ status: string; media_asset_id: string | null }[]>();
  if (live.error) throw live.error;
  // A finished generation whose file was deleted is retired by the RPC, not reused.
  return (live.data ?? []).some((row) => row.status !== "done" || row.media_asset_id);
}

/**
 * The same refusal `create_generation` gives for a shot whose parent was not started, made before the
 * rate limit and moderation: the editor retries it every couple of seconds while the chain starts.
 */
async function requireParent(supabase: SupabaseClient, request: CreateRequest, spec: GenerationSpec): Promise<void> {
  const after = (spec as { after?: unknown }).after;
  if (typeof after !== "string") return;
  const parent = await supabase
    .from("generations")
    .select("id")
    .eq("job_id", request.jobId)
    .eq("spec_hash", after)
    .in("status", ["queued", "running", "done"])
    .limit(1);
  if (parent.error) throw parent.error;
  if (!parent.data?.length) throw new ApiError(422, "Start the shot before this one first.");
}

/** Same sentence as `create_generation` when the balance is short (read under RLS: the caller's own row). */
async function requireCredits(supabase: SupabaseClient, needed: number): Promise<void> {
  const { data, error } = await supabase.from("profiles").select("credit_balance").maybeSingle<{ credit_balance: number | null }>();
  if (error) throw error;
  const left = Number(data?.credit_balance ?? 0);
  if (left < needed) throw new ApiError(409, `Not enough credits: ${needed} needed, ${left} left. Top up on the Credits page.`);
}

export type PreparedCreate = { request: CreateRequest; model: AiModel; spec: GenerationSpec };

/**
 * Everything before money moves: catalog, refs, schema, the clip-video pin and text moderation.
 * Several of these can run at once (`/video`); `startGeneration` then holds credits one by one.
 */
export async function checkGeneration(supabase: SupabaseClient, request: CreateRequest): Promise<PreparedCreate> {
  await loadCatalog(supabase);
  const model = availableModel(request.model);
  if (!model) throw new ApiError(422, "This model is not available.");
  const input = (await resolveMediaRefs(supabase, request.jobId, request.spec)) as Record<string, unknown> | null;
  let spec: GenerationSpec;
  if (input && input.sourceVideo === MASTER_SRC) {
    // The document names the clip's own video `assets/master.mp4`; background removal reads it from
    // storage as `<bucket>:<object>` (master in `renders`, or the 540p proxy in `sources`). Read under
    // RLS, so another user's clip resolves to nothing. SQL checks the owner and the object again.
    const refs = await clipVideoRefs(supabase, request);
    if (!refs.length) throw new ApiError(422, "This clip has no editable source yet. Process the video again to edit it.");
    spec = await pinClipVideo(supabase, request, model, normalizeSpec(model, { ...input, sourceVideo: refs[0] }), refs);
  } else {
    spec = normalizeSpec(model, input);
  }
  if (await reusable(supabase, request, specHash(model.id, spec))) return { request, model, spec };
  await requireParent(supabase, request, spec);
  // Everything below costs us: the free refusals above come first, so a retry loop waiting on them is free.
  await hitRateLimit(supabase, GENERATION_RATE_LIMIT);
  // Moderation is a paid LLM call: an account that cannot pay for the generation never reaches it.
  await requireCredits(supabase, priceOf(model, spec));
  // Moderate the text BEFORE credits are held: a block costs nothing and creates no task.
  await moderateText(specText(spec).join("\n"), { kind: model.kind });
  return { request, model, spec };
}

export async function startGeneration(
  supabase: SupabaseClient,
  { request, model, spec }: PreparedCreate,
): Promise<{ generation: GenerationRow & { task_id?: string }; reused: boolean }> {
  const result = await rpcOrThrow<{ generation: GenerationRow & { task_id?: string }; reused: boolean }>(
    supabase,
    "create_generation",
    {
      p_job_id: request.jobId,
      p_clip_id: request.clipId,
      p_model: model.id,
      p_spec: spec,
      p_spec_hash: specHash(model.id, spec),
      p_request_id: request.requestId,
    },
  );
  if (!result.reused && result.generation.task_id) await wakeWorker({ task_id: result.generation.task_id });
  return result;
}

export async function createGeneration(
  supabase: SupabaseClient,
  request: CreateRequest,
): Promise<{ generation: GenerationRow & { task_id?: string }; reused: boolean }> {
  return startGeneration(supabase, await checkGeneration(supabase, request));
}
