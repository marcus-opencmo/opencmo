"use client";

import { useState } from "react";

/**
 * Mỗi lúc mở một câu. Câu trả lời đóng vẫn nằm trong HTML (thuộc tính `hidden`), nên
 * máy đọc thấy đủ cả bảy câu như trong JSON-LD FAQPage.
 */
export function FaqSection({ items }: { items: { q: string; a: string }[] }) {
  const [open, setOpen] = useState(0);
  return (
    <section id="faq" aria-labelledby="faq-title" className="lv-panel-section">
      <div className="lv-container lv-faq-grid">
        <h2 id="faq-title" className="lv-h2 is-md">
          <span className="lv-mask"><span data-h="1">Questions,</span></span>
          <span className="lv-mask"><span data-h="1" className="lv-accent">answered plainly.</span></span>
        </h2>
        <div className="lv-faq-list">
          {items.map((f, i) => (
            <div key={f.q} data-rise="1" className="lv-faq-item">
              <button type="button" aria-expanded={open === i} aria-controls={`faq-a-${i}`} onClick={() => setOpen(open === i ? -1 : i)}>
                {f.q}
                <span aria-hidden="true">{open === i ? "−" : "+"}</span>
              </button>
              <p id={`faq-a-${i}`} hidden={open !== i}>{f.a}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
