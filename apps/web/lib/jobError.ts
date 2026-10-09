/**
 * Đổi lỗi thô của worker thành câu tiếng Anh người dùng đọc được.
 *
 * `jobs.error` được worker ghi bằng `f"{type(exc).__name__}: {exc}"`
 * (`modal_app.py`), tức là luôn mang hình dạng exception của Python. Trang kết
 * quả trước đây in thẳng cột đó ra, và ngày 12/9 người dùng nhận được:
 *
 *   HTTPStatusError: Client error '409 Conflict' for url
 *   'https://<ref>.supabase.co/rest/v1/clips'
 *
 * Hai lý do phải chặn, không chỉ vì xấu:
 *   1. Người dùng không làm được gì với chuỗi đó — nó không nói họ nên thử lại,
 *      đổi link, hay nạp thêm credit.
 *   2. Nó mang theo **URL dự án Supabase** ra màn hình người ngoài. Hạ tầng nội
 *      bộ không có việc gì phải xuất hiện trong giao diện người dùng.
 *
 * Lỗi thô vẫn nằm nguyên trong `jobs.error` và trong Sentry để ta đọc — chỉ là
 * nó dừng lại ở đó.
 *
 * Chuỗi trả về là tiếng Anh vì chúng hiện trong app. Xem bảng ngôn ngữ ở đầu
 * `CLAUDE.md`.
 */

export type JobFailure = {
  /** Chuyện gì đã xảy ra, viết cho người không biết gì về pipeline. */
  message: string;
  /** Làm gì tiếp. Rỗng khi thật sự không có việc gì người dùng làm được. */
  hint: string;
  /** Credit có được hoàn không — quyết định câu cuối của hộp lỗi. */
  refunded: boolean;
  /** Chỉ sang trang billing thay vì bảo thử link khác. */
  billing?: boolean;
};

/**
 * Ghép theo thứ tự: ca cụ thể trước, ca chung sau.
 *
 * Chuỗi khớp lấy từ chính chỗ ném lỗi trong engine (`steps/`, `media/ffmpeg.py`,
 * `backends/supabase.py`), không phải đoán. Thêm ca mới thì thêm ở đây, đừng
 * nới câu mặc định.
 */
const RULES: Array<{ match: RegExp; failure: Omit<JobFailure, "refunded"> }> = [
  {
    // `InsufficientCreditsError` được ghi bằng `str(exc)`, tức là câu này vốn
    // đã viết cho người dùng. Giữ nguyên ý, nhưng đổi hướng dẫn: bảo họ "thử
    // link khác" là sai, vấn đề là số dư.
    match: /not enough credits/i,
    failure: {
      message: "This video is longer than your remaining credits allow.",
      hint: "Top up, or try a shorter video.",
      billing: true,
    },
  },
  {
    match: /sign in to confirm|not a bot|age.?restricted|requires? (a )?login/i,
    failure: {
      message: "The video host refused to hand us this video.",
      hint: "Download it yourself and upload the file instead — that route always works.",
    },
  },
  {
    match: /private video|video unavailable|members.only|removed by the uploader/i,
    failure: {
      message: "This video is not publicly accessible.",
      hint: "Check that the link opens in a private browser window, then try again.",
    },
  },
  {
    match: /unsupported url|is not a valid url|no video formats found/i,
    failure: {
      message: "We could not read that link as a video.",
      hint: "Paste a direct link to the video page, or upload the file instead.",
    },
  },
  {
    match: /empty transcript|no speech|transcript/i,
    failure: {
      message: "We could not find any speech in this video.",
      hint: "OpenCMO cuts clips around what people say, so it needs a video with talking in it.",
    },
  },
  {
    match: /no video stream|no output file|could not read a duration|source is empty/i,
    failure: {
      message: "This file is not a video we can read.",
      hint: "Try MP4, MOV or WebM.",
    },
  },
];

const FALLBACK: Omit<JobFailure, "refunded"> = {
  message: "Something went wrong on our side.",
  // Không hứa "chúng tôi đã được báo" nếu chưa chắc — Sentry tự tắt khi thiếu
  // DSN, và một lời hứa sai ở màn hình lỗi là chỗ tệ nhất để nói dối. Cũng
  // không nhắc credit ở đây: dòng ngay dưới trong `FailureBox` đã nói rồi.
  hint: "Trying the same link again is worth a shot.",
};

export function explainJobError(raw: string | null | undefined): JobFailure {
  const text = (raw ?? "").trim();
  const rule = text ? RULES.find((r) => r.match.test(text)) : undefined;
  const base = rule?.failure ?? FALLBACK;

  return {
    ...base,
    // Job dừng vì thiếu credit đã được hoàn phần giữ tạm trong cùng giao dịch
    // của `settle_job_credits()` — nói "đã hoàn credit" ở đây là đúng nhưng gây
    // hiểu nhầm, vì cái họ thiếu vẫn thiếu.
    refunded: !base.billing,
  };
}
