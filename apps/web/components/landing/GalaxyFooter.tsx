"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

import { SUPPORT_EMAIL } from "@/lib/site";

import { FOOTER_COLUMNS } from "./data";
import { LogoMark, SocialTile } from "./Glyphs";
import { startGalaxy } from "./galaxy";
import { gsap, onAnchorClick, prefersReducedMotion } from "./motion";

/**
 * Footer là bức tranh dải ngân hà: CTA cuối trang (ô website) nằm ngay trên lõi thiên
 * hà, khung link kính mờ để ánh sáng xuyên qua, chữ "OpenCMO" khổng lồ ở đáy.
 *
 * Bốn link pháp lý + email hỗ trợ là điều kiện duyệt của Polar/Creem (luật 6): luôn
 * thấy được khi chưa đăng nhập.
 */
export function GalaxyFooter({ action }: { action: string }) {
  const footRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const foot = footRef.current!;
    const stop = startGalaxy(canvasRef.current!, foot, ctaRef.current, prefersReducedMotion());
    const intro = gsap.from(ctaRef.current!.children, { y: 40, opacity: 0, duration: 1.4, ease: "expo.out", stagger: 0.12, scrollTrigger: { trigger: foot, start: "top 70%" } });
    return () => {
      stop();
      intro.scrollTrigger?.kill();
      intro.kill();
    };
  }, []);

  return (
    <footer ref={footRef} className="lv-footer">
      <canvas ref={canvasRef} aria-hidden="true" className="lv-footer-canvas" />
      <div aria-hidden="true" className="lv-footer-shade" />
      <div id="start" ref={ctaRef} className="lv-final">
        <span className="lv-mono-eyebrow">Your customers are already talking</span>
        <h2>Put your marketing team to work tonight.</h2>
        <form action={action} className="lv-pill-form is-final">
          <label htmlFor="end-site" className="sr-only">Your website</label>
          <input id="end-site" name="site" type="text" inputMode="url" autoComplete="url" required placeholder="yourcompany.com" />
          <button type="submit" className="lv-btn-light">Start with your website</button>
        </form>
      </div>

      <div className="lv-glass">
        <div className="lv-glass-inner">
          <div className="lv-foot-top">
            <div className="lv-foot-brand">
              <span><LogoMark size={30} /><span>OpenCMO</span></span>
              <p>Your AI marketing team. It edits the videos, writes the posts and finds the conversations. You approve.</p>
            </div>
            <p className="lv-foot-support">
              <span className="lv-mono-eyebrow">Questions or billing</span>
              <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
            </p>
          </div>
          <nav aria-label="Footer" className="lv-foot-cols">
            {FOOTER_COLUMNS.map((col) => (
              <div key={col.title}>
                <h3>{col.title}</h3>
                <ul>
                  {col.links.map((l) => (
                    <li key={l.t}>
                      {l.href.startsWith("#") && l.href.length > 1 ? (
                        <a href={l.href} onClick={onAnchorClick(l.href.slice(1))}>{l.t}</a>
                      ) : l.href.startsWith("/") ? (
                        <Link href={l.href}>{l.t}</Link>
                      ) : (
                        <a href={l.href}>
                          {l.social && <SocialTile k={l.social} size={20} radius={6} title={false} />}
                          {l.t}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <div className="lv-foot-bottom">
            <p>OpenCMO is independent software and is not affiliated with TikTok, YouTube, Meta, X or Reddit. Use OpenCMO only with content you own or have the rights to use.</p>
            <div className="lv-foot-legal">
              <Link href="/privacy">Privacy</Link>
              <Link href="/terms">Terms</Link>
              <Link href="/acceptable-use">Acceptable Use</Link>
              <Link href="/refund">Refunds</Link>
              <a href="/llms.txt">llms.txt</a>
            </div>
          </div>
        </div>
      </div>
      <div aria-hidden="true" className="lv-wordmark">OpenCMO</div>
    </footer>
  );
}
