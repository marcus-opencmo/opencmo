"use client";

import { useEffect, useRef } from "react";

import { BEATS } from "./data";
import { LineIcon } from "./Glyphs";
import { createHeroGraph, LABELS, ss } from "./hero-graph";
import { DEPT_ICON, SOCIAL, type SocialKey } from "./icons";
import { gsap, prefersReducedMotion, ScrollTrigger } from "./motion";

const DEPT_NAME = { video: "Video", post: "Post", sales: "Sales" } as const;

/**
 * Hero cao 340vh, phần nhìn thấy dính ở đỉnh màn hình: cuộn trong hero là "tua" đồ
 * thị (progress 0 → 1) và đổi ba đoạn chữ I · II · III. H1 và ô website nằm trong HTML
 * ngay từ đầu (SEO + không cần JS để bắt đầu); nhãn đồ thị là `aria-hidden`.
 */
export function Hero({ action, fineprint }: { action: string; fineprint: string }) {
  const heroRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const hero = heroRef.current!, canvas = canvasRef.current!, labelBox = labelsRef.current!;
    const reduced = prefersReducedMotion();
    const graph = createHeroGraph(canvas);
    const labelEls = Array.from(labelBox.children) as HTMLElement[];
    const ptr = { x: 0, y: 0, tx: 0, ty: 0 };
    let p = 0, raf = 0;
    const t0 = performance.now();

    const progress = () => {
      const r = hero.getBoundingClientRect();
      return Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - window.innerHeight)));
    };
    const loop = () => {
      raf = requestAnimationFrame(loop);
      // Qua khỏi hero thì ngừng vẽ: cảnh 11k điểm không có lý do chạy dưới footer.
      if (window.scrollY > hero.offsetHeight + 200) return;
      p += ((reduced ? 1 : progress()) - p) * 0.07;
      ptr.x += (ptr.tx - ptr.x) * 0.04;
      ptr.y += (ptr.ty - ptr.y) * 0.04;
      const screen = graph?.frame(p, ptr, (performance.now() - t0) / 1000);
      if (!screen) return;
      labelEls.forEach((el, i) => {
        const d = LABELS[i], at = screen.get(d.key);
        const o = at ? ss(d.from, d.from + 0.07, p) : 0;
        el.style.opacity = o.toFixed(3);
        if (at) el.style.transform = `translate(${at.x.toFixed(1)}px,${(at.y + d.dy).toFixed(1)}px) translate(-50%,-50%) scale(${(0.9 + 0.1 * o).toFixed(3)})`;
      });
    };
    const onPtr = (e: PointerEvent) => {
      ptr.tx = (e.clientX / window.innerWidth) * 2 - 1;
      ptr.ty = (e.clientY / window.innerHeight) * 2 - 1;
    };
    const onResize = () => graph?.resize();
    graph?.resize();
    loop();
    window.addEventListener("pointermove", onPtr);
    window.addEventListener("resize", onResize);

    const ctx = gsap.context(() => {
      gsap.from("[data-intro-line]", { yPercent: 110, duration: 1.6, ease: "expo.out", stagger: 0.12, delay: 0.35 });
      gsap.from("[data-intro]", { y: 30, opacity: 0, filter: "blur(8px)", duration: 1.4, ease: "expo.out", stagger: 0.1, delay: 0.6 });
      gsap.from(canvas, { opacity: 0, duration: 2.4, ease: "power2.out" });
      gsap.to(copyRef.current, { y: -80, opacity: 0, filter: "blur(6px)", ease: "none", scrollTrigger: { trigger: hero, start: "top top", end: "12% top", scrub: true } });
      gsap.to(barRef.current, { scaleY: 1, ease: "none", scrollTrigger: { trigger: hero, start: "top top", end: "bottom bottom", scrub: true } });
      const tl = gsap.timeline({ scrollTrigger: { trigger: hero, start: "10% top", end: "bottom bottom", scrub: 0.6 } });
      const beats = gsap.utils.toArray<HTMLElement>("[data-beat]");
      beats.forEach((el, i) => {
        tl.fromTo(el, { opacity: 0, y: 60, filter: "blur(10px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 1, ease: "power2.out" });
        if (i < beats.length - 1) tl.to(el, { opacity: 0, y: -60, filter: "blur(10px)", duration: 1, ease: "power2.in" }, "+=0.8");
        else tl.to({}, { duration: 0.6 });
      });
    }, hero);
    const refresh = setTimeout(() => ScrollTrigger.refresh(), 600);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(refresh);
      window.removeEventListener("pointermove", onPtr);
      window.removeEventListener("resize", onResize);
      ctx.revert();
      graph?.dispose();
    };
  }, []);

  return (
    <section id="top" ref={heroRef} className="lv-hero">
      <div className="lv-hero-stage">
        <canvas ref={canvasRef} aria-hidden="true" className="lv-hero-canvas" />
        <div aria-hidden="true" className="lv-hero-shade" />
        <div ref={labelsRef} aria-hidden="true" className="lv-hero-labels">
          {LABELS.map((d) => (
            <div key={d.key} className={`lv-node is-${d.kind}`}>
              {d.kind === "plat" ? (
                <span className="lv-node-tile" style={{ background: SOCIAL[d.key as SocialKey].color }}>
                  <svg viewBox="0 0 24 24" width="13" height="13"><path d={SOCIAL[d.key as SocialKey].d} fill="#fff" /></svg>
                </span>
              ) : (
                <LineIcon d={d.kind === "cmo" ? DEPT_ICON.cmo : DEPT_ICON[d.key as keyof typeof DEPT_NAME]} size={16} width={2} color={d.kind === "cmo" ? "#1a0d07" : "#f2946f"} />
              )}
              <span className="lv-node-text">
                <strong>{d.kind === "cmo" ? "AI CMO" : d.kind === "dept" ? DEPT_NAME[d.key as keyof typeof DEPT_NAME] : SOCIAL[d.key as SocialKey].name}</strong>
                {d.kind === "cmo" && <span>Your goal</span>}
              </span>
            </div>
          ))}
        </div>

        <div ref={copyRef} className="lv-hero-copy">
          <p data-intro="1" className="lv-eyebrow lv-eyebrow-rule">Led by an AI CMO · for founders</p>
          <h1 className="lv-hero-title">
            <span className="lv-mask"><span data-intro-line="1" className="lv-hero-line is-lora">Your AI</span></span>
            <span className="lv-mask is-tail"><span data-intro-line="1" className="lv-hero-line lv-accent">marketing team</span></span>
          </h1>
          <p data-intro="1" className="lv-hero-lede">It edits the videos, writes the posts and finds the conversations. You approve.</p>
          {/* `site` đi qua đăng nhập (LoginForm → auth/callback) tới app. */}
          <form data-intro="1" action={action} className="lv-pill-form">
            <label htmlFor="hero-site" className="sr-only">Your website</label>
            <input id="hero-site" name="site" type="text" inputMode="url" autoComplete="url" required placeholder="yourcompany.com" />
            <button type="submit" className="lv-btn-terra">Start with your website</button>
          </form>
          <p data-intro="1" className="lv-hero-fine">{fineprint}</p>
        </div>

        <div className="lv-beats">
          {BEATS.map((b) => (
            <div key={b.num} data-beat="1" className="lv-beat">
              <span>{b.num}</span>
              <h2>{b.title}</h2>
              <p>{b.body}</p>
            </div>
          ))}
        </div>

        <div aria-hidden="true" className="lv-hero-rail">
          <div className="lv-hero-rail-line"><div ref={barRef} /></div>
          <div className="lv-hero-rail-text"><span>I · Goal</span><span>II · Plan</span><span>III · Departments</span></div>
        </div>
      </div>
    </section>
  );
}
