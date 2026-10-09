/**
 * Client của Assistant cho shell mới (`/api/v1/agent/*`): đọc phiên, gửi câu
 * lệnh và đọc Server-Sent Events, duyệt thẻ có giá, trả kết quả tool phía
 * trình duyệt, Stop, Undo.
 *
 * Mỗi lượt Assistant GHI document trên server; sau mỗi `project_changed` tab
 * nhận bản mới (`adopt`) — nên autosave không bao giờ đẩy bản cũ đè lên bài
 * của Assistant.
 */

import type { ClipDocument } from "@opencmo/clip-doc";

import type { DocumentSession } from "@/lib/editor/session";

export type ApprovalCard = { changes: string[]; credits?: number };
export type QuestionCard = { question: string; options: string[]; multi: boolean };
export type ToolRequest = { id: string; name: string; input: unknown; card?: ApprovalCard | QuestionCard };

export type TurnStatus =
  | "running"
  | "awaiting_browser"
  | "awaiting_approval"
  | "awaiting_input"
  | "awaiting_continue"
  | "done"
  | "failed"
  | "stopped";

export type PlanItem = { text: string; status: "pending" | "active" | "done" };

export type Action = {
  id?: string;
  name: string;
  ok: boolean;
  summary: string;
  /** Input của tool, đã rút gọn — dòng tool mở ra xem được, như DS. */
  input?: unknown;
  /** `exports`: bản `request_export` đã xếp hàng — panel theo dõi và hiện nút Download. */
  view?: { plan?: PlanItem[]; touched?: string[]; exports?: { frame: string; task_id: string }[] };
  /** Ảnh tab này vừa chụp cho tool đó (chỉ trong phiên đang mở). */
  images?: string[];
  running?: boolean;
};

/** Một lượt như server trả (`agent_turns` + hành động + tool đang chờ). */
export type TurnView = {
  number: number;
  created_at: string;
  prompt: string;
  reply: string;
  status: TurnStatus;
  /** `awaiting_continue`: 'time' (tab tự nối) hay 'budget' (người dùng gia hạn). */
  pause_reason?: string | null;
  error: string | null;
  credits: number | null;
  actions: Action[];
  plan?: PlanItem[] | null;
  /** Chờ tab này: tool tab, thẻ duyệt có giá, hay câu hỏi. */
  pending: ToolRequest[];
  can_undo: boolean;
  undone: boolean;
};

export type SessionView = { id: string; clip_id: string; model?: string; locked: boolean; turns: TurnView[] };
export type SessionSummary = { id: string; title: string; created_at: string; model: string };
export type ModelChoice = { id: string; label: string };
export type BrowserResult = {
  tool_use_id: string;
  images?: string[];
  data?: unknown;
  error?: string;
  approved?: boolean;
  answer?: { choices?: string[]; text?: string; skipped?: boolean };
};
export type Attachments = { playhead?: number; selection?: string[]; frame?: string; voice?: string };

export type AssistantEvent =
  | { event: "turn"; data: { number: number } }
  | { event: "text" | "thinking"; data: { text: string } }
  | { event: "tool_start"; data: { id: string; name: string } }
  | { event: "tool_result"; data: { id: string; name: string; ok: boolean; summary: string; view?: { plan?: PlanItem[]; touched?: string[] } } }
  | { event: "project_changed"; data: { version: number } }
  | { event: "tool_request" | "approval_request" | "input_request"; data: ToolRequest }
  | { event: "done"; data: { status: TurnStatus; reason?: string; credits: number | null; extend?: number; error: string | null } };

function messageOf(body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  const message = (detail as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message : "Something went wrong. Please try again.";
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/agent/${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(messageOf(body));
  return body as T;
}

export class AssistantClient {
  constructor(
    private clipId: string,
    private session: DocumentSession,
  ) {}

  /** Phiên mới nhất của model đã chọn, danh sách model bật được và lịch sử chat của clip. */
  load(model?: string, sessionId?: string) {
    const query = new URLSearchParams({ clip_id: this.clipId });
    if (model) query.set("model", model);
    if (sessionId) query.set("session_id", sessionId);
    return call<{
      available: boolean;
      model: string | null;
      models: ModelChoice[];
      broll?: boolean;
      sessions: SessionSummary[];
      session: SessionView | null;
    }>(`sessions?${query}`);
  }

  /** Mở phiên (của model đã chọn); `fresh` là "New chat": luôn một phiên mới. */
  open(model?: string, fresh = false) {
    return call<SessionView>("sessions", { method: "POST", body: JSON.stringify({ clip_id: this.clipId, model, new: fresh }) });
  }

  stop(sessionId: string) {
    return call<{ stopped: boolean }>(`sessions/${sessionId}/stop`, { method: "POST" });
  }

  /** Undo một lượt: server đưa project về checkpoint trước lượt; tab nhận bản đó. */
  async undo(sessionId: string, number: number): Promise<void> {
    await this.session.flush();
    const { project } = await call<{ project: { document: ClipDocument; version: number; document_hash?: string | null } }>(
      `sessions/${sessionId}/turns/${number}/undo`,
      { method: "POST" },
    );
    this.session.adopt(project.document, project.version, project.document_hash ?? null);
  }

  /** Gửi câu lệnh. Bài đang dở lên server TRƯỚC: Assistant đọc bản server giữ. */
  async turn(sessionId: string, prompt: string, attachments: Attachments | undefined, onEvent: (event: AssistantEvent) => void) {
    await this.session.flush();
    await this.stream(`sessions/${sessionId}/turns`, { prompt, attachments }, onEvent);
  }

  /** Nối tiếp lượt dừng giữa hai request; `extend` = người dùng duyệt giữ thêm credit. */
  continue(sessionId: string, extend: boolean, onEvent: (event: AssistantEvent) => void) {
    return this.stream(`sessions/${sessionId}/continue`, { extend }, onEvent);
  }

  approve(sessionId: string, decisions: { tool_use_id: string; approved: boolean }[], onEvent: (event: AssistantEvent) => void) {
    return this.stream(`sessions/${sessionId}/approvals`, { decisions }, onEvent);
  }

  results(sessionId: string, results: BrowserResult[], onEvent: (event: AssistantEvent) => void) {
    return this.stream(`sessions/${sessionId}/tool-results`, { results }, onEvent);
  }

  private async adoptLatest(): Promise<void> {
    const response = await fetch(`/api/v1/editor/document?clip_id=${encodeURIComponent(this.clipId)}`);
    if (!response.ok) return;
    const latest = (await response.json()) as { document: ClipDocument; version: number; document_hash?: string | null };
    this.session.adopt(latest.document, latest.version, latest.document_hash ?? null);
  }

  /** POST rồi đọc stream tới hết. Lỗi trước khi stream mở (thiếu credit…) ném câu của server. */
  private async stream(path: string, body: unknown, onEvent: (event: AssistantEvent) => void): Promise<void> {
    const response = await fetch(`/api/v1/agent/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      throw new Error(messageOf(await response.json().catch(() => null)));
    }
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    // Nhận bản mới theo thứ tự, không chồng hai lượt adopt lên nhau.
    let adopting: Promise<void> = Promise.resolve();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let at: number;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const name = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (!name || data === undefined) continue;
        const event = { event: name, data: JSON.parse(data) } as AssistantEvent;
        if (event.event === "project_changed") adopting = adopting.then(() => this.adoptLatest());
        onEvent(event);
      }
    }
    await adopting;
  }
}
