/**
 * Gọi API. Lỗi luôn thành `ApiError` mang câu tiếng Anh đọc được: cả FastAPI
 * (bản local) lẫn `withApi` (web) trả `detail` dạng chuỗi, riêng 409 của draft
 * trả `{ message, current }`.
 *
 * Product API duy nhất là `/api/v1` (Supabase).
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(message);
  }
}

const FALLBACK = "Something went wrong. Please try again.";

function messageOf(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object" && "message" in detail) {
    const message = (detail as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return FALLBACK;
}

async function call<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init, cache: "no-store",
      // Đọc không được treo mãi; mutation giữ nguyên để không khuyến khích gửi
      // lại một thao tác mà server có thể đã hoàn thành.
      signal: init?.signal ?? ((init?.method ?? "GET") === "GET" ? AbortSignal.timeout(20_000) : undefined),
    });
  } catch {
    throw new ApiError(
      "Connection lost. Check your internet and try again.",
      0,
      null,
    );
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Body rỗng hoặc không phải JSON; giữ null.
  }
  if (!res.ok) {
    const detail = (data as { detail?: unknown } | null)?.detail;
    throw new ApiError(messageOf(detail), res.status, detail);
  }
  return data as T;
}

export const WEB_BASE = "/api/v1";
/** Web: Supabase qua route handler. */
export const api = <T,>(path: string, init?: RequestInit): Promise<T> =>
  call<T>(WEB_BASE, path, init);

export type ApiFn = <T>(path: string, init?: RequestInit) => Promise<T>;

export function jsonBody(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
