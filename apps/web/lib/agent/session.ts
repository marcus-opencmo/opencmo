import "server-only";

/**
 * Loads an Assistant session (under RLS) and builds its scope. The turns, tool-results and
 * approvals routes share this path — a clip chat and the CMO chat differ only here.
 */

import { ApiError } from "@/lib/api/errors";
import { clipContext } from "@/lib/api/clips";
import { notFound, rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";

import { resumeTurn, runTurn, type Answer, type Turn } from "./loop";
import { agentChatProvider, kindOf, providerForModel } from "./model";
import type { Provider } from "./providers/types";
import { loadCatalog } from "@/lib/generate/models";

import { serviceLedger, type Ledger } from "./ledger";
import { clipScope, cmoScope, type Scope } from "./scope";
import { sseResponse } from "./sse";
import { screenContextText, type ScreenContext } from "./panel";
import { slashDirective } from "./slash";

/** `scope` is the stored value: rows from the removed multi-clip project chat may still say "project". */
export type SessionRow = { id: string; scope: string; clip_id: string | null; model: string };

export async function loadSession(supabase: SupabaseClient, id: string | undefined): Promise<{ session: SessionRow; provider: Provider }> {
  if (!/^[0-9a-f-]{36}$/.test(id ?? "")) throw notFound("Assistant session not found.");
  const { data } = await supabase.from("agent_sessions").select("id, scope, clip_id, model").eq("id", id).maybeSingle();
  const session = data as SessionRow | null;
  // The multi-clip project chat is gone with the clipping tool; its old sessions stay read-only history.
  if (!session || (session.scope !== "cmo" && !session.clip_id)) throw notFound("Assistant session not found.");
  // A CMO chat runs on the `cmo` agent's current model of the chat's own provider family: history
  // only replays within a family.
  const family = kindOf(session.model);
  const provider =
    session.scope === "cmo" ? (family === "fake" ? agentChatProvider("cmo") : agentChatProvider("cmo", family)) : providerForModel(session.model);
  if (!provider && kindOf(session.model) === "gemini") throw new ApiError(409, "This chat used a model that is no longer available. Start a new chat.");
  if (!provider) throw new ApiError(503, "The assistant is not available yet.");
  return { session, provider };
}

export async function scopeFor(
  supabase: SupabaseClient,
  session: SessionRow,
  turn: { id: string; prompt: string; checkpoint_id?: string | null },
  ledger: Ledger,
): Promise<Scope> {
  const checkpointed = Boolean(turn.checkpoint_id);
  // Tool sinh media mang giá trên thẻ duyệt: nạp catalog DB (G5) trước khi dựng scope.
  await loadCatalog(supabase);
  if (session.scope === "cmo") return cmoScope(supabase);
  if (!session.clip_id) throw notFound("Assistant session not found.");
  const context = await clipContext(supabase, session.clip_id);
  return clipScope(supabase, context, session.clip_id, turn, checkpointed, ledger);
}

/**
 * Thứ người dùng đính kèm câu lệnh (như chip của composer DS): playhead, lớp
 * đang chọn, khung đang xem. Chúng đi vào tin nhắn như DỮ LIỆU sau câu lệnh.
 */
export type Attachments = { playhead?: number; selection?: string[]; frame?: string; voice?: string; screen?: ScreenContext };

function attachmentText(attachments: Attachments | undefined): string {
  if (!attachments) return "";
  const parts: string[] = [];
  if (attachments.playhead !== undefined) parts.push(`playhead: ${attachments.playhead.toFixed(2)}s on the clip timeline`);
  if (attachments.selection?.length) parts.push(`selected elements: ${attachments.selection.join(", ")}`);
  if (attachments.frame) parts.push("the attached image is the frame the user is looking at");
  // Giọng người dùng chọn ở ô chat (đã nghe thử): dùng đúng giọng này, đừng hỏi lại.
  if (attachments.voice) parts.push(`voice picked by the user: "${attachments.voice}" (use it for any voiceover or voice change in this request)`);
  return (parts.length ? `<attached>${parts.join("; ")}</attached>` : "") + screenContextText(attachments.screen);
}

/** Starts a turn and streams it. `userId` is the user `withApi` verified; the ledger writes for them. */
export async function startTurn(supabase: SupabaseClient, userId: string, sessionId: string | undefined, prompt: string, attachments?: Attachments) {
  const { session, provider } = await loadSession(supabase, sessionId);
  const ledger = serviceLedger(userId);
  // One scope for the whole request (catalog, clip context and tools load once). It reads the
  // opening state before the turn exists; the turn's id is filled in once it does, and nothing
  // uses it before then.
  const pending = { id: "", prompt };
  const scope = await scopeFor(supabase, session, pending, ledger);
  // Kịch bản clip đi trước trạng thái: agent đọc người nói nói gì trước khi sửa.
  const state = `${(await scope.context?.()) ?? ""}${await scope.state()}`;
  const images = attachments?.frame ? [{ data: attachments.frame, mimeType: "image/jpeg" as const }] : undefined;
  const turn = await rpcOrThrow<Turn>(supabase, "agent_begin_turn", {
    p_session_id: session.id,
    p_prompt: prompt,
    p_content: provider.userTurn(prompt, `${slashDirective(prompt, scope.tools.map((tool) => tool.name))}${attachmentText(attachments)}${state}`, images),
  });
  pending.id = turn.id;
  return sseResponse(async (emit) => {
    emit("turn", { number: turn.number });
    await runTurn({ supabase, ledger, provider, scope, turn, emit });
  });
}

/**
 * Trả lời các tool đang chờ (ảnh, Approve/Cancel, câu trả lời), hoặc nối tiếp
 * một lượt dừng vì thời gian (`answers` rỗng), và stream phần còn lại của lượt.
 * `extend`: người dùng duyệt giữ thêm credit cho lượt dừng vì hết phần giữ.
 */
export async function continueTurn(
  supabase: SupabaseClient,
  userId: string,
  sessionId: string | undefined,
  answers: Answer[],
  options: { extend?: boolean } = {},
) {
  const { session, provider } = await loadSession(supabase, sessionId);
  // Name the pause being answered: the tool calls answered, or a Continue. A late request from
  // another tab then fails instead of answering (and cancelling) a newer pause.
  const resume = answers.length
    ? { p_tool_use_ids: answers.map((answer) => answer.tool_use_id) }
    : { p_waiting: "awaiting_continue" };
  const turn = options.extend
    ? await rpcOrThrow<Turn>(supabase, "agent_extend_hold", { p_session_id: session.id })
    : await rpcOrThrow<Turn>(supabase, "agent_resume_turn", { p_session_id: session.id, ...resume });
  const ledger = serviceLedger(userId);
  let scope: Awaited<ReturnType<typeof scopeFor>>;
  try {
    scope = await scopeFor(supabase, session, turn, ledger);
  } catch (error) {
    // The turn is running again (and an extend already held more credits): close it, or the clip
    // reads "already working" until the reaper and the hold stays taken.
    await ledger("agent_finish_turn", { p_turn_id: turn.id, p_status: "failed", p_error: "The assistant could not continue this request." }).catch(
      (closeError: unknown) => console.error("agent: closing a turn that could not continue failed", turn.id, closeError),
    );
    throw error;
  }
  return sseResponse(async (emit) => {
    emit("turn", { number: turn.number });
    await resumeTurn({ supabase, ledger, provider, scope, turn, emit, extended: options.extend === true }, answers);
  });
}
