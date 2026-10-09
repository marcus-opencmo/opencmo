/**
 * Hằng số của Assistant. Tách riêng để route, vòng lặp và check dùng chung một
 * chỗ — và để chỗ phải khớp với SQL nằm cạnh nhau.
 */

/** Model mặc định cho agent (spec AI Studio §6.3, spec agent-editor §3.6). */
export const AGENT_MODEL = "claude-opus-5";

/** Giữ trước mỗi lượt — phải TRÙNG `agent_hold_credits()` trong SQL. */
export const AGENT_HOLD_CREDITS = 5;

/** Mỗi lần người dùng gia hạn — phải TRÙNG `agent_extend_credits()` trong SQL. */
export const AGENT_EXTEND_CREDITS = 10;

/**
 * Phần giữ của lượt làm cảnh 3D (đã gọi preview_3d) — phải TRÙNG
 * `agent_3d_hold_credits()` trong SQL. Đo 01/10: Gemini Pro tiêu hết 5 credit sau
 * ~3 lần preview; vòng lặp tự nâng lên mức này trước khi phải hỏi người dùng.
 */
export const AGENT_3D_HOLD_CREDITS = 20;

/** Trần phần giữ một lượt tự gia hạn tới — phải TRÙNG `agent_auto_hold_cap()` trong SQL. */
export const AGENT_AUTO_HOLD_CAP = 60;

/**
 * Thời gian tối đa của MỘT request HTTP (không phải của lượt — lượt không có
 * trần bước, spec agent-editor §3.5). Dưới `maxDuration` của route (300s) một
 * khoảng đủ để tạm dừng gọn; tab gọi nối tiếp ngay sau đó.
 */
export const MAX_REQUEST_MS = 240_000;

/** Nhịp hỏi trạng thái lượt khi model đang nói — Stop cắt luồng trong chừng này. */
export const STOP_POLL_MS = 2_000;

/** Số tin nhắn có ảnh được gửi nguyên cho model; cũ hơn thì thay bằng chữ. */
export const KEEP_IMAGES = 2;

/** Trần output mỗi lần gọi; luôn streaming nên không lo timeout HTTP. */
export const MAX_TOKENS = 64_000;
