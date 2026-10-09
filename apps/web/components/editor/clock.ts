/** Đồng hồ của playhead (`phút:giây.phần trăm giây`), dùng ở đầu timeline. */

import { FPS } from "@opencmo/clip-render";

export function clock(frames: number): string {
  const total = Math.max(0, frames) / FPS;
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  const hundredths = Math.floor((total % 1) * 100);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
}
