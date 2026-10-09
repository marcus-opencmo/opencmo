/**
 * Một cửa cho mọi route của `/api/v1`.
 *
 * Mỗi route handler lo đúng phần việc của nó; năm thứ dưới đây thì không route
 * nào được tự làm, vì "quên một chỗ" là cách các lỗ hổng đi vào:
 *
 *   1. Đăng nhập — `getUser()`, KHÔNG phải `getSession()`. `getSession` đọc
 *      cookie và tin nó; cookie thì client sửa được. `getUser` hỏi Supabase và
 *      xác minh chữ ký.
 *   2. Cross-site cho method GHI — `Origin`/`Sec-Fetch-Site`. Cookie phiên là
 *      SameSite=Lax nên GET từ site khác không mang cookie, nhưng POST bằng form
 *      thì có; đây là rào CSRF cho mọi mutation của web API.
 *   3. Giới hạn body — đọc bao nhiêu byte thì dừng. Không có nó thì một request
 *      duy nhất kéo được cả RAM của function xuống.
 *   4. Rate limit — một lượt `rate_limit_hit()`, đếm trong database.
 *   5. Hình dạng lỗi — `{"detail": ...}` như bản local, và `Cache-Control:
 *      no-store` trên MỌI response (kể cả lỗi): đây là dữ liệu riêng của từng
 *      người, không được nằm lại trong cache dùng chung.
 */

import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";

import { createServerClient } from "../supabase/server";
import {
  ApiError,
  GENERIC_ERROR,
  NOT_SIGNED_IN,
  TOO_MANY,
  apiErrorFromPostgrest,
} from "./errors";

export { ApiError } from "./errors";

/** 256 KB. Settings của một revision nặng nhất cũng chỉ vài chục KB. */
export const MAX_BODY_BYTES = 256 * 1024;

export type SupabaseClient = Awaited<ReturnType<typeof createServerClient>>;

export type ApiContext<Body> = {
  request: NextRequest;
  supabase: SupabaseClient;
  user: { id: string; email?: string };
  body: Body;
  params: Record<string, string>;
};

export type RateLimit = { bucket: string; limit: number; windowSeconds: number };

export type ApiOptions<Schema extends z.ZodType | undefined> = {
  /** Mặc định true. Chỉ route công khai mới tắt. */
  auth?: boolean;
  body?: Schema;
  rateLimit?: RateLimit;
};

type Inferred<Schema> = Schema extends z.ZodType ? z.infer<Schema> : undefined;

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * Tham số động của route.
 *
 * `Promise<unknown>` chứ không phải `Promise<Record<string, string>>`: Next 15
 * sinh kiểu RIÊNG cho từng route (`{}` với route tĩnh, `{id: string}` với
 * `[id]`), và một kiểu cụ thể ở đây sẽ không khớp với route tĩnh.
 */
export type RouteContext = { params: Promise<unknown> };

export function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorResponse(status: number, detail: unknown): NextResponse {
  return jsonResponse({ detail }, status);
}

/**
 * Origin phải khớp host của chính request.
 *
 * `Sec-Fetch-Site: cross-site` là tín hiệu rõ nhất và trình duyệt tự đặt, client
 * không giả được. `Origin` là lưới thứ hai cho trình duyệt cũ. Thiếu cả hai
 * (curl, app native) thì cho qua: chúng không mang cookie của người dùng đi kèm
 * một cách vô tình — CSRF là vấn đề của trình duyệt.
 */
export function crossSite(request: NextRequest): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/** Đọc body có trần. Trả `undefined` khi không có body. */
async function readJson(request: NextRequest): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError(413, "That request is too large.");
  }
  const text = await request.text();
  // `content-length` có thể vắng mặt (chunked) — đo lại trên chuỗi thật.
  if (text.length > MAX_BODY_BYTES) {
    throw new ApiError(413, "That request is too large.");
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(422, "That request body isn't valid JSON.");
  }
}

/**
 * Lỗi zod → một câu tiếng Anh.
 *
 * Chỉ lấy issue ĐẦU TIÊN: danh sách đầy đủ có ích cho form nhiều ô, còn API này
 * nhận payload do chính UI của ta dựng — lỗi thứ hai gần như luôn là hệ quả của
 * lỗi thứ nhất.
 */
function zodMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "That request isn't valid.";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Thân thật của `withApi`, nhận sẵn client.
 *
 * Tách ra để `handler.check.ts` chạy được năm luật trên với một client giả:
 * `createServerClient` kéo theo `next/headers`, thứ chỉ tồn tại bên trong một
 * request thật của Next, nên không tách thì phần này không có cách nào kiểm.
 */
export async function handleApi<Schema extends z.ZodType | undefined = undefined>(
  options: ApiOptions<Schema>,
  handler: (context: ApiContext<Inferred<Schema>>) => Promise<NextResponse | unknown>,
  request: NextRequest,
  supabase: SupabaseClient,
  routeContext?: RouteContext,
): Promise<NextResponse> {
  {
    try {
      if (WRITE_METHODS.has(request.method) && crossSite(request)) {
        return errorResponse(403, "Cross-site access denied.");
      }

      let user: { id: string; email?: string } = { id: "" };

      if (options.auth !== false) {
        const { data, error } = await supabase.auth.getUser();
        if (error || !data.user) return errorResponse(401, NOT_SIGNED_IN);
        user = { id: data.user.id, email: data.user.email ?? undefined };
      }

      if (options.rateLimit) {
        const { bucket, limit, windowSeconds } = options.rateLimit;
        const { data, error } = await supabase.rpc("rate_limit_hit", {
          p_bucket: bucket,
          p_limit: limit,
          p_window_seconds: windowSeconds,
        });
        if (error) throw apiErrorFromPostgrest(error);
        if (data === false) return errorResponse(429, TOO_MANY);
      }

      let body: unknown = undefined;
      if (options.body) {
        const raw = await readJson(request);
        const parsed = options.body.safeParse(raw ?? {});
        if (!parsed.success) return errorResponse(422, zodMessage(parsed.error));
        body = parsed.data;
      }

      const params = ((await routeContext?.params) ?? {}) as Record<string, string>;
      const result = await handler({
        request,
        supabase,
        user,
        body: body as Inferred<Schema>,
        params,
      });

      if (result instanceof NextResponse) {
        result.headers.set("Cache-Control", "no-store");
        return result;
      }
      return jsonResponse(result ?? null);
    } catch (err) {
      if (err instanceof ApiError) {
        return errorResponse(err.status, err.detail ?? err.message);
      }
      // Lỗi PostgREST đi qua `rpcOrThrow`; tới đây là thứ ta chưa lường. Nguyên
      // văn chỉ vào log (tiếng Việt, của ta), client nhận câu chung.
      console.error("[api] lỗi không lường trước", err);
      return errorResponse(500, GENERIC_ERROR);
    }
  }
}

export function withApi<Schema extends z.ZodType | undefined = undefined>(
  options: ApiOptions<Schema>,
  handler: (context: ApiContext<Inferred<Schema>>) => Promise<NextResponse | unknown>,
) {
  return async (request: NextRequest, routeContext: RouteContext): Promise<NextResponse> =>
    handleApi(options, handler, request, await createServerClient(), routeContext);
}

/**
 * Gọi RPC, lỗi Postgres thành `ApiError` theo allowlist.
 *
 * Mọi route dùng hàm này thay vì tự đọc `error`: quên một chỗ là một câu lỗi
 * Postgres nguyên văn (kèm tên bảng) hiện lên màn hình người dùng.
 */
export async function rpcOrThrow<T>(
  supabase: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw apiErrorFromPostgrest(error);
  return data as T;
}

/**
 * Hàm SQL trả `setof`/composite: PostgREST đưa về object, nhưng tuỳ phiên bản
 * có thể bọc trong mảng. Nhận cả hai — bài học của `app/app/actions.ts`.
 */
export function firstRow<T>(data: T | T[] | null): T | null {
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

export function notFound(message = "Not found."): ApiError {
  return new ApiError(404, message);
}
