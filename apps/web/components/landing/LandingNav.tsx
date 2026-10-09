"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { MENUS, type Menu } from "./data";
import { LineIcon, LogoMark, SocialTile } from "./Glyphs";
import { gsap, onAnchorClick } from "./motion";

/**
 * Nav của landing: bốn menu thả xuống + Pricing/FAQ. Bảng menu "chảy" ra từ mép dưới
 * nav: hai góc trên cong lõm vào thân nav, nav đổi sang đúng màu bảng khi mở, nên hai
 * phần liền làm một.
 *
 * Vị trí bảng tính NGAY lúc rê/focus/bấm (từ mép trái của mục), không đợi bảng hiện
 * ra rồi mới đo: đo sau thì frame đầu tiên đã tràn khỏi màn hình.
 */
export function LandingNav({ user }: { user: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [dx, setDx] = useState(-14);
  const [vw, setVw] = useState(1400);
  const [scrolled, setScrolled] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    const intro = gsap.from(navRef.current, { y: -30, opacity: 0, duration: 1, ease: "expo.out", delay: 0.2 });
    return () => {
      window.removeEventListener("scroll", onScroll);
      intro.kill();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!open || !nav) return;
    const tweens = [
      gsap.fromTo(nav.querySelectorAll("[data-menu]"), { clipPath: "inset(0px -40px 100% -40px)" }, { clipPath: "inset(0px -40px -120px -40px)", duration: 0.55, ease: "expo.out" }),
      gsap.fromTo(nav.querySelectorAll("[data-mi]"), { opacity: 0, x: -8 }, { opacity: 1, x: 0, duration: 0.4, ease: "expo.out", stagger: 0.03, delay: 0.04 }),
    ];
    return () => tweens.forEach((t) => t.kill());
  }, [open]);

  const openMenu = (m: Menu, el: Element | null) => {
    if (!m.items) {
      setOpen(null);
      return;
    }
    if (open === m.id) return;
    const width = document.documentElement.clientWidth;
    const w = Math.min(m.width, width - 40);
    const x = el ? (el.closest("[data-mtrig]") ?? el).getBoundingClientRect().left : 0;
    let left = -14;
    if (x + left + w > width - 20) left = width - 20 - w - x;
    if (x + left < 20) left = 20 - x;
    setVw(width);
    setDx(Math.round(left));
    setOpen(m.id);
  };

  const state = open ? "is-menu" : scrolled ? "is-scrolled" : "";

  return (
    <nav ref={navRef} aria-label="Main" className={`lv-nav ${state}`}>
      <a href="#top" onClick={onAnchorClick("top")} className="lv-nav-brand" aria-label="OpenCMO home">
        <LogoMark size={28} />
        <span>OpenCMO</span>
      </a>
      <div className="lv-nav-menus" onMouseLeave={() => setOpen(null)}>
        {MENUS.map((m) => {
          const isOpen = !!m.items && open === m.id;
          return (
            <div key={m.id} data-mtrig="1" className={`lv-nav-trig ${m.items ? "" : "is-plain"}`} onMouseEnter={(e) => openMenu(m, e.currentTarget)}>
              <a
                href={m.href ?? "#"}
                className={`lv-nav-item ${isOpen ? "is-open" : ""}`}
                aria-haspopup={m.items ? "true" : undefined}
                aria-expanded={m.items ? isOpen : undefined}
                onFocus={(e) => openMenu(m, e.currentTarget)}
                onClick={(e) => {
                  if (m.items) {
                    e.preventDefault();
                    if (isOpen) setOpen(null);
                    else openMenu(m, e.currentTarget);
                  } else {
                    setOpen(null);
                    onAnchorClick(m.id)(e);
                  }
                }}
              >
                {m.items && <span className="lv-nav-dot" aria-hidden="true" />}
                {m.label}
              </a>
              {isOpen && m.items && (
                <div className="lv-menu-wrap" style={{ left: dx }}>
                  <div
                    data-menu="1"
                    role="menu"
                    className="lv-menu"
                    style={{ width: Math.min(m.width, vw - 40), gridTemplateColumns: m.cols === 2 ? "1fr 1fr" : "1fr" }}
                  >
                    <span aria-hidden="true" className="lv-menu-ear is-left" />
                    <span aria-hidden="true" className="lv-menu-ear is-right" />
                    {m.items.map((it) => (
                      <Link key={it.href} data-mi="1" role="menuitem" href={it.href} className="lv-menu-item" onClick={() => setOpen(null)}>
                        {it.social ? (
                          <span className="lv-menu-tile is-social"><SocialTile k={it.social} size={44} radius={13} title={false} /></span>
                        ) : (
                          <span className="lv-menu-tile">{it.icon && <LineIcon d={it.icon} color="#f3ece0" />}</span>
                        )}
                        <span className="lv-menu-text">
                          <b>{it.title}</b>
                          {it.sub && <small>{it.sub}</small>}
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="lv-nav-actions">
        <Link href={user ? "/app" : "/login"} className="lv-btn-ghost">{user ? "Open app" : "Log in"}</Link>
        <a href="#start" onClick={onAnchorClick("start")} className="lv-btn-light">Start free</a>
      </div>
    </nav>
  );
}
