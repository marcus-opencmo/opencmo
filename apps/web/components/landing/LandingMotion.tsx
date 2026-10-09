"use client";

import { useEffect, useRef } from "react";

import { gsap, prefersReducedMotion, ScrollTrigger, startSmoothScroll } from "./motion";

/**
 * Vẽ ô sao 640px (nhiễu hạt + ~2.600 hạt sao + 14 sao sáng có quầng) rồi lát nó làm
 * nền cố định của cả trang: nội dung trượt bên trên như nhìn bầu trời đêm.
 * Vẽ bằng canvas lúc chạy thay vì một file ảnh: ~0 byte tải về.
 */
function paintSky(el: HTMLElement) {
  const S = 640, c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d");
  if (!x) return;
  let sd = 11;
  const r = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  const img = x.createImageData(S, S), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = r() * 14;
    d[i] = 3 + n; d[i + 1] = 5 + n; d[i + 2] = 15 + n * 1.3; d[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  const cols = ["255,255,255", "246,239,218", "190,205,255", "242,148,111"];
  for (let i = 0; i < 2600; i++) {
    const big = r() < 0.012, a = big ? 0.75 + r() * 0.25 : Math.pow(r(), 2.2) * 0.75;
    x.fillStyle = `rgba(${cols[r() < 0.72 ? 0 : Math.floor(r() * 4)]},${a})`;
    const sz = big ? 1.6 + r() : r() < 0.15 ? 1.1 : 0.7;
    x.fillRect(r() * S, r() * S, sz, sz);
  }
  for (let i = 0; i < 14; i++) {
    const px = r() * S, py = r() * S, g = x.createRadialGradient(px, py, 0, px, py, 5);
    g.addColorStop(0, "rgba(255,248,235,.9)");
    g.addColorStop(0.25, "rgba(255,230,210,.25)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = g;
    x.fillRect(px - 5, py - 5, 10, 10);
  }
  el.style.backgroundImage = `radial-gradient(80% 50% at 85% 0%, rgba(40,52,120,.28), transparent 70%), radial-gradient(60% 45% at 0% 55%, rgba(60,40,110,.18), transparent 70%), url(${c.toDataURL("image/png")})`;
  el.style.backgroundSize = `100% 100%, 100% 100%, ${S}px ${S}px`;
}

/** Nền sao + cuộn mượt + các hiệu ứng hiện khi cuộn tới dùng chung (`data-h`, `data-rise`, `data-slab`). */
export function LandingMotion() {
  const skyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    paintSky(skyRef.current!);
    const stopScroll = startSmoothScroll();
    const root = skyRef.current!.parentElement!;
    const reduced = prefersReducedMotion();
    const ctx = gsap.context(() => {
      if (reduced) return;
      const goals = root.querySelector("[data-goals]");
      if (goals) gsap.from(goals.querySelectorAll("[data-slab]"), { y: 160, rotateX: -38, opacity: 0, transformOrigin: "50% 100%", duration: 1.6, ease: "expo.out", stagger: 0.14, scrollTrigger: { trigger: goals, start: "top 85%" } });
      gsap.utils.toArray<HTMLElement>("[data-h]").forEach((el) => gsap.from(el, { yPercent: 105, duration: 1.4, ease: "expo.out", scrollTrigger: { trigger: el.parentElement, start: "top 88%" } }));
      ScrollTrigger.batch("[data-rise]", { start: "top 90%", onEnter: (els) => gsap.from(els, { y: 50, opacity: 0, duration: 1.2, ease: "expo.out", stagger: 0.08, overwrite: true }) });
    }, root);
    const refresh = setTimeout(() => ScrollTrigger.refresh(), 600);
    return () => {
      clearTimeout(refresh);
      ctx.revert();
      stopScroll();
    };
  }, []);

  return <div ref={skyRef} aria-hidden="true" className="lv-sky" />;
}
