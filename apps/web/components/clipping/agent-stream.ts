/**
 * Đọc SSE của một lượt Assistant (`lib/agent/sse.ts`): `event: X` / `data: JSON`.
 * Dùng chung cho Assistant trang project và CMO chat — editor có client riêng
 * vì nó còn phải đồng bộ document.
 */

import { ApiError } from "./api";

export async function readStream(response: Response, onEvent: (event: string, data: Record<string, unknown>) => void): Promise<void> {
  if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    let detail: unknown = null;
    try {
      detail = ((await response.json()) as { detail?: unknown }).detail;
    } catch {
      // Body không phải JSON.
    }
    throw new ApiError(typeof detail === "string" ? detail : "Something went wrong. Please try again.", response.status, detail);
  }
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const event = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (event && data !== undefined) onEvent(event, JSON.parse(data) as Record<string, unknown>);
    }
  }
}
