/**
 * Trần chữ đi kèm clip ngắn, từng nền tảng (W5). Cách viết nằm ở skill `short-video`
 * (`lib/cmo/skills/short-video.md`, H4); file này chỉ còn con số mà code kiểm.
 */

export type Platform = "tiktok" | "reels" | "shorts" | "facebook" | "threads";

/**
 * Trần ký tự cho từng chữ. Thấp hơn trần thật của nền tảng: phần hiện trước khi
 * bị "…more" mới là phần người xem đọc.
 */
export const VIDEO_LIMITS: Record<Platform, number> = {
  tiktok: 300,
  reels: 600,
  shorts: 100,
  facebook: 500,
  threads: 500,
};
