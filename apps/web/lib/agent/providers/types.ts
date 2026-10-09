/**
 * Giao diện trung lập giữa vòng lặp Assistant và một nhà cung cấp model.
 *
 * Vòng lặp (tool, CAS, checkpoint, credit, SSE) chỉ nói bằng các kiểu ở đây.
 * Mỗi provider giữ lịch sử ở DẠNG NATIVE của nó — content block của Claude,
 * `parts` của Gemini kèm `thoughtSignature` — vì cả hai đều đòi gửi lại khối
 * suy nghĩ đúng như đã nhận. Không có chuyển đổi qua lại: phiên gắn với MỘT
 * model (`agent_open_session`).
 */

import type { ToolSpec } from "../tools";

/** Một tin nhắn đã lưu (`agent_messages`): vai trò trung lập, nội dung native. */
export type StoredMessage = { role: "user" | "assistant"; content: unknown[] };

export type ToolCall = { id: string; name: string; input: unknown };

export type StopReason = "end" | "tool" | "max_tokens" | "refusal";

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type Step = {
  /** Khối assistant NATIVE — lưu nguyên vào `agent_messages`. */
  content: unknown[];
  toolCalls: ToolCall[];
  stop: StopReason;
  usage: Usage;
  /** Model thật đã trả lời (có thể là model fallback). */
  model: string;
};

export type Delta =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; id: string; name: string };

/** Ảnh JPEG base64 (không có tiền tố data:). */
export type Image = { data: string; mimeType: "image/jpeg" };

export type ToolResult = {
  id: string;
  name: string;
  ok: boolean;
  /** Chuỗi JSON gửi model. */
  content: string;
  images?: Image[];
};

export type ProviderKind = "anthropic" | "gemini" | "fake";

/** Phần định dạng — không cần khoá API, nên `view.ts` dùng được để vẽ panel. */
export interface Format {
  kind: ProviderKind;
  /** Tin nhắn user đầu lượt: câu lệnh, rồi trạng thái project làm dữ liệu; ảnh đính kèm (khung đang xem) nếu có. */
  userTurn(prompt: string, state: string, images?: Image[]): unknown[];
  /** MỌI kết quả tool của một bước trong MỘT tin nhắn user (giữ tool song song). */
  toolResults(results: ToolResult[], state?: string): unknown[];
  /** Các tool call trong một tin nhắn assistant đã lưu, theo đúng thứ tự. */
  callsIn(content: unknown[]): ToolCall[];
  /** Chữ trả lời cho người đọc — không có thinking. */
  replyText(content: unknown[]): string;
  /**
   * Bản gửi đi của lịch sử: chỉ giữ ảnh của `keep` tin nhắn có ảnh gần nhất,
   * ảnh cũ thành một dòng chữ (spec agent-editor §5). Lịch sử trong DB giữ
   * nguyên; hàm KHÔNG sửa đầu vào. Cắt theo tin nhắn nên prefix cache chỉ vỡ
   * khi có ảnh mới.
   */
  trimImages(history: StoredMessage[], keep: number): StoredMessage[];
}

/** Một lần gọi model: lịch sử, bộ tool và system prompt của PHẠM VI phiên (clip hay project). */
export type StepRequest = {
  history: StoredMessage[];
  tools: ToolSpec[];
  system: string;
  /** Stop của người dùng cắt luồng đang chạy, không đợi model nói xong. */
  signal?: AbortSignal;
};

/** Chữ thay cho ảnh đã bỏ khỏi request. */
export const IMAGE_OMITTED = "[image omitted: already seen earlier in this conversation]";

export interface Provider extends Format {
  /** Id model ghi vào `agent_sessions.model`. */
  model: string;
  step(request: StepRequest, onDelta: (delta: Delta) => void): Promise<Step>;
  /** Câu tiếng Anh cho người dùng khi một lỗi của provider làm hỏng lượt. */
  failureMessage(error: unknown): string;
}
