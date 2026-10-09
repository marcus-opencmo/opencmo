"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

/**
 * GSAP + ScrollTrigger + Lenis cho landing. Chỉ landing import file này, nên ~70KB
 * gzip của ba thư viện không lọt vào bundle của /app.
 *
 * Lenis là một bản duy nhất cho cả trang: nav, footer và hero cùng cuộn bằng nó
 * (`scrollToId`), và ScrollTrigger phải nghe đúng bản đó, nếu không các section
 * ghim sẽ lệch nửa nhịp so với thanh cuộn.
 */
gsap.registerPlugin(ScrollTrigger);

export { gsap, ScrollTrigger };

let lenis: Lenis | null = null;
let users = 0;
const tick = (t: number) => lenis?.raf(t * 1000);

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Bật cuộn mượt; trả hàm tắt. Đếm người dùng để StrictMode mount hai lần không tạo hai bản. */
export function startSmoothScroll(): () => void {
  users += 1;
  if (!lenis && !prefersReducedMotion()) {
    lenis = new Lenis({ lerp: 0.085 });
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
  }
  return () => {
    users -= 1;
    if (users > 0 || !lenis) return;
    gsap.ticker.remove(tick);
    lenis.destroy();
    lenis = null;
  };
}

export function scrollToId(id: string): void {
  const target = id === "top" ? 0 : document.getElementById(id);
  if (target === null) return;
  if (lenis) {
    lenis.scrollTo(target, { duration: 1.6 });
    return;
  }
  const top = target === 0 ? 0 : target.getBoundingClientRect().top + window.scrollY;
  window.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

/** Click vào link `#id`: cuộn bằng Lenis thay vì nhảy, và vẫn giữ href cho máy đọc. */
export function onAnchorClick(id: string) {
  return (e: { preventDefault(): void }) => {
    e.preventDefault();
    scrollToId(id);
  };
}
