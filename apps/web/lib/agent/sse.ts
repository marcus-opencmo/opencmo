import { NextResponse } from "next/server";

import type { Emit } from "./loop";

/**
 * Response Server-Sent Events chạy `run` tới hết. Tab đóng giữa chừng thì
 * `run` VẪN chạy tới hết — trạng thái nằm trong DB, mở lại panel thấy đúng
 * kết quả — chỉ là không còn ai nghe event.
 */
export function sseResponse(run: (emit: Emit) => Promise<void>): NextResponse {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit: Emit = (event, payload) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };
      void run(emit).finally(() => {
        if (closed) return;
        closed = true;
        controller.close();
      });
    },
    cancel() {
      closed = true;
    },
  });
  return new NextResponse(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" },
  });
}
