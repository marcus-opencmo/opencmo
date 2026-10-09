"use client";

import { useEffect, useRef, useState } from "react";

import { DEPTS, type Dept } from "./data";
import { LineIcon, SocialTile } from "./Glyphs";
import { DEPT_ICON } from "./icons";
import { gsap, onAnchorClick, prefersReducedMotion, ScrollTrigger } from "./motion";

/** Ba phiến đá ngay dưới hero: mỗi department một kết quả. */
export function Goals() {
  return (
    <section aria-label="What OpenCMO commits to" className="lv-goals" data-goals="1">
      <div className="lv-goals-grid">
        {DEPTS.map((d) => (
          <a key={d.id} href="#departments" onClick={onAnchorClick("departments")} data-slab="1" className="lv-slab lv-goal">
            <div className="lv-goal-head">
              <span className="lv-goal-id">
                <span className="lv-ink-tile"><LineIcon d={DEPT_ICON[d.id]} /></span>
                <span className="lv-numeral">{d.numeral}</span>
              </span>
              <span className="lv-goal-short">{d.short}</span>
            </div>
            <strong className="lv-goal-result">{d.result}</strong>
            <span className="lv-chips">
              {d.channels.map((c) => <SocialTile key={c} k={c} size={30} radius={10} />)}
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}

const CLIPS = [{ cap: "We almost quit", where: "TikTok" }, { cap: "The one email", where: "Reels" }, { cap: "Ship it Friday", where: "Shorts" }];
const THREADS = [
  { sub: "Reddit · r/SaaS", why: "Asks for your feature", title: "Data out without a CSV per project?", w: "92%" },
  { sub: "Hacker News", why: "Same problem", title: "Ask HN: reporting across 30 clients?", w: "78%" },
  { sub: "LinkedIn", why: "Related", title: "Tools you wish existed for agencies", w: "61%" },
];
const POST_PLATFORMS = ["X", "LinkedIn", "Threads", "Facebook", "Reddit"];

function Illustration({ id }: { id: Dept["id"] }) {
  if (id === "video") {
    return (
      <div className="lv-ill-video">
        <div className="lv-ill-strip">
          <span style={{ left: "18%", width: "12%" }} />
          <span style={{ left: "47%", width: "9%" }} />
          <span style={{ left: "74%", width: "11%" }} />
        </div>
        <div className="lv-ill-clips">
          {CLIPS.map((c) => (
            <div key={c.where} className="lv-ill-clip">
              <div><span>{c.cap}</span></div>
              <span>{c.where}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (id === "post") {
    return (
      <div className="lv-ill-post">
        <div className="lv-ill-post-head">
          <span className="lv-ill-avatar" />
          <div><b>You</b><div>Draft · for today 9:30</div></div>
        </div>
        <div className="lv-ill-tags">
          {POST_PLATFORMS.map((n, i) => <span key={n} className={i ? "" : "is-first"}>{n}</span>)}
        </div>
        <p>We shipped bulk export this week. It started with one support email asking to get data out without a CSV per project.</p>
        <div className="lv-ill-actions"><span>Edit</span><span className="is-dark">Approve</span></div>
      </div>
    );
  }
  return (
    <div className="lv-ill-sales">
      {THREADS.map((t) => (
        <div key={t.title} className="lv-ill-thread">
          <div><span>{t.sub}</span><span className="is-why">{t.why}</span></div>
          <span className="lv-ill-thread-title">{t.title}</span>
          <span className="lv-ill-meter"><span style={{ width: t.w }} /></span>
        </div>
      ))}
      <div className="lv-ill-reply"><b>Reply drafted · you post it</b>We had the same problem. One export for all projects saved us an afternoon a week.</div>
    </div>
  );
}

/**
 * Departments: màn hình rộng thì ghim section và trượt ngang ba phiến đá; dưới 960px
 * (hoặc giảm chuyển động) thì xếp dọc. Mỗi department có H3 chứa từ khoá của nó.
 */
export function Departments() {
  const [wide, setWide] = useState(true);
  const secRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 960 && !prefersReducedMotion());
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const sec = secRef.current!, track = trackRef.current!;
    const ctx = gsap.context(() => {
      const panels = gsap.utils.toArray<HTMLElement>("[data-panel]");
      if (!wide) {
        if (prefersReducedMotion()) return;
        panels.forEach((p) => gsap.from(p, { y: 80, opacity: 0, duration: 1.3, ease: "expo.out", scrollTrigger: { trigger: p, start: "top 85%" } }));
        return;
      }
      const dist = () => Math.max(0, track.scrollWidth - window.innerWidth);
      const tween = gsap.to(track, { x: () => -dist(), ease: "none", scrollTrigger: { trigger: sec, pin: true, start: "top top", end: () => "+=" + dist(), scrub: 1, invalidateOnRefresh: true, anticipatePin: 1 } });
      gsap.to(barRef.current, { scaleX: 1, ease: "none", scrollTrigger: { trigger: sec, start: "top top", end: () => "+=" + dist(), scrub: true } });
      panels.forEach((p) => {
        gsap.from(p, { rotateY: -14, scale: 0.9, opacity: 0.35, transformPerspective: 1600, transformOrigin: "0% 50%", ease: "none", scrollTrigger: { trigger: p, containerAnimation: tween, start: "left right", end: "left 35%", scrub: true } });
        gsap.from(p.querySelectorAll("[data-step]"), { x: 70, opacity: 0, duration: 1, ease: "expo.out", stagger: 0.12, scrollTrigger: { trigger: p, containerAnimation: tween, start: "left 55%" } });
        const ill = p.querySelector("[data-ill] > *");
        if (ill) gsap.fromTo(ill, { x: 90 }, { x: -50, ease: "none", scrollTrigger: { trigger: p, containerAnimation: tween, start: "left right", end: "right left", scrub: true } });
      });
    }, sec);
    const refresh = setTimeout(() => ScrollTrigger.refresh(), 100);
    return () => {
      clearTimeout(refresh);
      ctx.revert();
    };
  }, [wide]);

  return (
    <section id="departments" ref={secRef} aria-labelledby="dept-title" className={`lv-depts ${wide ? "is-wide" : "is-stacked"}`}>
      <div ref={trackRef} className="lv-depts-track">
        <div className="lv-depts-intro">
          <p className="lv-eyebrow">Your marketing team</p>
          <h2 id="dept-title" className="lv-h2">
            <span className="lv-mask"><span data-h="1">Three columns.</span></span>
            <span className="lv-mask"><span data-h="1" className="lv-accent">Each answers for one result.</span></span>
          </h2>
          <p className="lv-lede">Your AI marketing team has three departments. The AI CMO sets the plan, each department owns one result, and you decide what goes out.</p>
          <span className="lv-scroll-cue">Keep scrolling <span /></span>
        </div>
        {DEPTS.map((d) => (
          <article key={d.id} data-panel="1" aria-labelledby={`dept-${d.id}`} className="lv-slab lv-panel">
            <div className="lv-panel-body">
              <div className="lv-panel-head">
                <span className="lv-ink-tile is-lg"><LineIcon d={DEPT_ICON[d.id]} size={24} /></span>
                <div>
                  <p className="lv-panel-name"><span className="lv-numeral is-sm">{d.numeral}</span>{d.name}</p>
                  <span className="lv-chips is-sm">
                    {d.channels.map((c) => <SocialTile key={c} k={c} size={24} radius={8} />)}
                  </span>
                </div>
              </div>
              <h3 id={`dept-${d.id}`} className="lv-panel-goal">{d.goal}</h3>
              <ol className="lv-steps">
                {d.steps.map((s, i) => (
                  <li key={s} data-step="1"><span>{i + 1}</span>{s}</li>
                ))}
              </ol>
              <p className="lv-panel-result"><span>Result</span>{d.result}</p>
            </div>
            <div data-ill="1" className="lv-ill">
              <Illustration id={d.id} />
            </div>
          </article>
        ))}
      </div>
      <div aria-hidden="true" className="lv-depts-bar"><div ref={barRef} /></div>
    </section>
  );
}
