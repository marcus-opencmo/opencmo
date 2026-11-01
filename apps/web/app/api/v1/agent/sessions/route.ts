import { z } from "zod";
import { EXPLAINER_MODEL } from "@opencmo/editor-core";

import { ApiError } from "@/lib/api/errors";
import { clipContext } from "@/lib/api/clips";
import { rpcOrThrow, withApi, type SupabaseClient } from "@/lib/api/handler";
import { agentChatProvider, agentProvider, assistantDown, availableModels, providerForModel } from "@/lib/agent/model";
import { blankEdit, clipToolSpecs } from "@/lib/agent/scope";
import { slashCommandsFor } from "@/lib/agent/slash";
import { sessionView, type SessionRow } from "@/lib/agent/view";
import { readEditorProject } from "@/lib/editor/apply";
import { startsEmpty } from "@/lib/editor/project";
import { availableModels as generationModels } from "@/lib/generate/models";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/;

/** Model được chọn: model client xin nếu server bật nó, không thì mặc định. */
function pickModel(wanted: string | null | undefined): string | null {
  const models = availableModels();
  // A model the panel remembers is honoured unless its provider just failed to answer.
  if (wanted && !assistantDown(wanted) && models.some((model) => model.id === wanted) && providerForModel(wanted)) return wanted;
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
 * The Assistant session of a clip (`?clip_id=`, the editor) or the CMO chat (`?scope=cmo`), in the
 * shape the panel draws. A session is tied to a model: `?model=` picks one the server enables,
 * `?session_id=` opens an older session from the history. `available: false` when the server has
 * no API key, so the panel says so instead of offering a box that never answers.
 */
export const GET = withApi({}, async ({ supabase, request }) => {
  const params = new URL(request.url).searchParams;
  const clipId = params.get("clip_id");
  const sessionId = params.get("session_id");
  const cmo = params.get("scope") === "cmo";
  let blank = false;
  // The slash menu offers what this clip's Assistant can do: the tools its scope will have.
  let slash: { name: string; label: string; hint: string }[] = [];
  if (cmo) {
    // Phiên CMO chat không gắn clip/project: RLS theo user_id là đủ.
  } else if (clipId !== null) {
    if (!UUID.test(clipId)) throw new ApiError(422, "clip_id: Invalid");
    const context = await clipContext(supabase, clipId);
    blank = startsEmpty(context.clip.kind);
    // No editor document yet: nothing on the clip has a transcript, as `blankEdit` reads it.
    const document = await readEditorProject(supabase, clipId).then((project) => project.document, () => null);
    const tools = clipToolSpecs({ blank: document ? blankEdit(context, document) : blank }).map((tool) => tool.name);
    slash = slashCommandsFor(tools).map(({ name, label, hint }) => ({ name, label, hint }));
  } else {
    throw new ApiError(422, "clip_id or scope: Required");
  }
  if (sessionId !== null && !UUID.test(sessionId)) throw new ApiError(422, "session_id: Invalid");

  // A CMO chat is opened on the `cmo` agent's model (POST below), not the editor Assistant's: look it up the same way.
  const model = cmo ? (agentChatProvider("cmo")?.model ?? null) : pickModel(params.get("model"));
  let query = supabase.from("agent_sessions").select("id, clip_id, job_id, model, lock_until");
  query = cmo ? query.eq("scope", "cmo") : query.eq("clip_id", clipId!);
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
    // "Explain a concept" starts a New edit: only there, and only when explainers can render here.
    explain: blank && generationModels().some((item) => item.id === EXPLAINER_MODEL),
    slash,
    sessions: cmo ? await listSessions(supabase, { cmo: true }) : await listSessions(supabase, { clipId: clipId! }),
    session: session ? await sessionView(supabase, session) : null,
  };
});

const body = z.union([
  z.object({ clip_id: z.string().uuid(), model: z.string().max(64).optional(), new: z.boolean().optional() }),
  z.object({ scope: z.literal("cmo"), new: z.boolean().optional() }),
]);

/** Opens (or returns) this clip's session (`new` is "New chat"), or the CMO chat (`scope: "cmo"`). Project chat is gone with clipping. */
// Clip chats had no cap at all (agent_new_session counts nothing); CMO chats keep their own 30 an hour in SQL.
export const POST = withApi({ body, rateLimit: { bucket: "agent-session", limit: 60, windowSeconds: 3600 } }, async ({ supabase, body }) => {
  let session: SessionRow;
  if ("clip_id" in body) {
    const model = pickModel(body.model);
    if (!model) throw new ApiError(503, "The assistant is not available yet.");
    await clipContext(supabase, body.clip_id);
    session = await rpcOrThrow<SessionRow>(supabase, body.new ? "agent_new_session" : "agent_open_session", {
      p_clip_id: body.clip_id,
      p_model: model,
    });
  } else {
    const provider = agentChatProvider("cmo");
    if (!provider) throw new ApiError(503, "Your CMO is not available yet.");
    session = await rpcOrThrow<SessionRow>(supabase, "agent_open_cmo_session", { p_model: provider.model, p_new: body.new ?? false });
  }
  return sessionView(supabase, session);
});
