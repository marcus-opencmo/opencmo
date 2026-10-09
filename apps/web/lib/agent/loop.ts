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
 * Không có trần số bước. Lượt TẠM DỪNG giữa hai request khi:
 * - tool chạy ở tab (`capture`, `media_waveform`, `media_grab`, `save_frame`) → `awaiting_browser`;
 * - thẻ duyệt có giá (`generate_media`, `apply_to_clips`) → `awaiting_approval`;
 * - agent hỏi (`ask_user`) → `awaiting_input`;
 * - chạm trần thời gian của MỘT request → `awaiting_continue` ('time'): tab tự nối;
 * - tiêu hết credit đã giữ → `awaiting_continue` ('budget'): người dùng gia hạn.
 * Tool chạy ngay của cùng bước được giữ kết quả (`agent_tool_calls.content`);
 * `resumeTurn` ghép lại MỘT tin nhắn theo đúng thứ tự tool call rồi chạy tiếp.
 *
 * Trạng thái nằm trong DB: request chết giữa chừng thì lượt kế tiếp
 * (`agent_begin_turn`) chốt lượt treo theo usage đã ghi.
 */

import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";

import { AGENT_EXTEND_CREDITS, KEEP_IMAGES, MAX_REQUEST_MS, STOP_POLL_MS } from "./limits";
import type { Image, Provider, StoredMessage, ToolCall, ToolResult } from "./providers/types";
import type { Scope } from "./scope";
import { captureInput } from "./tools";

export type Emit = (event: string, data: unknown) => void;

export type Turn = { id: string; session_id: string; number: number; prompt: string; checkpoint_id?: string | null };

export type TurnEnv = {
  supabase: SupabaseClient;
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
  answer?: { choices?: string[]; text?: string; skipped?: boolean };
};

async function history(supabase: SupabaseClient, sessionId: string): Promise<StoredMessage[]> {
  const { data, error } = await supabase
    .from("agent_messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("seq", { ascending: true });
  if (error) throw error;
  return (data ?? []) as StoredMessage[];
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
  const turn = await rpcOrThrow<{ status: string; credits: number | null; error: string | null }>(
    env.supabase,
    "agent_finish_turn",
    { p_turn_id: env.turn.id, p_status: status, p_error: error },
  );
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
  await rpcOrThrow(env.supabase, "agent_record_tool", {
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

/**
 * Credit đã tiêu của lượt, cùng công thức với SQL (`agent_credits`). Đọc lại từ
 * `agent_usage` ở ĐẦU mỗi bước: lượt nối tiếp sau tool tab/thẻ duyệt/câu hỏi là
 * một `runTurn` mới, nên một biến trong bộ nhớ không đủ — thiếu chốt này thì
 * một agent chụp khung ở mọi bước tiêu vượt phần giữ mà không ai được hỏi.
 */
async function spentCredits(supabase: SupabaseClient, turnId: string): Promise<number> {
  const { data } = await supabase.from("agent_usage").select("micro_usd").eq("turn_id", turnId);
  const micro = ((data ?? []) as { micro_usd: number | string }[]).reduce((sum, row) => sum + Number(row.micro_usd), 0);
  return micro <= 0 ? 0 : Math.max(1, Math.ceil(micro / 50_000));
}

async function pause(env: TurnEnv, reason: "browser" | "approval" | "input" | "time" | "budget") {
  await rpcOrThrow(env.supabase, "agent_pause_turn", { p_turn_id: env.turn.id, p_reason: reason });
}

export async function runTurn(env: TurnEnv): Promise<void> {
  const { supabase, turn, emit, provider, scope } = env;
  const started = Date.now();

  try {
    for (let step = 0; ; step++) {
      const status = await turnStatus(supabase, turn.id);
      if (status?.status !== "running") {
        emit("done", { status: "stopped", credits: null, error: null });
        return;
      }
      const spentSoFar = await spentCredits(supabase, turn.id);
      let hold = status.hold_credits ?? 0;
      if (!(step === 0 && env.extended) && spentSoFar >= hold) {
        // Lượt làm cảnh 3D (đã preview_3d) được tự nâng phần giữ một lần lên
        // AGENT_3D_HOLD_CREDITS: vòng viết code + xem preview tốn hơn sửa thường.
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
      if (Date.now() - started > MAX_REQUEST_MS) {
        // Không phải lỗi: request HTTP có trần, lượt thì không. Tab gọi nối tiếp.
        await pause(env, "time");
        emit("done", { status: "awaiting_continue", reason: "time", credits: null, error: null });
        return;
      }

      const watch = watchStop(supabase, turn.id);
      let result;
      try {
        result = await provider.step(
          {
            history: provider.trimImages(await history(supabase, turn.session_id), KEEP_IMAGES),
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
          emit("done", { status: "stopped", credits: null, error: null });
          return;
        }
        throw err;
      } finally {
        watch.done();
      }

      await rpcOrThrow<number>(supabase, "agent_record_usage", {
        p_turn_id: turn.id,
        p_model: result.model,
        p_input: result.usage.input,
        p_output: result.usage.output,
        p_cache_read: result.usage.cacheRead,
        p_cache_write: result.usage.cacheWrite,
      });

      // Nguyên khối native: lịch sử phải giữ từng byte để khối suy nghĩ
      // (thinking block / thoughtSignature) và cache còn hợp lệ ở bước sau.
      await rpcOrThrow(supabase, "agent_append", { p_turn_id: turn.id, p_role: "assistant", p_content: result.content });

      if (result.stop === "refusal") {
        await finish(env, "failed", "The assistant can't help with that request.");
        return;
      }
      if (!result.toolCalls.length) {
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
      for (const call of result.toolCalls) {
        const plan = await scope.plan(call);
        if (plan.kind === "browser") {
          browser.push({ ...call, input: plan.input });
          await recordTool(env, { ...call, input: plan.input }, "pending", null, null);
          continue;
        }
        if (plan.kind === "approval") {
          approvals.push({ call: { ...call, input: plan.input }, card: plan.card });
          await recordTool(env, { ...call, input: plan.input }, "pending", { approval: plan.card }, null);
          continue;
        }
        if (plan.kind === "input") {
          questions.push({ call: { ...call, input: plan.input }, card: plan.card });
          await recordTool(env, { ...call, input: plan.input }, "pending", { question: plan.card }, null);
          continue;
        }
        if (plan.kind === "invalid") {
          await recordTool(env, call, "failed", { summary: plan.summary }, plan.content);
          emit("tool_result", { id: call.id, name: call.name, ok: false, summary: plan.summary });
          results.push({ id: call.id, name: call.name, ok: false, content: plan.content });
          continue;
        }
        const outcome = await scope.run(call);
        await recordTool(
          env,
          call,
          outcome.ok ? "done" : "failed",
          { summary: outcome.summary, ...(outcome.view ? { view: outcome.view } : {}) },
          outcome.content,
        );
        emit("tool_result", { id: call.id, name: call.name, ok: outcome.ok, summary: outcome.summary, view: outcome.view });
        if (outcome.version !== undefined) {
          wrote = true;
          emit("project_changed", { version: outcome.version });
        }
        results.push({ id: call.id, name: call.name, ok: outcome.ok, content: outcome.content });
      }

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
      await rpcOrThrow(supabase, "agent_append", {
        p_turn_id: turn.id,
        p_role: "user",
        p_content: provider.toolResults(results, state),
      });

    }
  } catch (err) {
    if (isStopped(err)) {
      emit("done", { status: "stopped", credits: null, error: null });
      return;
    }
    console.error("[agent] lượt lỗi", err);
    const message = provider.failureMessage(err);
    try {
      await finish(env, "failed", message);
    } catch (closeErr) {
      console.error("[agent] không chốt được lượt", closeErr);
      emit("done", { status: "failed", credits: null, error: message });
    }
  }
}

/** Nội dung tool_result cho một tool tab đã trả lời. */
function browserResult(call: ToolCall, input: unknown, answer: Answer | undefined): { ok: boolean; content: string; summary: string; images?: Image[] } {
  const images: Image[] = (answer?.images ?? []).map((data) => ({ data, mimeType: "image/jpeg" }));
  if (!answer || answer.error) {
    const summary = call.name === "preview_3d" && answer?.error ? "3D preview failed" : "The editor could not do this";
    return { ok: false, content: JSON.stringify({ error: answer?.error ?? "The editor did not answer." }), summary };
  }
  if (call.name === "preview_3d") {
    // Ảnh cho model THẤY, báo cáo bố cục cho nó biết CHÍNH XÁC sửa gì (spec code-scenes).
    const data = (answer.data ?? {}) as { layout?: { issues?: string[] }[] };
    const issues = (data.layout ?? []).reduce((sum, frame) => sum + (frame.issues?.length ?? 0), 0);
    if (!images.length) return { ok: false, content: JSON.stringify({ error: "No frames came back." }), summary: "3D preview failed" };
    return {
      ok: true,
      content: JSON.stringify({ ok: true, ...data, images: "one image per time, in order" }),
      summary: issues ? `Previewed the 3D scene: ${issues} layout ${issues === 1 ? "issue" : "issues"}` : "Previewed the 3D scene",
      images,
    };
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
  const { supabase, turn, provider, emit, scope } = env;
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
        const decided = await scope.decide(call, row.input, answer?.approved === true);
        wrote ||= decided.wrote;
        await rpcOrThrow(supabase, "agent_complete_tool", {
          p_turn_id: turn.id,
          p_tool_use_id: call.id,
          p_status: decided.outcome.ok ? "done" : "failed",
          p_result: { summary: decided.outcome.summary, ...decided.extra },
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

    await rpcOrThrow(supabase, "agent_append", {
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
    console.error("[agent] không nhận được câu trả lời cho tool đang chờ", err);
    await finish(env, "failed", "The assistant could not continue this request.").catch(() => undefined);
    return;
  }
  await runTurn(env);
}

/** Câu trả lời của người dùng là dữ liệu, như transcript (spec AI Studio §6.7). */
const asUserData = (value: unknown): string => JSON.stringify({ user_answer: value });
