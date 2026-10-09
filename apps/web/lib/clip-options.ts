/**
 * Lựa chọn số clip và độ dài — module thường, KHÔNG "use client": trang server
 * `/app` cũng đọc để kiểm `?count=`/`?length=`, và import hằng số từ một file
 * "use client" ở server component chỉ nhận về một client reference.
 */

import type { ClipLength } from "./clipping-types";

/**
 * Chỉ những cấu hình engine thật sự dùng. Ngôn ngữ, tỷ lệ khung và kiểu phụ đề
 * chưa được pipeline nhận nên chưa có control — hiện ra mà không có tác dụng
 * là nói dối người dùng.
 */
export const CLIP_LENGTH_OPTIONS: { value: ClipLength; label: string }[] = [
  { value: "auto", label: "Auto · 10–60 sec" },
  { value: "short", label: "Short · 15–30 sec" },
  { value: "medium", label: "Medium · 30–60 sec" },
  { value: "long", label: "Long · 60–90 sec" },
];

export const CLIP_COUNTS = [1, 3, 5, 8, 10];
