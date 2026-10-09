import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { clipContext } from "@/lib/api/clips";
import { notFound, rpcOrThrow, withApi, type SupabaseClient } from "@/lib/api/handler";
import { agentChatProvider, agentProvider, availableModels, providerForModel } from "@/lib/agent/model";
import { sessionView, type SessionRow } from "@/lib/agent/view";
import { availableModels as generationModels } from "@/lib/generate/models";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/;

/** Project (job) của người dùng hiện tại, dưới RLS — 404 cho project người khác. */
async function ownJob(supabase: SupabaseClient, jobId: string): Promise<void> {
  const { data } = await supabase.from("jobs").select("id").eq("id", jobId).maybeSingle();
  if (!data) throw notFound("Project not found.");
}

/** Model được chọn: model client xin nếu server bật nó, không thì mặc định. */
function pickModel(wanted: string | null | undefined): string | null {
  const models = availableModels();
  if (wanted && models.some((model) => model.id === wanted) && providerForModel(wanted)) return wanted;
  return agentProvider()?.model ?? null;
}

type SessionListRow = { id: string; model: string; created_at: string };

/** Lịch sử chat của một clip, hoặc của CMO chat: phiên mới nhất trước, tên là câu lệnh đầu. */
async function listSessions(supabase: SupabaseClient, where: { clipId: string } | { cmo: true }) {
  let query = supabase.from("agent_sessions").select("id, model, created_at");
  query = "clipId" in where ? query.eq("clip_id", where.clipId) : query.eq("scope", "cmo");
  const { data } = await query
    .order("created_at", { ascending: false })
    .limit(30);
  const rows = (data ?? []) as SessionListRow[];
  if (!rows.length) return [];
  const { data: firsts } = await supabase
    .from("agent_turns")
    .select("session_id, prompt")
    .in("session_id", rows.map((row) => row.id))
    .eq("number", 1);
  const titles = new Map(((firsts ?? []) as { session_id: string; prompt: string }[]).map((row) => [row.session_id, row.prompt]));
  return rows
    .filter((row) => titles.has(row.id))
    .map((row) => ({ id: row.id, model: row.model, created_at: row.created_at, title: titles.get(row.id)!.slice(0, 80) }));
}

/**
 * Phiên Assistant của một clip (`?clip_id=`, editor) hoặc của cả project
 * (`?job_id=`, trang project), ở hình dạng panel vẽ được. Phiên gắn với
 * model: `?model=` chọn model (trong số server bật), `?session_id=` mở một
 * phiên cũ trong lịch sử. `available: false` khi server chưa có khoá API —
 * panel nói thẳng thay vì để người dùng gõ vào một ô không bao giờ trả lời.
 */
export const GET = withApi({}, async ({ supabase, request }) => {
  const params = new URL(request.url).searchParams;
  const clipId = params.get("clip_id");
  const jobId = params.get("job_id");
  const sessionId = params.get("session_id");
  const cmo = params.get("scope") === "cmo";
  if (cmo) {
    // Phiên CMO chat không gắn clip/project: RLS theo user_id là đủ.
  } else if (clipId !== null) {
    if (!UUID.test(clipId)) throw new ApiError(422, "clip_id: Invalid");
    await clipContext(supabase, clipId);
  } else if (jobId !== null) {
    if (!UUID.test(jobId)) throw new ApiError(422, "job_id: Invalid");
    await ownJob(supabase, jobId);
  } else {
    throw new ApiError(422, "clip_id, job_id or scope: Required");
  }
  if (sessionId !== null && !UUID.test(sessionId)) throw new ApiError(422, "session_id: Invalid");

  const model = pickModel(params.get("model"));
  let query = supabase.from("agent_sessions").select("id, clip_id, job_id, model, lock_until");
  query = cmo ? query.eq("scope", "cmo") : clipId !== null ? query.eq("clip_id", clipId) : query.eq("job_id", jobId!);
  if (sessionId) query = query.eq("id", sessionId);
  // Phiên của model đang chọn: phiên của model khác không chạy tiếp được.
  else if (model) query = query.eq("model", model);
  const { data } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
  const session = data as SessionRow | null;
  return {
    available: model !== null,
    provider: model ? (providerForModel(model)?.kind ?? null) : null,
    model: session?.model ?? model,
    models: availableModels(),
    // Gợi ý "Generate B-roll" chỉ hiện khi máy chủ bật model ảnh/video (không gợi ý thứ luôn hỏng).
    broll: generationModels().some((item) => (item.kind === "image" || item.kind === "video") && !item.limits.scene),
    sessions: cmo ? await listSessions(supabase, { cmo: true }) : clipId !== null ? await listSessions(supabase, { clipId }) : [],
    session: session ? await sessionView(supabase, session) : null,
  };
});

const body = z.union([
  z.object({ clip_id: z.string().uuid(), model: z.string().max(64).optional(), new: z.boolean().optional() }),
  z.object({ job_id: z.string().uuid() }),
  z.object({ scope: z.literal("cmo"), new: z.boolean().optional() }),
]);

/** Mở (hoặc trả lại) phiên của clip này — `new` là "New chat" —, của cả project, hoặc CMO chat (`scope: "cmo"`). */
export const POST = withApi({ body }, async ({ supabase, body }) => {
  let session: SessionRow;
  if ("clip_id" in body) {
    const model = pickModel(body.model);
    if (!model) throw new ApiError(503, "The assistant is not available yet.");
    await clipContext(supabase, body.clip_id);
    session = await rpcOrThrow<SessionRow>(supabase, body.new ? "agent_new_session" : "agent_open_session", {
      p_clip_id: body.clip_id,
      p_model: model,
    });
  } else if ("scope" in body) {
    const provider = agentChatProvider("cmo");
    if (!provider) throw new ApiError(503, "Your CMO is not available yet.");
    session = await rpcOrThrow<SessionRow>(supabase, "agent_open_cmo_session", { p_model: provider.model, p_new: body.new ?? false });
  } else {
    const provider = agentProvider();
    if (!provider) throw new ApiError(503, "The assistant is not available yet.");
    await ownJob(supabase, body.job_id);
    session = await rpcOrThrow<SessionRow>(supabase, "agent_open_project_session", { p_job_id: body.job_id, p_model: provider.model });
  }
  return sessionView(supabase, session);
});
