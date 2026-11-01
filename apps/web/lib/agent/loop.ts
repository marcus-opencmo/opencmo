import "server-only";

/**
 * Vòng lặp của Assistant cho một lượt người dùng (spec AI Studio §6.2, spec
 * agent-editor §5) — manual loop, lưu từng bước, không phụ thuộc provider
 * (`providers/types.ts`) hay phạm vi (`scope.ts`: một clip hay cả project).
 *
 * Mỗi bước: dựng request từ `agent_messages` (chỉ nối thêm, dạng native của
 * provider; ảnh cũ bị thay bằng chữ ở bản gửi đi) → gọi model, chuyển
 * text/thinking/tool về trình duyệt qua SSE → ghi tin nhắn assistant và usage
 * → chạy tool, trả MỌI kết quả của bước trong MỘT tin nhắn user (sau bước có
 * ghi thì kèm trạng thái + `check` mới).
 *
 * A turn has no overall step limit; it PAUSES between two requests when:
 * - a tool runs in the tab (`capture`, `media_waveform`, `media_grab`, `save_frame`) → `awaiting_browser`;
 * - a priced approval card (`generate_media`) → `awaiting_approval`;
 * - the agent asks (`ask_user`) → `awaiting_input`;
 * - one request hits its time limit → `awaiting_continue` ('time'): the tab continues on its own;
 * - one request hits `MAX_STEPS` → `awaiting_continue` ('steps'): the tab continues on its own;
 * - the held credits are spent → `awaiting_continue` ('budget'): the user extends.
 * The same call failing `MAX_REPEATED_FAILURES` times in a row is reported to the model; one more
 * identical failure ends the turn.
 * Tool chạy ngay của cùng bước được giữ kết quả (`agent_tool_calls.content`);
 * `resumeTurn` ghép lại MỘT tin nhắn theo đúng thứ tự tool call rồi chạy tiếp.
 *
 * Trạng thái nằm trong DB: request chết giữa chừng thì lượt kế tiếp
 * (`agent_begin_turn`) chốt lượt treo theo usage đã ghi.
 */

import { ApiError } from "@/lib/api/errors";
import { markDown, outage } from "@/lib/llm-health";
import { rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";

import { canonicalJson } from "@opencmo/clip-doc";

import {
  AGENT_EXTEND_CREDITS,
  KEEP_IMAGES,
  MAX_REPEATED_FAILURES,
  MAX_REQUEST_MS,
  MAX_STEPS,
  SLOW_PLAN_CUTOFF_MS,
  SLOW_PLANS,
  STOP_POLL_MS,
} from "./limits";
import { canSwitchFrom } from "./model";
import { TAINT_GATED_TOOLS, TAINT_MESSAGE, TAINTING_TOOLS } from "./cmo-tools";
import type { Ledger } from "./ledger";
import { StepAborted, type Image, type Provider, type StoredMessage, type ToolCall, type ToolResult } from "./providers/types";
import type { Scope } from "./scope";
import { captureInput, checkErrorKeys, failingCheck, readGroup, VERIFY_GATE } from "./tools";

export type Emit = (event: string, data: unknown) => void;

/** Shown when the chat's model cannot answer and another one can: a chat is bound to its model. */
export const SWITCH_MODEL_MESSAGE = "This chat's model is not available right now. Start a new chat to continue on another model.";

export type Turn = { id: string; session_id: string; number: number; prompt: string; checkpoint_id?: string | null };

export type TurnEnv = {
  supabase: SupabaseClient;
  /** Usage, messages, tool calls and the settlement go here, never through `supabase` (ledger.ts). */
  ledger: Ledger;
  provider: Provider;
  scope: Scope;
  turn: Turn;
  emit: Emit;
  /** Vừa gia hạn credit: bước đầu chạy luôn, dù một bước trước đã tiêu vượt phần giữ mới. */
  extended?: boolean;
};

/**
 * Câu trả lời cho một tool call đang chờ: ảnh/số liệu từ tab, quyết định ở thẻ
 * duyệt, hay câu trả lời của người dùng cho `ask_user`.
 */
export type Answer = {
  tool_use_id: string;
  images?: string[];
  data?: unknown;
  error?: string;
  approved?: boolean;
  /** Redo of one keyframe on `animate_video`'s contact sheet, in place of approving it. */
  redo?: { index: number };
  answer?: { choices?: string[]; text?: string; skipped?: boolean };
};

/** PostgREST returns at most `max_rows` (1000) rows a request; a long chat must not lose its newest messages. */
const HISTORY_PAGE = 1000;

async function history(supabase: SupabaseClient, sessionId: string): Promise<StoredMessage[]> {
  const all: StoredMessage[] = [];
  for (let from = 0; ; from += HISTORY_PAGE) {
    const { data, error } = await supabase
      .from("agent_messages")
      .select("role, content")
      .eq("session_id", sessionId)
      .order("seq", { ascending: true })
      .range(from, from + HISTORY_PAGE - 1);
    if (error) throw error;
    all.push(...((data ?? []) as StoredMessage[]));
    if ((data?.length ?? 0) < HISTORY_PAGE) return all;
  }
}

/** Stored results of tool calls an interrupted turn never answered (see `StepRequest.ran`). */
async function ranTools(supabase: SupabaseClient, provider: Provider, sessionId: string, past: StoredMessage[]): Promise<Map<string, { ok: boolean; content: string }>> {
  const ids = provider.danglingCalls(past);
  if (!ids.length) return new Map();
  // Within this chat only: Claude's ids are unique everywhere, Gemini's are short and can repeat.
  const { data } = await supabase
    .from("agent_tool_calls")
    .select("tool_use_id, status, content, agent_turns!inner(session_id)")
    .eq("agent_turns.session_id", sessionId)
    .in("tool_use_id", ids)
    .in("status", ["done", "failed"]);
  return new Map(
    ((data ?? []) as { tool_use_id: string; status: string; content: { text?: string } | null }[])
      .filter((row) => typeof row.content?.text === "string")
      .map((row) => [row.tool_use_id, { ok: row.status === "done", content: row.content!.text! }]),
  );
}

export async function turnStatus(supabase: SupabaseClient, turnId: string) {
  const { data } = await supabase
    .from("agent_turns")
    .select("status, checkpoint_id, hold_credits")
    .eq("id", turnId)
    .maybeSingle();
  return data as { status: string; checkpoint_id: string | null; hold_credits: number } | null;
}

async function finish(env: TurnEnv, status: "done" | "failed" | "stopped", error: string | null) {
  const turn = await env.ledger<{ status: string; credits: number | null; error: string | null }>("agent_finish_turn", {
    p_turn_id: env.turn.id,
    p_status: status,
    p_error: error,
  });
  env.emit("done", { status: turn.status, credits: turn.credits, error: turn.error });
}

/** Lỗi nối tin nhắn vì lượt đã bị Stop — không phải lỗi thật. */
const isStopped = (err: unknown): boolean =>
  err instanceof ApiError && err.message === "This assistant turn was stopped.";

async function recordTool(
  env: TurnEnv,
  call: ToolCall,
  status: "pending" | "done" | "failed",
  result: Record<string, unknown> | null,
  content: string | null,
) {
  await env.ledger("agent_record_tool", {
    p_turn_id: env.turn.id,
    p_tool_use_id: call.id,
    p_name: call.name,
    p_input: call.input ?? {},
    p_status: status,
    p_result: result,
    p_content: content === null ? null : { text: content },
  });
}

/**
 * Hỏi trạng thái lượt mỗi `STOP_POLL_MS` trong lúc model đang nói: Stop thì
 * cắt luồng ngay, không đợi model nói xong (và không trả tiền phần còn lại).
 */
function watchStop(supabase: SupabaseClient, turnId: string) {
  const controller = new AbortController();
  const timer = setInterval(() => {
    void turnStatus(supabase, turnId)
      .then((row) => {
        if (row && row.status !== "running") controller.abort();
      })
      .catch(() => undefined);
  }, STOP_POLL_MS);
  return { signal: controller.signal, done: () => clearInterval(timer) };
}

/** Shown when the model keeps sending a call that fails the same way. */
export const REPEATED_FAILURE_MESSAGE = "The assistant kept repeating a step that fails, so it stopped. Try rephrasing the request.";

const callKey = (call: ToolCall): string => {
  try {
    return `${call.name}:${canonicalJson(call.input ?? {})}`;
  } catch {
    return `${call.name}:${JSON.stringify(call.input ?? {})}`;
  }
};

/**
 * Counts identical failing calls in a row. Retrying the exact same input after an error teaches the
 * model nothing; after `MAX_REPEATED_FAILURES` it is told so, and one more identical failure ends the turn.
 */
function failureStreak() {
  let key = "";
  let count = 0;
  return {
    succeeded: () => {
      key = "";
      count = 0;
    },
    /** The content to send back, and whether the turn should stop now. */
    failed: (call: ToolCall, content: string): { content: string; stop: boolean } => {
      const next = callKey(call);
      count = next === key ? count + 1 : 1;
      key = next;
      if (count < MAX_REPEATED_FAILURES) return { content, stop: false };
      const note = `This exact call has now failed ${count} times in a row. Do not send it again unchanged: change the input, try another approach, or stop and explain the problem to the user.`;
      return { content: JSON.stringify({ INVALID_INPUT: note, last_error: content }), stop: count > MAX_REPEATED_FAILURES };
    },
  };
}

/**
 * The turn's credits so far, by the same formula as SQL (`agent_credits`). Read again from `agent_usage` at the
 * START of every step: a turn resumed after a tab tool, an approval card or a question is a new `runTurn`, so a
 * variable in memory is not enough. Without this check, an agent that captures a frame at every step would spend past
 * its hold without anyone being asked.
 */
async function spentCredits(supabase: SupabaseClient, turnId: string): Promise<number> {
  const { data } = await supabase.from("agent_usage").select("micro_usd").eq("turn_id", turnId);
  const micro = ((data ?? []) as { micro_usd: number | string }[]).reduce((sum, row) => sum + Number(row.micro_usd), 0);
  return micro <= 0 ? 0 : Math.max(1, Math.ceil(micro / 50_000));
}

/**
 * Whether this turn already read outside content (fix 10). Read from the turn's own tool calls,
 * not kept in memory: a turn that paused and continues in a new request is still the same turn.
 */
async function turnTainted(supabase: SupabaseClient, turnId: string): Promise<boolean> {
  const { data } = await supabase
    .from("agent_tool_calls")
    .select("name")
    .eq("turn_id", turnId)
    .eq("status", "done")
    .in("name", [...TAINTING_TOOLS])
    .limit(1);
  return Boolean(data?.length);
}

async function pause(env: TurnEnv, reason: "browser" | "approval" | "input" | "time" | "steps" | "budget") {
  await rpcOrThrow(env.supabase, "agent_pause_turn", { p_turn_id: env.turn.id, p_reason: reason });
}

export async function runTurn(env: TurnEnv): Promise<void> {
  const { supabase, ledger, turn, emit, provider, scope } = env;
  const started = Date.now();
  // The session's messages, read once per request: this loop is the only writer while the turn
  // runs, so each step appends here what it appends to the database.
  let past: StoredMessage[] | undefined;
  // The check after this request's last write, while it lists errors; the gate runs once.
  let openCheck: string | null = null;
  let gated = false;
  // Errors the clip already had before this request's first write.
  let baseline: Set<string> | undefined;
  // The turn's credits so far, as agent_record_usage returns them after each model call; read again
  // only when it may be stale (first step, or a step whose tools ran sub-agents that record their own).
  let spent: number | null = null;
  const streak = failureStreak();
  // Outside content read in this turn: memory writes wait for the founder's next message.
  let tainted: boolean | undefined;

  try {
    for (let step = 0; ; step++) {
      const status = await turnStatus(supabase, turn.id);
      if (status?.status !== "running") {
        emit("done", { status: "stopped", credits: null, error: null });
        return;
      }
      const spentSoFar = spent ?? (await spentCredits(supabase, turn.id));
      let hold = status.hold_credits ?? 0;
      if (!(step === 0 && env.extended) && spentSoFar >= hold) {
        // A turn that previewed an explainer gets its hold raised once to AGENT_3D_HOLD_CREDITS (the
        // SQL name predates explainers): writing code and looking at previews costs more than edits.
        hold = await rpcOrThrow<number>(supabase, "agent_raise_hold_3d", { p_turn_id: turn.id }).catch(() => hold);
      }
      // Tự giữ thêm (mỗi lần AGENT_EXTEND_CREDITS) tới trần AGENT_AUTO_HOLD_CAP
      // khi số dư đủ: dừng hỏi "Continue?" giữa mọi việc vừa phải là thứ người
      // dùng ghét nhất (production 02/10: lượt nào cũng bấm 2–3 lần). Vẫn chỉ trừ
      // theo mức dùng thật, phần thừa hoàn lúc chốt lượt.
      while (!(step === 0 && env.extended) && spentSoFar >= hold) {
        const next = await rpcOrThrow<number>(supabase, "agent_auto_extend", { p_turn_id: turn.id }).catch(() => hold);
        if (next <= hold) break;
        hold = next;
      }
      if (!(step === 0 && env.extended) && spentSoFar >= hold) {
        // Chạm trần của lượt hay hết số dư: không tự tiêu thêm — người dùng duyệt.
        await pause(env, "budget");
        emit("done", { status: "awaiting_continue", reason: "budget", credits: spentSoFar, extend: AGENT_EXTEND_CREDITS, error: null });
        return;
      }
      if (step >= MAX_STEPS) {
        // Not an error: a request has a step limit, the turn does not. The tab continues.
        await pause(env, "steps");
        emit("done", { status: "awaiting_continue", reason: "steps", credits: null, error: null });
        return;
      }
      if (Date.now() - started > MAX_REQUEST_MS) {
        // Not an error: an HTTP request has a time limit, the turn does not. The tab continues.
        await pause(env, "time");
        emit("done", { status: "awaiting_continue", reason: "time", credits: null, error: null });
        return;
      }

      const watch = watchStop(supabase, turn.id);
      let result;
      try {
        past ??= await history(supabase, turn.session_id);
        result = await provider.step(
          {
            history: provider.trimImages(past, KEEP_IMAGES, KEEP_IMAGES),
            ran: await ranTools(supabase, provider, turn.session_id, past),
            tools: scope.tools,
            system: scope.system,
            signal: watch.signal,
          },
          (delta) => {
            if (delta.type === "tool_start") emit("tool_start", { id: delta.id, name: delta.name });
            else emit(delta.type, { text: delta.text });
          },
        );
      } catch (err) {
        if (watch.signal.aborted) {
          // Stop closed the turn already; the call it cut short is still billed, like any other.
          if (err instanceof StepAborted) {
            await ledger("agent_record_usage", {
              p_turn_id: turn.id,
              p_model: err.model,
              p_input: err.usage.input,
              p_output: err.usage.output,
              p_cache_read: err.usage.cacheRead,
              p_cache_write: err.usage.cacheWrite,
            }).catch((recordError: unknown) => console.error("[agent] recording a stopped call failed", turn.id, recordError));
          }
          emit("done", { status: "stopped", credits: null, error: null });
          return;
        }
        throw err;
      } finally {
        watch.done();
      }

      spent = await ledger<number>("agent_record_usage", {
        p_turn_id: turn.id,
        p_model: result.model,
        p_input: result.usage.input,
        p_output: result.usage.output,
        p_cache_read: result.usage.cacheRead,
        p_cache_write: result.usage.cacheWrite,
      });

      // Nguyên khối native: lịch sử phải giữ từng byte để khối suy nghĩ
      // (thinking block / thoughtSignature) và cache còn hợp lệ ở bước sau.
      await ledger("agent_append", { p_turn_id: turn.id, p_role: "assistant", p_content: result.content });
      past?.push({ role: "assistant", content: result.content as unknown[] });

      if (result.stop === "refusal") {
        await finish(env, "failed", "The assistant can't help with that request.");
        return;
      }
      if (!result.toolCalls.length) {
        if (openCheck && !gated) {
          // Finishing with errors the check reported: one more step to fix or explain them.
          gated = true;
          const nudge = provider.userTurn(VERIFY_GATE, openCheck);
          await ledger("agent_append", { p_turn_id: turn.id, p_role: "user", p_content: nudge });
          past?.push({ role: "user", content: nudge });
          continue;
        }
        await finish(env, "done", null);
        return;
      }
      if (result.stop === "max_tokens") {
        // Input tool bị cắt ở max_tokens vẫn có thể parse ra một object hợp lệ.
        await finish(env, "failed", "The assistant's answer was cut off. Try a smaller request.");
        return;
      }

      const results: ToolResult[] = [];
      const browser: ToolCall[] = [];
      const approvals: { call: ToolCall; card: unknown }[] = [];
      const questions: { call: ToolCall; card: unknown }[] = [];
      let wrote = false;
      let deferred = false;
      let runaway = false;
      // Planning tools run their own model calls and record them: read the total again next step.
      if (result.toolCalls.some((call) => SLOW_PLANS.has(call.name))) spent = null;
      // The CMO state never holds a <check> block, so reading it (six queries) would only build an empty set.
      if (!baseline && scope.kind !== "cmo" && result.toolCalls.some((call) => scope.isWrite(call.name))) {
        baseline = checkErrorKeys(await scope.state().catch(() => ""));
      }
      // Read-only calls next to each other start together; a read after a write still sees it.
      const early = new Map<string, { plan: Awaited<ReturnType<Scope["plan"]>>; outcome?: Awaited<ReturnType<Scope["run"]>> }>();
      for (const [index, call] of result.toolCalls.entries()) {
        if (!early.has(call.id)) {
          const group = readGroup(result.toolCalls, index);
          if (group.length > 1) {
            await Promise.all(
              group.map(async (member) => {
                const plan = await scope.plan(member);
                early.set(member.id, { plan, ...(plan.kind === "run" ? { outcome: await scope.run(member) } : {}) });
              }),
            );
          }
        }
        if (SLOW_PLANS.has(call.name) && Date.now() - started > SLOW_PLAN_CUTOFF_MS) {
          // Not started: it would run past the request's limit. This request pauses ("time") and
          // the tab continues at once, where the model calls it again with a full budget.
          const content = JSON.stringify({ INVALID_INPUT: "Not started yet: this request was near its time limit. Call it again with the same input now." });
          await recordTool(env, call, "failed", { summary: "Continuing in a moment" }, content);
          emit("tool_result", { id: call.id, name: call.name, ok: false, summary: "Continuing in a moment" });
          results.push({ id: call.id, name: call.name, ok: false, content });
          deferred = true;
          continue;
        }
        if (TAINT_GATED_TOOLS.has(call.name) && (tainted ??= await turnTainted(supabase, turn.id))) {
          const content = JSON.stringify({ error: TAINT_MESSAGE });
          await recordTool(env, call, "failed", { summary: "Waiting for the founder to confirm" }, content);
          emit("tool_result", { id: call.id, name: call.name, ok: false, summary: "Waiting for the founder to confirm" });
          results.push({ id: call.id, name: call.name, ok: false, content });
          continue;
        }
        const ready = early.get(call.id);
        const plan = ready?.plan ?? (await scope.plan(call));
        if (plan.kind === "browser") {
          browser.push({ ...call, input: plan.input });
          await recordTool(env, { ...call, input: plan.input }, "pending", null, null);
          continue;
        }
        if (plan.kind === "approval") {
          approvals.push({ call: { ...call, input: plan.input }, card: plan.card });
          continue;
        }
        if (plan.kind === "input") {
          questions.push({ call: { ...call, input: plan.input }, card: plan.card });
          await recordTool(env, { ...call, input: plan.input }, "pending", { question: plan.card }, null);
          continue;
        }
        if (plan.kind === "invalid") {
          const failure = streak.failed(call, plan.content);
          runaway ||= failure.stop;
          await recordTool(env, call, "failed", { summary: plan.summary }, failure.content);
          emit("tool_result", { id: call.id, name: call.name, ok: false, summary: plan.summary });
          results.push({ id: call.id, name: call.name, ok: false, content: failure.content });
          continue;
        }
        const outcome = ready?.outcome ?? (await scope.run(call));
        if (outcome.ok && TAINTING_TOOLS.has(call.name)) tainted = true;
        let content = outcome.content;
        if (outcome.ok) streak.succeeded();
        else {
          const failure = streak.failed(call, content);
          runaway ||= failure.stop;
          content = failure.content;
        }
        await recordTool(
          env,
          call,
          outcome.ok ? "done" : "failed",
          {
            summary: outcome.summary,
            ...(outcome.view ? { view: outcome.view } : {}),
            // The clip version and document this call left behind: the turn's Undo refuses once the document moved past them.
            ...(outcome.version !== undefined ? { version: outcome.version } : {}),
            ...(outcome.documentHash !== undefined ? { document_hash: outcome.documentHash } : {}),
          },
          content,
        );
        emit("tool_result", {
          id: call.id,
          name: call.name,
          ok: outcome.ok,
          summary: outcome.summary,
          view: outcome.view,
          // The panel shows server-rendered stills as it shows a tab's captures (not stored with the call).
          ...(outcome.images?.length ? { images: outcome.images.map((image) => image.data) } : {}),
        });
        if (outcome.version !== undefined) {
          wrote = true;
          emit("project_changed", { version: outcome.version });
        }
        results.push({ id: call.id, name: call.name, ok: outcome.ok, content, ...(outcome.images?.length ? { images: outcome.images } : {}) });
      }

      // A question and a price card in the same step: the panel shows the question, and the card the
      // user never saw would be declined with the answer. Send the card back to the model instead,
      // to propose again once the user has answered.
      if (questions.length && approvals.length) {
        const content = JSON.stringify({ INVALID_INPUT: "Ask your question first. Propose this again after the user answers, so they see its price card." });
        for (const { call } of approvals) {
          await recordTool(env, call, "failed", { summary: "Waiting for your answer first" }, content);
          emit("tool_result", { id: call.id, name: call.name, ok: false, summary: "Waiting for your answer first" });
        }
        approvals.length = 0;
      }
      for (const { call, card } of approvals) await recordTool(env, call, "pending", { approval: card }, null);

      if (browser.length || approvals.length || questions.length) {
        // Phần chạy ngay của bước đã xong và đã lưu; phần còn lại chờ.
        const reason = questions.length ? "input" : approvals.length ? "approval" : "browser";
        await pause(env, reason);
        for (const call of browser) emit("tool_request", { id: call.id, name: call.name, input: call.input });
        for (const { call, card } of approvals) emit("approval_request", { id: call.id, name: call.name, card });
        for (const { call, card } of questions) emit("input_request", { id: call.id, name: call.name, card });
        const statusName = { input: "awaiting_input", approval: "awaiting_approval", browser: "awaiting_browser" }[reason];
        emit("done", { status: statusName, credits: null, error: null });
        return;
      }

      // Tool ghi xong thì model thấy trạng thái mới + `check` ngay trong tin nhắn này.
      const state = wrote && result.toolCalls.some((call) => scope.isWrite(call.name)) ? await scope.state() : undefined;
      if (state !== undefined) openCheck = failingCheck(state, baseline);
      const answer = provider.toolResults(results, state);
      await ledger("agent_append", { p_turn_id: turn.id, p_role: "user", p_content: answer });
      past?.push({ role: "user", content: answer as unknown[] });
      if (runaway) {
        await finish(env, "failed", REPEATED_FAILURE_MESSAGE);
        return;
      }
      if (deferred) {
        await pause(env, "time");
        emit("done", { status: "awaiting_continue", reason: "time", credits: null, error: null });
        return;
      }
    }
  } catch (err) {
    if (isStopped(err)) {
      emit("done", { status: "stopped", credits: null, error: null });
      return;
    }
    console.error("[agent] turn failed", err);
    // The provider itself could not answer: remember it, so the next chat starts on the other one.
    const kind = outage(err);
    if (kind && provider.kind !== "fake" && !provider.ownKey) markDown(provider.kind, kind, provider.model);
    // Only when a new chat would really start elsewhere: an agent on a key of its own is not moved.
    const message = kind && !provider.ownKey && canSwitchFrom(provider.kind) ? SWITCH_MODEL_MESSAGE : provider.failureMessage(err);
    try {
      await finish(env, "failed", message);
    } catch (closeErr) {
      console.error("[agent] could not close the turn", closeErr);
      emit("done", { status: "failed", credits: null, error: message });
    }
  }
}

/** Nội dung tool_result cho một tool tab đã trả lời. */
function browserResult(call: ToolCall, input: unknown, answer: Answer | undefined): { ok: boolean; content: string; summary: string; images?: Image[] } {
  const images: Image[] = (answer?.images ?? []).map((data) => ({ data, mimeType: "image/jpeg" }));
  if (!answer || answer.error) {
    return { ok: false, content: JSON.stringify({ error: answer?.error ?? "The editor did not answer." }), summary: "The editor could not do this" };
  }
  if (call.name === "media_waveform") {
    const data = answer.data as { silences?: unknown[] } | undefined;
    if (!data) return { ok: false, content: JSON.stringify({ error: "No waveform came back." }), summary: "Could not read the sound" };
    const count = Array.isArray(data.silences) ? data.silences.length : 0;
    return { ok: true, content: JSON.stringify(data), summary: `Listened: ${count} silent ${count === 1 ? "stretch" : "stretches"}` };
  }
  if (call.name === "save_frame") {
    const data = answer.data as { path?: string; saved?: boolean } | undefined;
    if (!data?.path) return { ok: false, content: JSON.stringify({ error: "The frame could not be saved." }), summary: "Could not save the frame" };
    return {
      ok: true,
      content: JSON.stringify({
        ok: true,
        path: data.path,
        ...(data.saved ? {} : { note: "Still uploading: wait a moment before using it in generate_media." }),
      }),
      summary: `Saved a frame to ${data.path}`,
      images,
    };
  }
  if (call.name === "inspect_color") {
    const data = answer.data as { black?: number; white?: number } | undefined;
    if (!data) return { ok: false, content: JSON.stringify({ error: "No measurement came back." }), summary: "Could not measure the color" };
    return { ok: true, content: JSON.stringify({ ok: true, ...data }), summary: `Measured the color (black ${data.black ?? "?"}, white ${data.white ?? "?"})` };
  }
  if (!images.length) return { ok: false, content: JSON.stringify({ error: "No frames came back." }), summary: "Could not capture frames" };
  if (call.name === "media_grab") {
    return { ok: true, content: JSON.stringify({ ok: true, ...(answer.data as object | undefined) }), summary: "Looked inside the media", images };
  }
  const parsed = captureInput.safeParse(input);
  const data = answer.data as { times?: number[]; grid?: string; layers?: unknown } | undefined;
  const frames = data?.times ?? (parsed.success ? parsed.data.times : undefined);
  const count = frames?.length ?? images.length;
  return {
    ok: true,
    content: JSON.stringify({
      ok: true,
      times: frames ?? null,
      layout: images.length === 1 && count > 1 ? "contact sheet, left to right, top to bottom" : "one image per time",
      ...(data?.grid ? { grid: data.grid } : {}),
      // Nhãn lớp là chữ trên video / tên file của người dùng: đi trong phong bì dữ liệu.
      ...(data?.layers ? { visible_layers: { untrusted_data: data.layers } } : {}),
    }),
    summary: `Looked at ${count} ${count === 1 ? "frame" : "frames"}`,
    images,
  };
}

/**
 * Nhận câu trả lời cho các tool đang chờ (ảnh/số liệu từ tab, Approve/Cancel,
 * câu trả lời của người dùng), ghép MỌI kết quả của bước theo đúng thứ tự tool
 * call thành MỘT tin nhắn user, rồi chạy tiếp lượt. `env.turn` là lượt vừa
 * `agent_resume_turn`. Lượt dừng vì thời gian/credit không có tool nào chờ:
 * chạy tiếp luôn.
 */
export async function resumeTurn(env: TurnEnv, answers: Answer[]): Promise<void> {
  const { supabase, ledger, turn, provider, emit, scope } = env;
  try {
    const { data: lastMessage } = await supabase
      .from("agent_messages")
      .select("role, content")
      .eq("session_id", turn.session_id)
      .order("seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    // Tin nhắn cuối là của user: kết quả tool đã nối rồi (dừng vì thời gian/credit).
    if ((lastMessage as { role?: string } | null)?.role !== "assistant") {
      await runTurn(env);
      return;
    }
    const calls = provider.callsIn(((lastMessage as { content: unknown[] } | null)?.content ?? []) as unknown[]);

    const { data: rows } = await supabase
      .from("agent_tool_calls")
      .select("tool_use_id, name, input, status, content, result")
      .eq("turn_id", turn.id)
      .in("tool_use_id", calls.map((call) => call.id));
    const byId = new Map(
      ((rows ?? []) as {
        tool_use_id: string;
        input: unknown;
        status: string;
        content: { text?: string } | null;
        result: { approval?: unknown; question?: unknown } | null;
      }[]).map((row) => [row.tool_use_id, row]),
    );

    const results: ToolResult[] = [];
    let wrote = false;
    for (const call of calls) {
      const row = byId.get(call.id);
      if (row && row.status !== "pending") {
        results.push({ id: call.id, name: call.name, ok: row.status === "done", content: row.content?.text ?? "{}" });
        continue;
      }
      const answer = answers.find((item) => item.tool_use_id === call.id);

      if (row?.result?.approval !== undefined) {
        // Thẻ duyệt: không có câu trả lời thì coi như Cancel — không bao giờ tự ghi.
        const decided = await scope.decide(call, row.input, answer?.approved === true, answer?.redo);
        wrote ||= decided.wrote;
        await rpcOrThrow(supabase, "agent_complete_tool", {
          p_turn_id: turn.id,
          p_tool_use_id: call.id,
          p_status: decided.outcome.ok ? "done" : "failed",
          p_result: {
            summary: decided.outcome.summary,
            ...decided.extra,
            ...(decided.outcome.version !== undefined ? { version: decided.outcome.version } : {}),
            ...(decided.outcome.documentHash !== undefined ? { document_hash: decided.outcome.documentHash } : {}),
          },
        });
        emit("tool_result", { id: call.id, name: call.name, ok: decided.outcome.ok, summary: decided.outcome.summary, view: decided.outcome.view });
        if (decided.wrote) emit("project_changed", {});
        results.push({ id: call.id, name: call.name, ok: decided.outcome.ok, content: decided.outcome.content });
        continue;
      }

      if (row?.result?.question !== undefined) {
        const reply = answer?.answer;
        const skipped = !reply || reply.skipped || (!reply.text?.trim() && !reply.choices?.length);
        const content = skipped
          ? JSON.stringify({ skipped: true, message: "The user skipped the question. Use your best judgement." })
          : asUserData({ choices: reply!.choices ?? [], text: reply!.text?.trim() ?? "" });
        const summary = skipped ? "Skipped" : `Answered: ${[...(reply!.choices ?? []), reply!.text?.trim()].filter(Boolean).join(", ").slice(0, 80)}`;
        await rpcOrThrow(supabase, "agent_complete_tool", {
          p_turn_id: turn.id,
          p_tool_use_id: call.id,
          p_status: "done",
          p_result: { summary, answer: skipped ? null : reply },
        });
        emit("tool_result", { id: call.id, name: call.name, ok: true, summary });
        results.push({ id: call.id, name: call.name, ok: true, content });
        continue;
      }

      const outcome = browserResult(call, row?.input ?? call.input, answer);
      await rpcOrThrow(supabase, "agent_complete_tool", {
        p_turn_id: turn.id,
        p_tool_use_id: call.id,
        p_status: outcome.ok ? "done" : "failed",
        p_result: { summary: outcome.summary },
      });
      emit("tool_result", { id: call.id, name: call.name, ok: outcome.ok, summary: outcome.summary });
      results.push({ id: call.id, name: call.name, ok: outcome.ok, content: outcome.content, images: outcome.images });
    }

    await ledger("agent_append", {
      p_turn_id: turn.id,
      p_role: "user",
      // Trạng thái (kèm `check`) chỉ khi có ghi: sau một lần chụp không có gì mới để đọc lại.
      p_content: provider.toolResults(results, wrote ? await scope.state() : undefined),
    });
  } catch (err) {
    if (isStopped(err)) {
      emit("done", { status: "stopped", credits: null, error: null });
      return;
    }
    console.error("[agent] no answer reached the waiting tool", err);
    await finish(env, "failed", "The assistant could not continue this request.").catch(() => undefined);
    return;
  }
  await runTurn(env);
}

/** Câu trả lời của người dùng là dữ liệu, như transcript (spec AI Studio §6.7). */
const asUserData = (value: unknown): string => JSON.stringify({ user_answer: value });
