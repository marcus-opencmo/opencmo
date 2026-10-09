/**
 * Lỗi Postgres → HTTP, bằng ALLOWLIST.
 *
 * Nguyên tắc: chỉ những câu do CHÍNH TA viết trong `raise exception` mới được đi
 * ra màn hình. Chúng đã qua vòng duyệt tiếng Anh (bảng ngôn ngữ ở đầu
 * CLAUDE.md) và không mang chi tiết nội bộ. Mọi thứ khác — vi phạm khoá ngoại,
 * lỗi kiểu, timeout — trả một câu chung, còn nguyên văn thì vào log.
 *
 * Cho mọi mã `P0*` đi thẳng ra là sai: `P0001` là mã mặc định của `raise` nên
 * bất kỳ extension hay trigger nào cũng dùng được nó, kể cả với câu tiếng Việt
 * hoặc tên bảng. Danh sách dưới đây là các mã ta cố ý đặt trong migration.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export const GENERIC_ERROR = "Something went wrong. Please try again.";
export const NOT_SIGNED_IN = "Please sign in again.";
export const TOO_MANY = "Too many requests. Try again in a minute.";

/** Hình dạng lỗi PostgREST trả về qua supabase-js. */
export type PostgrestLikeError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

// Mã → HTTP. Chỉ những mã này mới được phép mang `message` ra ngoài.
const STATUS_BY_CODE: Record<string, number> = {
  // `raise ... using errcode = '22023'` — tham số sai (invalid_parameter_value).
  "22023": 422,
  // Không tìm thấy, hoặc của người khác: cả hai đều là 404 để không lộ sự tồn tại.
  P0002: 404,
  // Xung đột revision (draft đã đổi ở tab khác). `detail` mang draft hiện hành.
  P0409: 409,
  // `raise` mặc định — ta dùng cho "làm được nhưng không phải lúc này".
  P0001: 409,
  // Chưa đăng nhập (require_user).
  "28000": 401,
  // unique_violation do ta chuyển thành câu tiếng Anh (ví dụ tên preset trùng).
  "23505": 409,
};

/**
 * `detail` của P0409 là JSON (draft hiện hành) do SQL gắn vào, không phải chuỗi
 * mô tả. Parse hỏng thì bỏ qua — UI vẫn có `message` để hiện.
 */
function conflictDetail(error: PostgrestLikeError): unknown {
  if (!error.details) return undefined;
  try {
    return JSON.parse(error.details);
  } catch {
    return undefined;
  }
}

export function apiErrorFromPostgrest(error: PostgrestLikeError): ApiError {
  const code = error.code ?? "";
  let status = STATUS_BY_CODE[code];

  // `P0001` mặc định là 409 ("làm được nhưng không phải lúc này"). Ba câu dưới
  // là chuyện khác hẳn — chúng là rate limit, và client cần 429 để biết là chờ
  // rồi thử lại chứ không phải sửa yêu cầu. So khớp NGUYÊN VĂN chứ không theo
  // tiền tố: `P0001` là mã mặc định của `raise`, bất kỳ trigger nào cũng dùng.
  if (
    code === "P0001" &&
    (error.message === "You have reached today's limit for this plan." ||
      error.message === "You have reached your storage limit for this plan." ||
      error.message === "Too many projects started. Please wait a while and try again." ||
      error.message === "Too many assistant requests. Try again in a few minutes." ||
      error.message === "You can rebuild your plan 5 times a day. Try again tomorrow, or edit the documents directly." ||
      error.message === "You have reached today's limit for this task. Try again tomorrow." ||
      error.message === "You can approve 5 posts for X a day. Try again tomorrow.")
  ) {
    status = 429;
  }

  if (status === undefined) {
    // Nguyên văn chỉ vào log — nó có thể chứa tên bảng, tên cột, hoặc một câu
    // tiếng Việt của extension nào đó.
    console.error("[api] lỗi Postgres không nằm trong allowlist", error);
    return new ApiError(500, GENERIC_ERROR);
  }

  let message = error.message?.trim() || GENERIC_ERROR;

  // `23505` nằm trong allowlist vì `save_brand_kit` cố ý ném nó kèm một câu tiếng
  // Anh đã duyệt. Nhưng Postgres cũng dùng đúng mã đó cho mọi vi phạm unique
  // KHÔNG do ta bắt, và câu của nó mang tên ràng buộc
  // ('duplicate key value violates unique constraint "tasks_request_id_key"').
  // Tên index nội bộ không phải thứ để đọc trên màn hình người dùng.
  if (code === "23505" && /^duplicate key value/i.test(message)) {
    console.error("[api] unique_violation không bắt được", error);
    message = "That already exists. Refresh the page and try again.";
  }
  if (code === "P0409") {
    return new ApiError(409, message, { message, current: conflictDetail(error) });
  }
  if (code === "28000") {
    return new ApiError(401, NOT_SIGNED_IN);
  }
  return new ApiError(status, message);
}
