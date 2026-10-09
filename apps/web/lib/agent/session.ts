import "server-only";

/**
 * Nạp một phiên Assistant (dưới RLS) và dựng phạm vi của nó. Route turns,
 * tool-results và approvals đi chung đường này — phiên clip hay project chỉ
 * khác nhau ở đây.
 */

import { ApiError } from "@/lib/api/errors";
import { clipContext } from "@/lib/api/clips";
import { notFound, rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";

import { resumeTurn, runTurn, type Answer, type Turn } from "./loop";
import { agentChatProvider, kindOf, providerForModel } from "./model";
import type { Provider } from "./providers/types";
import { loadCatalog } from "@/lib/generate/models";

import { clipScope, cmoScope, projectScope, type Scope } from "./scope";
import { sseResponse } from "./sse";

export type SessionRow = { id: string; scope: "clip" | "project" | "cmo"; clip_id: string | null; job_id: string | null; model: string };

export async function loadSession(supabase: SupabaseClient, id: string | undefined): Promise<{ session: SessionRow; provider: Provider }> {
  if (!/^[0-9a-f-]{36}$/.test(id ?? "")) throw notFound("Assistant session not found.");
  const { data } = await supabase.from("agent_sessions").select("id, scope, clip_id, job_id, model").eq("id", id).maybeSingle();
  const session = data as SessionRow | null;
  if (!session) throw notFound("Assistant session not found.");
  // CMO chat chạy theo cấu hình HIỆN TẠI của agent `cmo` (đổi env là phiên cũ chạy model mới):
  // lịch sử chỉ đọc lại được khi cùng họ provider, nên khác họ thì coi như chưa sẵn sàng.
  const provider =
    session.scope === "cmo"
      ? (() => {
          const current = agentChatProvider("cmo");
          return current && current.kind === kindOf(session.model) ? current : null;
        })()
      : providerForModel(session.model);
  if (!provider) throw new ApiError(503, "The assistant is not available yet.");
  return { session, provider };
}

export async function scopeFor(
  supabase: SupabaseClient,
  session: SessionRow,
  turn: { id: string; prompt: string; checkpoint_id?: string | null },
): Promise<Scope> {
  const checkpointed = Boolean(turn.checkpoint_id);
  // Tool sinh media mang giá trên thẻ duyệt: nạp catalog DB (G5) trước khi dựng scope.
  await loadCatalog(supabase);
  if (session.scope === "cmo") return cmoScope(supabase);
  if (session.clip_id) {
    const context = await clipContext(supabase, session.clip_id);
    return clipScope(supabase, context, session.clip_id, turn, checkpointed);
  }
  return projectScope(supabase, session.job_id!, turn, checkpointed);
}

/**
 * Thứ người dùng đính kèm câu lệnh (như chip của composer DS): playhead, lớp
 * đang chọn, khung đang xem. Chúng đi vào tin nhắn như DỮ LIỆU sau câu lệnh.
 */
export type Attachments = { playhead?: number; selection?: string[]; frame?: string; voice?: string };

function attachmentText(attachments: Attachments | undefined): string {
  if (!attachments) return "";
  const parts: string[] = [];
  if (attachments.playhead !== undefined) parts.push(`playhead: ${attachments.playhead.toFixed(2)}s on the clip timeline`);
  if (attachments.selection?.length) parts.push(`selected elements: ${attachments.selection.join(", ")}`);
  if (attachments.frame) parts.push("the attached image is the frame the user is looking at");
  // Giọng người dùng chọn ở ô chat (đã nghe thử): dùng đúng giọng này, đừng hỏi lại.
  if (attachments.voice) parts.push(`voice picked by the user: "${attachments.voice}" (use it for any voiceover or voice change in this request)`);
  return parts.length ? `<attached>${parts.join("; ")}</attached>` : "";
}

/** Bắt đầu một lượt và stream nó. */
export async function startTurn(supabase: SupabaseClient, sessionId: string | undefined, prompt: string, attachments?: Attachments) {
  const { session, provider } = await loadSession(supabase, sessionId);
  // Trạng thái đầu lượt: dựng phạm vi chỉ để đọc nó, trước khi lượt tồn tại.
  const reader = await scopeFor(supabase, session, { id: "", prompt });
  // Kịch bản clip đi trước trạng thái: agent đọc người nói nói gì trước khi sửa.
  const state = `${(await reader.context?.()) ?? ""}${await reader.state()}`;
  const images = attachments?.frame ? [{ data: attachments.frame, mimeType: "image/jpeg" as const }] : undefined;
  const turn = await rpcOrThrow<Turn>(supabase, "agent_begin_turn", {
    p_session_id: session.id,
    p_prompt: prompt,
    p_content: provider.userTurn(prompt, `${attachmentText(attachments)}${state}`, images),
  });
  const scope = await scopeFor(supabase, session, turn);
  return sseResponse(async (emit) => {
    emit("turn", { number: turn.number });
    await runTurn({ supabase, provider, scope, turn, emit });
  });
}

/**
 * Trả lời các tool đang chờ (ảnh, Approve/Cancel, câu trả lời), hoặc nối tiếp
 * một lượt dừng vì thời gian (`answers` rỗng), và stream phần còn lại của lượt.
 * `extend`: người dùng duyệt giữ thêm credit cho lượt dừng vì hết phần giữ.
 */
export async function continueTurn(
  supabase: SupabaseClient,
  sessionId: string | undefined,
  answers: Answer[],
  options: { extend?: boolean } = {},
) {
  const { session, provider } = await loadSession(supabase, sessionId);
  const turn = await rpcOrThrow<Turn>(supabase, options.extend ? "agent_extend_hold" : "agent_resume_turn", {
    p_session_id: session.id,
  });
  const scope = await scopeFor(supabase, session, turn);
  return sseResponse(async (emit) => {
    emit("turn", { number: turn.number });
    await resumeTurn({ supabase, provider, scope, turn, emit, extended: options.extend === true }, answers);
  });
}
