import * as Sentry from "@sentry/nextjs";

/**
 * Sentry phía server. Không có DSN thì không khởi tạo gì cả — nhờ vậy chạy local
 * và chạy CI không phải cấu hình thêm, và không có sự kiện rác nào được gửi đi.
 */
export function register() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    // Không lấy mẫu trace: ở giai đoạn này ta cần LỖI, không cần biểu đồ hiệu
    // năng — và mỗi trace là một phần hạn mức miễn phí bị tiêu.
    tracesSampleRate: 0,
  });
}

export const onRequestError = Sentry.captureRequestError;
