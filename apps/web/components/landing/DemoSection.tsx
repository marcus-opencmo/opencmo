"use client";

import { useEffect, useRef, useState } from "react";

import { DEMOS, type DeptId } from "./data";
import { gsap } from "./motion";

const TABS: [DeptId, string][] = [["video", "Video"], ["post", "Post"], ["sales", "Sales"]];

/** "See it work": ba video 5 giây dựng lại từ UI thật của Editor/Dashboard, chạy lặp, không tiếng. */
export function DemoSection() {
  const [tab, setTab] = useState<DeptId>("video");
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  const demo = DEMOS[tab];

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // `key` đổi theo tab nên mỗi tab là một thẻ video mới; chỉ cần ép muted (một số
    // trình duyệt bỏ qua thuộc tính lúc hydrate) rồi gọi play.
    v.muted = true;
    v.play().catch(() => {});
    if (!first.current) gsap.fromTo(v, { opacity: 0 }, { opacity: 1, duration: 0.6 });
    first.current = false;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const d = v.duration || 5;
      if (barRef.current) barRef.current.style.transform = `scaleX(${((v.currentTime % d) / d).toFixed(4)})`;
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [tab]);

  return (
    <section id="demo" aria-labelledby="demo-title" className="lv-panel-section lv-demo">
      <div className="lv-container lv-stack-36">
        <div className="lv-demo-head">
          <div className="lv-stack-18">
            <p data-rise="1" className="lv-eyebrow">See it work</p>
            <h2 id="demo-title" className="lv-h2 is-md">
              <span className="lv-mask"><span data-h="1">Five seconds</span></span>
              <span className="lv-mask"><span data-h="1" className="lv-accent">per workflow.</span></span>
            </h2>
          </div>
          <div role="tablist" aria-label="Workflow" className="lv-segment">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "is-on" : ""} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div data-rise="1" className="lv-demo-frame">
          <div className="lv-demo-screen">
            <video ref={videoRef} key={demo.src} autoPlay muted loop playsInline preload="auto" aria-label={demo.alt}>
              <source src={demo.src} type="video/mp4" />
            </video>
            <div className="lv-demo-bar">
              <span>{demo.label}</span>
              <span className="lv-demo-track"><span ref={barRef} /></span>
            </div>
          </div>
        </div>
        <p data-rise="1" className="lv-demo-caption">{demo.caption}</p>
      </div>
    </section>
  );
}
