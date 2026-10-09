"use client";

/**
 * Tab Assistant của clip (checklist OCM-02, spec agent-editor AE5): chat dựng
 * video như panel chat của DS — chọn model, lịch sử chat, New chat; mỗi lượt
 * có danh sách việc (plan), dòng tool mở ra xem input/ảnh, "Thinking" gập lại,
 * thẻ câu hỏi (`ask_user`), thẻ duyệt có giá, thẻ gia hạn credit; composer có
 * chip đính kèm (khung đang xem, playhead, lớp đang chọn). Hơn DS: Undo cả
 * lượt một cú (checkpoint trước lượt).
 *
 * Trạng thái sống ở server (`agent_*`): panel đọc lại sau mỗi lượt, nên đóng
 * tab giữa lượt rồi mở lại vẫn thấy đúng lượt đó, và "Continue" nếu nó đang
 * chờ tab này.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  Action,
  ApprovalCard,
  AssistantClient,
  AssistantEvent,
  Attachments,
  BrowserResult,
  ModelChoice,
  PlanItem,
  QuestionCard,
  SessionSummary,
  SessionView,
  ToolRequest,
  TurnView,
} from "./client";
import { api } from "@/components/clipping/api";
import type { RenderTask } from "@/lib/api/tasks";

import type { ToolAnswer } from "./capture";
import { Markdown } from "./Markdown";
import { VoicePicker } from "./VoicePicker";

/** `activity`/`lastEvent`: thanh "đang làm" của lượt live — người dùng phải thấy agent còn sống. */
type LiveTurn = TurnView & { thinking?: string; activity?: Activity; lastEvent?: number };
type Activity = { kind: "thinking" | "writing" | "tool" | "waiting"; tool?: string };

const EXAMPLES = [
  "Tighten the pacing: cut filler words and long pauses",
  "Add a bold hook title for the first 3 seconds",
  "Make it square and check the speaker stays in frame",
];

/** Gợi ý chỉ có khi máy chủ bật model ảnh/video (học starter "Generate B-roll" của Palmier). */
const BROLL_EXAMPLE = "Generate B-roll: AI shots for the lines that name something concrete";

const MODEL_KEY = "opencmo.assistant.model";

const isQuestion = (card: unknown): card is QuestionCard => Boolean(card && typeof card === "object" && "question" in card);
const isApproval = (card: unknown): card is ApprovalCard => Boolean(card && typeof card === "object" && "changes" in card);

function readModel(): string | undefined {
  try {
    return localStorage.getItem(MODEL_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function saveModel(model: string): void {
  try {
    localStorage.setItem(MODEL_KEY, model);
  } catch {
    // Trình duyệt chặn storage: chỉ mất lựa chọn nhớ sẵn.
  }
}

export function AssistantPanel({
  client,
  runTool,
  context,
  busy,
  onBusy,
  notify,
  onTouched,
}: {
  client: AssistantClient;
  /** Chạy một tool phía tab (`capture`, `media_waveform`, `media_grab`). */
  runTool: (request: ToolRequest) => Promise<ToolAnswer>;
  /** Playhead (giây trên timeline bản xuất), lớp đang chọn, và chụp khung đang xem. */
  context: { playhead: () => number; selection: () => string[]; frame: () => Promise<string> };
  busy: boolean;
  onBusy: (busy: boolean) => void;
  notify: (message: string) => void;
  /** Id lớp agent vừa thêm/sửa/dời — editor nháy chúng trên timeline. */
  onTouched?: (ids: string[]) => void;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [broll, setBroll] = useState(false);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<SessionView | null>(null);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const liveRef = useRef<LiveTurn | null>(null);
  const [imagesByTool, setImagesByTool] = useState<Record<string, string[]>>({});
  const [draft, setDraft] = useState("");
  const [attach, setAttach] = useState({ frame: false, playhead: false, selection: false });
  // Giọng chọn ở ô chat: GIỮ qua các lượt (người dùng chọn một giọng cho cả clip).
  const [voice, setVoice] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Ô nhập giãn theo chữ tới ~8 dòng rồi mới cuộn; gửi xong thì co lại.
  useEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 200)}px`;
  }, [draft]);
  const afterTool = useRef(false);

  const setTurn = (turn: LiveTurn | null) => {
    liveRef.current = turn;
    setLive(turn);
  };
  // Sau khi React vẽ xong (thẻ duyệt hiện ở lần render SAU refresh): microtask chạy trước lúc đó.
  const scrollDown = () => requestAnimationFrame(() => list.current?.scrollTo({ top: list.current.scrollHeight }));

  const refresh = useCallback(
    async (wanted?: string, sessionId?: string) => {
      try {
        const next = await client.load(wanted ?? readModel(), sessionId);
        setAvailable(next.available);
        setBroll(Boolean(next.broll));
        setModels(next.models);
        setSessions(next.sessions);
        setModel(next.model ?? undefined);
        setSession(next.session);
        return next.session;
      } catch (error) {
        console.error("[assistant] could not load", error);
        setAvailable(false);
        return null;
      }
    },
    [client],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Rời panel giữa lượt: lượt vẫn chạy trên server, nhưng lớp khoá canvas không được kẹt lại.
  useEffect(() => () => onBusy(false), [onBusy]);

  type Pending = { requests: ToolRequest[]; done: { status: string; reason?: string } | null };

  const onEvent = (pending: Pending) => (event: AssistantEvent) => {
    const before = liveRef.current;
    if (!before) return;
    const now: LiveTurn = { ...before, lastEvent: Date.now(), activity: activityOf(event, before.activity) };
    switch (event.event) {
      case "turn":
        setTurn({ ...now, number: event.data.number });
        break;
      case "thinking":
        setTurn({ ...now, thinking: (now.thinking ?? "") + event.data.text });
        break;
      case "text": {
        const gap = afterTool.current && now.reply ? "\n\n" : "";
        afterTool.current = false;
        setTurn({ ...now, reply: now.reply + gap + event.data.text });
        break;
      }
      case "tool_start":
        afterTool.current = true;
        setTurn({ ...now, actions: [...now.actions, { id: event.data.id, name: event.data.name, ok: true, summary: "Working…", running: true }] });
        break;
      case "tool_result": {
        const { id, name, ok, summary, view } = event.data;
        const found = now.actions.some((action) => action.id === id);
        const next: Action = { id, name, ok, summary, view };
        const actions = found ? now.actions.map((action) => (action.id === id ? { ...action, ...next, running: false } : action)) : [...now.actions, next];
        setTurn({ ...now, actions, plan: view?.plan ?? now.plan });
        if (view?.touched?.length) onTouched?.(view.touched);
        break;
      }
      case "tool_request":
        pending.requests.push(event.data);
        break;
      case "approval_request":
      case "input_request":
        break;
      case "done":
        pending.done = { status: event.data.status, reason: event.data.reason };
        setTurn({ ...now, status: event.data.status, pause_reason: event.data.reason ?? null, error: event.data.error, credits: event.data.credits });
        break;
    }
    scrollDown();
  };

  const runBrowserTools = async (requests: ToolRequest[]): Promise<BrowserResult[]> => {
    const results: BrowserResult[] = [];
    for (const request of requests) {
      try {
        const answer = await runTool(request);
        results.push({ tool_use_id: request.id, ...answer });
        if (answer.images?.length) {
          const urls = answer.images.map((jpeg) => `data:image/jpeg;base64,${jpeg}`);
          setImagesByTool((all) => ({ ...all, [request.id]: urls }));
        }
      } catch (error) {
        console.error("[assistant] tool", request.name, error);
        results.push({ tool_use_id: request.id, error: ((error as Error).message || "The editor could not do this.").slice(0, 300) });
      }
    }
    return results;
  };

  /**
   * Chạy một lượt tới khi nó cần người: stream đầu; mỗi lần Assistant cần tab
   * thì chạy tool rồi gửi lại; request chạm trần thời gian thì nối tiếp luôn.
   * Thẻ duyệt, câu hỏi, gia hạn credit thì dừng — panel vẽ thẻ từ server.
   */
  const drive = async (start: (handler: (event: AssistantEvent) => void) => Promise<void>, sessionId: string) => {
    let pending: Pending = { requests: [], done: null };
    await start(onEvent(pending));
    for (;;) {
      const current = pending;
      pending = { requests: [], done: null };
      // Chỉ khi lượt chờ ĐÚNG tab: cùng bước có câu hỏi/thẻ duyệt thì gửi kết
      // quả tool tab bây giờ là câu hỏi thành "bỏ qua", thẻ thành Cancel.
      if (current.requests.length && current.done?.status === "awaiting_browser") {
        const results = await runBrowserTools(current.requests);
        await client.results(sessionId, results, onEvent(pending));
      } else if (current.done?.status === "awaiting_continue" && current.done.reason === "time") {
        await client.continue(sessionId, false, onEvent(pending));
      } else {
        break;
      }
    }
  };

  // Lượt mới nhất: `finish` của một lượt CŨ (Approve/Cancel rồi gửi ngay câu mới) không
  // được mở khoá panel giữa lượt mới — nếu không, tự nối thấy panel rảnh và gửi kết quả
  // tool lần hai (409 "could not continue", đã gặp ở e2e save_frame).
  const runs = useRef(0);
  const begin = () => ++runs.current;

  // Đọc lại phiên TRƯỚC khi mở khoá: thẻ duyệt/câu hỏi cần `pending` của server.
  const finish = async (run: number) => {
    await refresh(model, session?.id);
    if (run !== runs.current) return;
    setTurn(null);
    onBusy(false);
    scrollDown();
  };

  const liveTurn = (prompt: string): LiveTurn => ({
    number: 0,
    prompt,
    status: "running",
    error: null,
    reply: "",
    actions: [],
    pending: [],
    credits: null,
    can_undo: false,
    undone: false,
    created_at: new Date().toISOString(),
  });

  const send = async (prompt: string) => {
    const text = prompt.trim();
    if (!text || busy) return;
    const run = begin();
    onBusy(true);
    setDraft("");
    afterTool.current = false;
    setTurn(liveTurn(text));
    scrollDown();
    try {
      const attachments: Attachments = {};
      if (attach.playhead) attachments.playhead = context.playhead();
      if (attach.selection && context.selection().length) attachments.selection = context.selection();
      if (voice) attachments.voice = voice;
      if (attach.frame) {
        // Chụp hỏng thì gửi câu lệnh không kèm khung, không chặn cả câu.
        const frame = await context.frame().catch(() => "");
        if (frame) attachments.frame = frame;
      }
      const current = session ?? (await client.open(model));
      setSession(current);
      await drive((handler) => client.turn(current.id, text, Object.keys(attachments).length ? attachments : undefined, handler), current.id);
      setAttach({ frame: false, playhead: false, selection: false });
    } catch (error) {
      notify(`The assistant could not start. ${(error as Error).message}`);
      setDraft(text);
    } finally {
      await finish(run);
    }
  };

  /** Chạy tiếp một lượt đang chờ tab/người: `start` là lời gọi gửi câu trả lời. */
  const proceed = async (turn: TurnView, start: (sessionId: string, handler: (event: AssistantEvent) => void) => Promise<void>) => {
    if (!session || busy) return;
    const run = begin();
    onBusy(true);
    afterTool.current = true;
    setTurn({ ...turn, status: "running", pending: [] });
    try {
      await drive((handler) => start(session.id, handler), session.id);
    } catch (error) {
      notify(`The assistant could not continue. ${(error as Error).message}`);
    } finally {
      await finish(run);
    }
  };

  const resume = (turn: TurnView) =>
    proceed(turn, async (id, handler) => {
      if (turn.status === "awaiting_continue") return client.continue(id, false, handler);
      const results = await runBrowserTools(turn.pending);
      return client.results(id, results, handler);
    });
  /** Tool tab của cùng bước (không có thẻ): chạy và gửi CÙNG câu trả lời của người. */
  const browserResults = (turn: TurnView) => runBrowserTools(turn.pending.filter((request) => !request.card));
  const decide = (turn: TurnView, approved: boolean) =>
    proceed(turn, async (id, handler) => {
      const tools = await browserResults(turn);
      const decisions = turn.pending.filter((request) => isApproval(request.card)).map((request) => ({ tool_use_id: request.id, approved }));
      return client.results(id, [...tools, ...decisions], handler);
    });
  const answer = (turn: TurnView, request: ToolRequest, reply: BrowserResult["answer"]) =>
    proceed(turn, async (id, handler) => {
      const tools = await browserResults(turn);
      // Thẻ duyệt cùng bước (hiếm) mà chưa bấm: coi như Cancel — không bao giờ tự tiêu credit.
      const approvals = turn.pending.filter((item) => isApproval(item.card)).map((item) => ({ tool_use_id: item.id, approved: false }));
      return client.results(id, [...tools, ...approvals, { tool_use_id: request.id, answer: reply }], handler);
    });
  const extend = (turn: TurnView) => proceed(turn, (id, handler) => client.continue(id, true, handler));

  const stop = async () => {
    if (!session) return;
    try {
      await client.stop(session.id);
      if (!busy) await refresh(model, session.id);
    } catch (error) {
      notify(`Could not stop the assistant. ${(error as Error).message}`);
    }
  };

  const undo = async (turn: TurnView) => {
    if (!session || undoing !== null) return;
    setUndoing(turn.number);
    try {
      await client.undo(session.id, turn.number);
      notify("Undid the assistant's changes.");
      await refresh(model, session.id);
    } catch (error) {
      notify(`Could not undo. ${(error as Error).message}`);
    } finally {
      setUndoing(null);
    }
  };

  const newChat = async () => {
    if (busy) return;
    try {
      const fresh = await client.open(model, true);
      setSession(fresh);
      setHistoryOpen(false);
    } catch (error) {
      notify(`Could not start a new chat. ${(error as Error).message}`);
    }
  };

  const pickModel = async (next: string) => {
    saveModel(next);
    setModel(next);
    await refresh(next);
  };

  const openSession = async (summary: SessionSummary) => {
    setHistoryOpen(false);
    if (summary.model !== model) saveModel(summary.model);
    await refresh(summary.model, summary.id);
  };

  // Lượt mà panel KHÔNG cầm stream (tải lại trang, mở lại tab, request đứt):
  // - đang chạy trên server → đọc lại mỗi 3 s để thanh "đang làm" và kết quả hiện ra;
  // - chờ tab (tool tab, hết trần thời gian một request) → tự nối, không bắt bấm
  //   Continue. Mỗi trạng thái chỉ tự nối MỘT lần: lỗi lặp thì nút Continue vẫn còn.
  const lastTurn = session?.turns.at(-1);
  const autoResumed = useRef("");
  useEffect(() => {
    if (busy || live || !session || !lastTurn) return;
    if (lastTurn.status === "running") {
      const timer = setTimeout(() => void refresh(model, session.id), 3000);
      return () => clearTimeout(timer);
    }
    const waitsForTab =
      (lastTurn.status === "awaiting_browser" && !lastTurn.pending.some((request) => request.card)) ||
      (lastTurn.status === "awaiting_continue" && lastTurn.pause_reason === "time");
    const key = `${session.id}:${lastTurn.number}:${lastTurn.status}:${lastTurn.pending.length}`;
    if (waitsForTab && autoResumed.current !== key) {
      autoResumed.current = key;
      void resume(lastTurn);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chạy lại theo lượt cuối, không theo mọi hàm
  }, [busy, live, session, lastTurn, model, refresh]);

  const turns: LiveTurn[] = [
    ...(session?.turns ?? []).filter((turn) => !live || turn.number !== live.number || live.number === 0),
    ...(live ? [live] : []),
  ];

  if (available === false) {
    return (
      <section className="ed2-asst" data-testid="assistant-panel">
        <p className="ed2-muted ed2-trn-note">The assistant isn&apos;t available on this server yet.</p>
      </section>
    );
  }

  const selection = context.selection();
  return (
    <section className="ed2-asst" data-testid="assistant-panel">
      <header className="ed2-asst-head">
        <span className="ed2-asst-title">
          <span aria-hidden className="ed2-asst-mark">
            ✦
          </span>
          Assistant
        </span>
        {models.length > 1 ? (
          <select
            className="ed2-asst-model"
            aria-label="Model"
            data-testid="assistant-model"
            value={model ?? ""}
            disabled={busy}
            onChange={(event) => void pickModel(event.target.value)}
          >
            {models.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="ed2-muted ed2-asst-model">{models[0]?.label ?? ""}</span>
        )}
        <span className="ed2-grow" />
        <div className="ed2-asst-history">
          <button type="button" className="ed2-icon" aria-label="Chat history" title="Chat history" data-testid="assistant-history" disabled={busy || !sessions.length} onClick={() => setHistoryOpen((open) => !open)}>
            ⏱
          </button>
          {historyOpen ? (
            <ul className="ed2-menu ed2-asst-history-list" role="menu">
              {sessions.map((item) => (
                <li key={item.id}>
                  <button type="button" role="menuitem" className={`ed2-menu-item${item.id === session?.id ? " is-active" : ""}`} onClick={() => void openSession(item)}>
                    <span className="ed2-asst-history-title">{item.title}</span>
                    <span className="ed2-menu-key">{new Date(item.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <button type="button" className="ed2-icon" aria-label="New chat" title="New chat" data-testid="assistant-new" disabled={busy || !session?.turns.length} onClick={() => void newChat()}>
          ＋
        </button>
      </header>
      <div ref={list} className="ed2-asst-list">
        {!turns.length ? (
          <div className="ed2-asst-empty">
            <p className="ed2-asst-empty-title">What should we do with this clip?</p>
            <p className="ed2-muted">
              The assistant cuts, adds titles and B-roll, animates, and checks the result frame by frame. Every request can be undone in one
              click.
            </p>
            {(broll ? [...EXAMPLES, BROLL_EXAMPLE] : EXAMPLES).map((example) => (
              <button key={example} type="button" className="ed2-asst-example" disabled={busy || available === null} onClick={() => void send(example)}>
                {example}
              </button>
            ))}
          </div>
        ) : null}
        {turns.map((turn) => (
          <Turn
            key={`${turn.number}-${turn.created_at}`}
            turn={turn}
            busy={busy}
            live={turn === live}
            images={imagesByTool}
            undoing={undoing}
            onUndo={() => void undo(turn)}
            onResume={() => void resume(turn)}
            onDecide={(approved) => void decide(turn, approved)}
            onAnswer={(request, reply) => void answer(turn, request, reply)}
            onExtend={() => void extend(turn)}
            onStop={() => void stop()}
          />
        ))}
      </div>
      <form
        className="ed2-asst-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <div className="ed2-asst-chips" role="group" aria-label="Attach">
          <VoicePicker value={voice} onChange={setVoice} disabled={busy} />
          <Chip on={attach.frame} label="Current frame" testid="assistant-attach-frame" onToggle={() => setAttach((all) => ({ ...all, frame: !all.frame }))} />
          <Chip on={attach.playhead} label="Playhead" testid="assistant-attach-playhead" onToggle={() => setAttach((all) => ({ ...all, playhead: !all.playhead }))} />
          {selection.length ? (
            <Chip
              on={attach.selection}
              label={`Selection (${selection.length})`}
              testid="assistant-attach-selection"
              onToggle={() => setAttach((all) => ({ ...all, selection: !all.selection }))}
            />
          ) : null}
        </div>
        <div className="ed2-asst-compose">
          <textarea
            ref={input}
            className="ed2-asst-input"
            placeholder="Ask for an edit, e.g. “cut the pauses, add a hook and B-roll”"
            value={draft}
            rows={2}
            maxLength={4000}
            disabled={busy}
            aria-label="Message the assistant"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Phím trong ô chat là của ô chat, không phải phím tắt của canvas.
              event.stopPropagation();
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
          />
          {busy ? (
            <button type="button" className="ed2-asst-send is-stop" aria-label="Stop" title="Stop" data-testid="assistant-stop" onClick={() => void stop()}>
              <span aria-hidden>■</span>
            </button>
          ) : (
            <button type="submit" className="ed2-asst-send" aria-label="Send" title="Send (Enter)" disabled={!draft.trim()} data-testid="assistant-send">
              <span aria-hidden>↑</span>
            </button>
          )}
        </div>
        <p className="ed2-asst-hint">Enter to send · Shift+Enter for a new line · Credits are charged for what it uses</p>
      </form>
    </section>
  );
}

function Chip({ on, label, testid, onToggle }: { on: boolean; label: string; testid: string; onToggle: () => void }) {
  return (
    <button type="button" className={`ed2-asst-chip${on ? " is-on" : ""}`} aria-pressed={on} data-testid={testid} onClick={onToggle}>
      {on ? "✓ " : "+ "}
      {label}
    </button>
  );
}

function Turn({
  turn,
  busy,
  live,
  images,
  undoing,
  onUndo,
  onResume,
  onDecide,
  onAnswer,
  onExtend,
  onStop,
}: {
  turn: LiveTurn;
  busy: boolean;
  live: boolean;
  images: Record<string, string[]>;
  undoing: number | null;
  onUndo: () => void;
  onResume: () => void;
  onDecide: (approved: boolean) => void;
  onAnswer: (request: ToolRequest, reply: BrowserResult["answer"]) => void;
  onExtend: () => void;
  onStop: () => void;
}) {
  const question = turn.pending.find((request) => isQuestion(request.card));
  const approvals = turn.pending.filter((request) => isApproval(request.card));
  // Dòng tool: bỏ plan (vẽ thành checklist) và câu hỏi (vẽ thành thẻ).
  const actions = turn.actions.filter((action) => action.name !== "update_plan" && action.name !== "ask_user");
  const asked = turn.actions.filter((action) => action.name === "ask_user");
  return (
    <div className="ed2-asst-turn" data-testid="assistant-turn" data-status={turn.status}>
      <div className="ed2-asst-prompt">{turn.prompt}</div>
      {turn.plan?.length ? <Plan items={turn.plan} /> : null}
      {live && turn.thinking ? (
        <details className="ed2-asst-thinking">
          <summary>{turn.status === "running" && !turn.reply ? "Thinking…" : "Thinking"}</summary>
          <p>{turn.thinking.slice(-2000)}</p>
        </details>
      ) : null}
      {actions.length ? (
        <ul className="ed2-asst-actions">
          {actions.map((action, index) => (
            <ToolRow key={action.id ?? index} action={action} images={action.id ? images[action.id] : undefined} />
          ))}
        </ul>
      ) : null}
      {asked.map((action, index) => (
        <p key={index} className="ed2-asst-answered">
          {action.summary}
        </p>
      ))}
      {turn.reply ? (
        <div data-testid="assistant-reply">
          <Markdown text={turn.reply} className="ed2-asst-reply" />
        </div>
      ) : null}
      {turn.status === "running" ? <WorkingBar turn={turn} live={live} onStop={onStop} /> : null}
      {turn.error ? <p className="ed2-error ed2-wrap-text">{turn.error}</p> : null}
      {turn.status === "awaiting_input" && question && !busy ? (
        <Question card={question.card as QuestionCard} onAnswer={(reply) => onAnswer(question, reply)} />
      ) : null}
      {turn.status === "awaiting_approval" && !busy && approvals.length ? (
        <div className="ed2-asst-approval" data-testid="assistant-approval">
          {/* Nhiều lượt sinh (B-roll) thì danh sách dài: cuộn trong thẻ, tổng + nút luôn thấy. */}
          <div className="ed2-asst-approval-list">
            {approvals.flatMap((request) => (request.card as ApprovalCard).changes).map((change, index) => (
              <p key={index}>{change}</p>
            ))}
          </div>
          {approvals.length > 1 && approvals.some((request) => (request.card as ApprovalCard).credits) ? (
            <p className="ed2-asst-total" data-testid="assistant-approval-total">
              Total: {approvals.reduce((sum, request) => sum + ((request.card as ApprovalCard).credits ?? 0), 0)} credits
            </p>
          ) : null}
          <div className="ed2-row">
            <button type="button" className="ed2-btn ed2-primary" data-testid="assistant-approve" onClick={() => onDecide(true)}>
              Approve
            </button>
            <button type="button" className="ed2-btn" onClick={() => onDecide(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {turn.status === "awaiting_continue" && turn.pause_reason === "budget" && !busy ? (
        <div className="ed2-asst-approval" data-testid="assistant-budget">
          <p>
            This request has used {turn.credits ?? "its"} credits, the most one request spends on its own. Keep going for up to 10 more?
          </p>
          <div className="ed2-row">
            <button type="button" className="ed2-btn ed2-primary" data-testid="assistant-extend" onClick={onExtend}>
              Continue
            </button>
            <button type="button" className="ed2-btn" onClick={onStop}>
              Stop here
            </button>
          </div>
        </div>
      ) : null}
      <div className="ed2-row ed2-asst-meta">
        {turn.status === "stopped" ? <span>Stopped</span> : null}
        {(turn.status === "awaiting_browser" || (turn.status === "awaiting_continue" && turn.pause_reason === "time")) && !busy ? (
          <>
            <span>Paused</span>
            <button type="button" className="ed2-link" data-testid="assistant-resume" onClick={onResume}>
              Continue
            </button>
          </>
        ) : null}
        {turn.credits !== null && turn.status !== "running" ? (
          <span>
            {turn.credits} {turn.credits === 1 ? "credit" : "credits"}
          </span>
        ) : null}
        {turn.undone ? <span>Undone</span> : null}
        <span className="ed2-grow" />
        {turn.can_undo ? (
          <button type="button" className="ed2-link" data-testid="assistant-undo" disabled={undoing !== null || busy} onClick={onUndo}>
            {undoing === turn.number ? "Undoing…" : "Undo"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Plan({ items }: { items: PlanItem[] }) {
  return (
    <ol className="ed2-asst-plan" data-testid="assistant-plan">
      {items.map((item, index) => (
        <li key={index} className={`is-${item.status}`}>
          <span aria-hidden>{item.status === "done" ? "✓" : item.status === "active" ? "›" : "○"}</span> {item.text}
        </li>
      ))}
    </ol>
  );
}

function ToolRow({ action, images }: { action: Action; images?: string[] }) {
  const [open, setOpen] = useState(false);
  const hasDetail = action.input !== undefined || Boolean(images?.length);
  return (
    <li className={action.ok ? "" : "is-failed"} data-ok={action.ok} data-testid="assistant-action">
      <button type="button" className="ed2-asst-tool" aria-expanded={open} disabled={!hasDetail} onClick={() => setOpen((value) => !value)}>
        <span aria-hidden className="ed2-asst-tool-icon">
          {action.running ? "◌" : action.ok ? "✓" : "✕"}
        </span>
        <span className="ed2-grow">{action.summary}</span>
        {images?.length ? <span className="ed2-muted">🖼</span> : null}
      </button>
      {images?.length && !open ? (
        <div className="ed2-asst-frames" data-testid="assistant-frames">
          {images.map((src, index) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={index} src={src} alt="What the assistant looked at" />
          ))}
        </div>
      ) : null}
      {action.view?.exports?.length ? (
        <ul className="ed2-asst-exports" data-testid="assistant-exports">
          {action.view.exports.map((item) => <ExportRow key={item.task_id} frame={item.frame} taskId={item.task_id} />)}
        </ul>
      ) : null}
      {open ? (
        <div className="ed2-asst-tool-detail">
          <code>{action.name}</code>
          {action.input !== undefined ? <pre>{JSON.stringify(action.input, null, 2).slice(0, 2000)}</pre> : null}
          {images?.map((src, index) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={index} src={src} alt="What the assistant looked at" />
          ))}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Một bản `request_export`: đọc task tới khi xong rồi hiện Download. Link về route
 * ký lại mỗi lần bấm (URL ký sẵn chỉ sống 5 phút), như nút Export của editor.
 */
function ExportRow({ frame, taskId }: { frame: string; taskId: string }) {
  const [task, setTask] = useState<Pick<RenderTask, "status" | "error" | "progress">>({ status: "queued", error: null, progress: null });
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await api<RenderTask>(`/tasks/${encodeURIComponent(taskId)}`);
        if (stop) return;
        setTask(next);
        if (next.status === "done" || next.status === "failed" || next.status === "cancelled") return;
      } catch {
        // Mạng chập chờn: thử lại lượt sau, task vẫn chạy trên server.
      }
      if (!stop) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskId]);
  return (
    <li data-status={task.status}>
      <span className="ed2-grow">{frame}</span>
      {task.status === "done" ? (
        <a className="ed2-btn ed2-primary" href={`/api/v1/tasks/${encodeURIComponent(taskId)}/file`} data-testid="assistant-export-download">
          Download
        </a>
      ) : task.status === "failed" || task.status === "cancelled" ? (
        <span className="ed2-error">{task.error ?? "The export failed. Try again."}</span>
      ) : (
        <span className="ed2-muted">{task.status === "running" && typeof task.progress === "number" ? `Rendering ${Math.round(task.progress * 100)}%` : task.status === "running" ? "Rendering…" : "Waiting to render…"}</span>
      )}
    </li>
  );
}

function Question({ card, onAnswer }: { card: QuestionCard; onAnswer: (reply: BrowserResult["answer"]) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const toggle = (option: string) =>
    setPicked((all) => (card.multi ? (all.includes(option) ? all.filter((item) => item !== option) : [...all, option]) : [option]));
  const ready = picked.length > 0 || other.trim().length > 0;
  return (
    <div className="ed2-asst-question" data-testid="assistant-question">
      <Markdown text={card.question} className="ed2-asst-question-text" />
      {card.options.length ? (
        <div className="ed2-asst-options">
          {card.options.map((option) => (
            <button
              key={option}
              type="button"
              className={`ed2-asst-option${picked.includes(option) ? " is-on" : ""}`}
              aria-pressed={picked.includes(option)}
              onClick={() => (card.multi ? toggle(option) : onAnswer({ choices: [option] }))}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <input
        className="ed2-input"
        placeholder={card.options.length ? "Other…" : "Your answer"}
        value={other}
        maxLength={2000}
        aria-label="Your answer"
        onChange={(event) => setOther(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && ready) onAnswer({ choices: picked, text: other.trim() });
        }}
      />
      <div className="ed2-row">
        <button type="button" className="ed2-btn ed2-primary" data-testid="assistant-answer" disabled={!ready} onClick={() => onAnswer({ choices: picked, text: other.trim() })}>
          Answer
        </button>
        <button type="button" className="ed2-btn" onClick={() => onAnswer({ skipped: true })}>
          Skip
        </button>
      </div>
    </div>
  );
}

/** Việc agent đang làm, suy ra từ sự kiện SSE mới nhất. */
function activityOf(event: AssistantEvent, previous: Activity | undefined): Activity | undefined {
  switch (event.event) {
    case "thinking":
      return { kind: "thinking" };
    case "text":
      return { kind: "writing" };
    case "tool_start":
      return { kind: "tool", tool: event.data.name };
    case "tool_result":
      // Tool xong: model đọc kết quả và nghĩ bước sau — giữa hai bước không có sự kiện nào.
      return { kind: "waiting" };
    default:
      return previous;
  }
}

const TOOL_LABELS: Record<string, string> = {
  preview_3d: "Rendering a 3D preview",
  add_3d_scene: "Preparing the 3D scene",
  capture_frames: "Looking at frames",
  check: "Checking the edit",
  read_guide: "Reading the guide",
  get_document: "Reading the project",
  get_transcript: "Reading the transcript",
  update_plan: "Planning",
  generate_media: "Preparing media",
  add_voiceover: "Preparing the voiceover",
  add_captions: "Creating captions",
  translate_captions: "Translating the captions",
  media_waveform: "Listening to the audio",
  media_grab: "Looking at the source video",
  inspect_color: "Measuring the color",
  apply_color: "Grading the color",
  save_frame: "Saving a frame",
  read_skill: "Reading your saved skill",
  save_skill: "Saving your skill",
  clean_audio: "Cleaning up the sound",
};

const toolLabel = (name: string) => TOOL_LABELS[name] ?? `Running ${name.replace(/_/g, " ")}`;

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Sau ngần này không có sự kiện, nói rõ là vẫn đang chạy (model lớn nghĩ cả phút). */
const QUIET_MS = 20_000;

/**
 * Thanh "đang làm" của lượt đang chạy: việc hiện tại, đồng hồ, nút Stop.
 * Người dùng từng không biết agent còn chạy hay đã treo (02/10) — giữa hai bước
 * Gemini Pro im lặng tới 1–2 phút.
 */
function WorkingBar({ turn, live, onStop }: { turn: LiveTurn; live: boolean; onStop: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const started = Date.parse(turn.created_at) || now;
  const running = turn.actions.find((action) => action.running);
  const activity = turn.activity;
  const label = !live
    ? "Working on the server…"
    : running
      ? `${toolLabel(running.name)}…`
      : activity?.kind === "tool" && activity.tool
        ? `${toolLabel(activity.tool)}…`
        : activity?.kind === "writing"
          ? "Writing the reply…"
          : activity?.kind === "thinking"
            ? "Thinking…"
            : activity?.kind === "waiting"
              ? "Deciding the next step…"
              : "Starting…";
  const quiet = live && turn.lastEvent !== undefined && now - turn.lastEvent > QUIET_MS;
  return (
    <div className="ed2-asst-working" role="status" aria-live="polite" data-testid="assistant-working">
      <span aria-hidden className="ed2-asst-spinner" />
      <span className="ed2-grow">
        <span className="ed2-asst-working-label">{label}</span>
        {quiet ? <span className="ed2-muted"> Still working, big steps can take a minute.</span> : null}
      </span>
      <span className="ed2-muted ed2-asst-working-clock">{clock(now - started)}</span>
      <button type="button" className="ed2-link" onClick={onStop}>
        Stop
      </button>
    </div>
  );
}
