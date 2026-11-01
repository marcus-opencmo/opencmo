/**
 * Hằng số của Assistant. Tách riêng để route, vòng lặp và check dùng chung một
 * chỗ — và để chỗ phải khớp với SQL nằm cạnh nhau.
 */

/** Model mặc định cho agent (spec AI Studio §6.3, spec agent-editor §3.6). */
export const AGENT_MODEL = "claude-sonnet-5-5";

/** Giữ trước mỗi lượt — phải TRÙNG `agent_hold_credits()` trong SQL. */
export const AGENT_HOLD_CREDITS = 5;

/** Mỗi lần người dùng gia hạn — phải TRÙNG `agent_extend_credits()` trong SQL. */
export const AGENT_EXTEND_CREDITS = 10;

/**
 * The hold of a turn that previewed an explainer (`preview_explainer`; the name dates from the 3D
 * scenes, removed 2026-10-24) — must EQUAL `agent_3d_hold_credits()` in SQL. Measured 01/10: Gemini Pro
 * spent 5 credits in ~3 previews; the loop raises the hold to this before it asks the user.
 */
export const AGENT_3D_HOLD_CREDITS = 20;

/** Trần phần giữ một lượt tự gia hạn tới — phải TRÙNG `agent_auto_hold_cap()` trong SQL. */
export const AGENT_AUTO_HOLD_CAP = 60;

/**
 * Longest a single HTTP request may run (the turn itself has no time limit). It stays far enough
 * under the route's `maxDuration` (300 s) to pause cleanly; the tab continues right after.
 */
export const MAX_REQUEST_MS = 240_000;

/**
 * Model steps in one request before it pauses (`awaiting_continue`, 'steps') and the tab continues.
 * Credits and time already bound a turn; this also bounds a request whose steps are cheap and fast,
 * so a looping model surfaces between requests instead of spinning inside one.
 */
export const MAX_STEPS = 40;

/** The same tool call (same name and input) failing this many times in a row stops repeating it. */
export const MAX_REPEATED_FAILURES = 3;

/**
 * A plan that runs its own model calls (the /video director, the intro team) takes up to about three
 * minutes, after the request's time check. Started later than this, it would outlive the route's
 * 300 s limit and the turn would die mid-step; it waits for the next request instead.
 */
export const SLOW_PLAN_CUTOFF_MS = 110_000;
// wait_for_media waits up to a minute: started late, it would outlast the request too.
// preview_explainer renders stills for up to a minute (`previewMotion` times out at 60 s).
export const SLOW_PLANS = new Set(["create_video", "plan_video", "wait_for_media", "preview_explainer"]);

/** Nhịp hỏi trạng thái lượt khi model đang nói — Stop cắt luồng trong chừng này. */
export const STOP_POLL_MS = 2_000;

/** Số tin nhắn có ảnh được gửi nguyên cho model; cũ hơn thì thay bằng chữ. */
export const KEEP_IMAGES = 2;

/** Trần output mỗi lần gọi; luôn streaming nên không lo timeout HTTP. */
export const MAX_TOKENS = 64_000;
