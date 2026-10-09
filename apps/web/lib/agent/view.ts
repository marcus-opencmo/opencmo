/**
 * Phiên Assistant ở hình dạng panel cần: mỗi lượt là câu lệnh, câu trả lời
 * (các khối text của assistant), thẻ hành động (tool call), credit và trạng
 * thái Undo. Thinking và tool_result không ra ngoài — chúng là lịch sử cho
 * model, không phải cho người đọc.
 */

import type { SupabaseClient } from "@/lib/api/handler";

import { formatFor } from "./model";

export type PlanItem = { text: string; status: "pending" | "active" | "done" };

export type Action = {
  id: string;
  name: string;
  ok: boolean;
  summary: string;
  /** Input đã rút gọn: dòng tool mở ra xem được, như panel chat của DS. */
  input?: unknown;
  view?: { plan?: PlanItem[]; touched?: string[]; exports?: { frame: string; task_id: string }[] };
  /** `apply_to_clips`: clip lỗi (để Retry) và op đã áp — Retry chạy lại đúng op đó. */
  failed?: { clip_id: string; label: string; error?: string }[];
  ops?: unknown[];
};

export type TurnView = {
  number: number;
  prompt: string;
  status: (typeof WAITING)[number] | "running" | "done" | "failed" | "stopped";
  /** `awaiting_continue`: 'time' (tab tự nối) hay 'budget' (người dùng gia hạn). */
  pause_reason: string | null;
  error: string | null;
  reply: string;
  actions: Action[];
  /** Danh sách việc mới nhất của lượt (`update_plan`). */
  plan: PlanItem[] | null;
  /** Tool đang chờ tab này: tool tab, thẻ duyệt có giá, hay câu hỏi (`card`). */
  pending: { id: string; name: string; input: unknown; card?: unknown }[];
  credits: number | null;
  can_undo: boolean;
  undone: boolean;
  created_at: string;
};

const WAITING = ["awaiting_browser", "awaiting_approval", "awaiting_input", "awaiting_continue"] as const;

export type SessionView = {
  id: string;
  model: string;
  scope: "clip" | "project" | "cmo";
  clip_id: string | null;
  job_id: string | null;
  locked: boolean;
  turns: TurnView[];
};

export type SessionRow = { id: string; clip_id: string | null; job_id: string | null; model: string; lock_until: string | null };

type TurnRow = {
  id: string;
  number: number;
  prompt: string;
  status: TurnView["status"];
  pause_reason: string | null;
  error: string | null;
  checkpoint_id: string | null;
  undone_at: string | null;
  credits: number | null;
  created_at: string;
};

export async function sessionView(
  supabase: SupabaseClient,
  session: SessionRow,
): Promise<SessionView> {
  const [{ data: turns }, { data: messages }, { data: tools }] = await Promise.all([
    supabase
      .from("agent_turns")
      .select("id, number, prompt, status, pause_reason, error, checkpoint_id, undone_at, credits, created_at")
      .eq("session_id", session.id)
      .order("number", { ascending: true })
      .limit(200),
    supabase
      .from("agent_messages")
      .select("turn_id, content")
      .eq("session_id", session.id)
      .eq("role", "assistant")
      .order("seq", { ascending: true }),
    supabase
      .from("agent_tool_calls")
      .select("turn_id, tool_use_id, name, input, status, result, created_at, agent_turns!inner(session_id)")
      .eq("agent_turns.session_id", session.id)
      .order("created_at", { ascending: true }),
  ]);

  const format = formatFor(session.model);
  const replies = new Map<string, string[]>();
  for (const row of (messages ?? []) as { turn_id: string; content: unknown[] }[]) {
    const text = format.replyText(row.content);
    if (text) replies.set(row.turn_id, [...(replies.get(row.turn_id) ?? []), text]);
  }
  const actions = new Map<string, TurnView["actions"]>();
  const pending = new Map<string, TurnView["pending"]>();
  const plans = new Map<string, PlanItem[]>();
  for (const row of (tools ?? []) as {
    turn_id: string;
    tool_use_id: string;
    name: string;
    input: unknown;
    status: string;
    result: {
      summary?: string;
      approval?: unknown;
      question?: unknown;
      view?: { plan?: PlanItem[]; touched?: string[] };
      ops?: unknown[];
      clips?: { clip_id: string; label: string; ok: boolean; error?: string }[];
    } | null;
  }[]) {
    if (row.status === "pending") {
      const card = row.result?.approval ?? row.result?.question;
      pending.set(row.turn_id, [
        ...(pending.get(row.turn_id) ?? []),
        { id: row.tool_use_id, name: row.name, input: row.input, ...(card ? { card } : {}) },
      ]);
      continue;
    }
    if (row.result?.view?.plan) plans.set(row.turn_id, row.result.view.plan);
    const failed = row.result?.clips?.filter((clip) => !clip.ok).map(({ clip_id, label, error }) => ({ clip_id, label, error }));
    actions.set(row.turn_id, [
      ...(actions.get(row.turn_id) ?? []),
      {
        id: row.tool_use_id,
        name: row.name,
        ok: row.status === "done",
        summary: row.result?.summary ?? row.name,
        input: brief(row.input),
        ...(row.result?.view ? { view: row.result.view } : {}),
        ...(failed?.length ? { failed, ops: row.result?.ops } : {}),
      },
    ]);
  }

  // Undo chỉ cho lượt ghi GẦN NHẤT chưa hoàn tác: checkpoint là bản trước lượt
  // đó, nên undo một lượt cũ hơn sẽ xoá luôn mọi lượt sau nó — không ai bấm
  // "Undo" ở một câu cũ mà mong thế.
  const undoable = ((turns ?? []) as TurnRow[])
    .filter((turn) => turn.checkpoint_id && !turn.undone_at && turn.status !== "running" && !(WAITING as readonly string[]).includes(turn.status))
    .reduce((latest, turn) => Math.max(latest, turn.number), 0);

  return {
    id: session.id,
    model: session.model,
    scope: session.clip_id ? "clip" : session.job_id ? "project" : "cmo",
    clip_id: session.clip_id,
    job_id: session.job_id,
    locked: Boolean(session.lock_until && new Date(session.lock_until).getTime() > Date.now()),
    turns: ((turns ?? []) as TurnRow[]).map((turn) => ({
      number: turn.number,
      prompt: turn.prompt,
      status: turn.status,
      pause_reason: turn.pause_reason,
      error: turn.error,
      reply: (replies.get(turn.id) ?? []).join("\n\n"),
      actions: actions.get(turn.id) ?? [],
      plan: plans.get(turn.id) ?? null,
      pending: (WAITING as readonly string[]).includes(turn.status) ? (pending.get(turn.id) ?? []) : [],
      credits: turn.credits,
      can_undo: turn.number === undoable,
      undone: Boolean(turn.undone_at),
      created_at: turn.created_at,
    })),
  };
}

/** Input tool rút gọn cho panel: chuỗi dài bị cắt, mảng dài chỉ giữ đầu. */
function brief(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (Array.isArray(value)) {
    const head = value.slice(0, 12).map((item) => brief(item, depth + 1));
    return value.length > 12 ? [...head, `… ${value.length - 12} more`] : head;
  }
  if (!value || typeof value !== "object") return value;
  if (depth > 4) return "…";
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, brief(item, depth + 1)]));
}
