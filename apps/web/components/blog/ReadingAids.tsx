"use client";

/**
 * Mục lục sáng theo đoạn đang đọc + thanh tiến độ đọc.
 *
 * Cả hai chỉ là phần thêm: không JS thì mục lục vẫn là danh sách link neo, và
 * thanh tiến độ đơn giản không hiện.
 */

import { useEffect, useState } from "react";

import type { TocItem } from "@/lib/blog";

export function Toc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const headings = items
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return;
    // Mục "đang đọc" là tiêu đề cuối cùng đã đi qua dải trên 30% màn hình.
    const observer = new IntersectionObserver(
      () => {
        const line = window.innerHeight * 0.3;
        let current = headings[0].id;
        for (const h of headings) if (h.getBoundingClientRect().top <= line) current = h.id;
        setActive(current);
      },
      { rootMargin: "0px 0px -70% 0px", threshold: [0, 1] },
    );
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [items]);

  return (
    <ol className="blog-toc-list">
      {items.map((item) => (
        <li key={item.id} className={`is-h${item.level}`}>
          <a href={`#${item.id}`} aria-current={active === item.id ? "location" : undefined}>{item.text}</a>
        </li>
      ))}
    </ol>
  );
}

export function ReadingProgress() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const article = document.querySelector<HTMLElement>(".blog-article-body");
    if (!article) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = article.getBoundingClientRect();
      const total = rect.height - window.innerHeight * 0.6;
      setProgress(Math.min(1, Math.max(0, -rect.top / Math.max(total, 1))));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  return <div className="blog-progress" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />;
}
