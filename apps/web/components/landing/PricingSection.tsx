"use client";

import { useState } from "react";

import { INCLUDED, savePercent, USUAL_STACK, type Prices } from "./data";
import { LineIcon, LogoMark } from "./Glyphs";

const STACK_TOTAL = USUAL_STACK.reduce((n, r) => n + r.price, 0);

/**
 * Một giá, mặc định trả theo năm. Bên trái là "cách làm thường" (ước tính, có ghi chú
 * ngay dưới), bên phải là OpenCMO. Cố ý KHÔNG có animation: phần này phải đọc rõ ngay.
 */
export function PricingSection({ prices, action }: { prices: Prices; action: string }) {
  const [annual, setAnnual] = useState(true);
  const price = annual ? prices.annual : prices.monthly;
  const save = savePercent(prices);
  const lessThanUsual = Math.round((1 - price / STACK_TOTAL) * 100);

  return (
    <section id="pricing" aria-labelledby="pricing-title" className="lv-panel-section is-pricing">
      <div className="lv-container lv-stack-40">
        <div className="lv-pricing-head">
          <div className="lv-stack-16">
            <p className="lv-eyebrow">Pricing</p>
            <h2 id="pricing-title" className="lv-h2 is-lg">One team. <span className="lv-accent">One price.</span></h2>
            <p className="lv-lede is-wide">The whole workflow (video, posts and sales) costs less than one freelancer.</p>
          </div>
          <div role="radiogroup" aria-label="Billing" className="lv-segment is-billing">
            <button type="button" role="radio" aria-checked={!annual} className={annual ? "" : "is-on"} onClick={() => setAnnual(false)}>Monthly</button>
            <button type="button" role="radio" aria-checked={annual} className={`is-annual ${annual ? "is-on" : ""}`} onClick={() => setAnnual(true)}>
              Annual<span className="lv-save">Save {save}%</span>
            </button>
          </div>
        </div>

        <div className="lv-pricing-grid">
          <article aria-label="The usual way" className="lv-usual">
            <div className="lv-usual-head"><h3>The usual way</h3><span>5 vendors · 5 logins</span></div>
            <ul>
              {USUAL_STACK.map((r) => (
                <li key={r.who}><b>{r.who}</b><span>${r.price}</span><small>{r.what}</small></li>
              ))}
            </ul>
            <div className="lv-usual-foot">
              <div><span>Every month</span><s>${STACK_TOTAL.toLocaleString("en-US")}</s></div>
              <span className="lv-usual-hours">+ about 20 hours a week of briefing and posting</span>
            </div>
          </article>

          <article aria-label="OpenCMO" className="lv-offer">
            <div className="lv-offer-head">
              <h3><LogoMark size={24} />OpenCMO</h3>
              <span>{lessThanUsual}% less than the usual way</span>
            </div>
            <div className="lv-offer-price">
              <p>
                {annual && <s>${prices.monthly}</s>}
                <strong>${price}</strong>
                <span>/ month</span>
              </p>
              <span>{annual ? `Billed $${prices.annualBilled} once a year` : `Billed monthly · switch to annual to save ${save}%`}</span>
            </div>
            <ul className="lv-included">
              {INCLUDED.map((f) => (
                <li key={f.title}>
                  <span className="lv-included-icon"><LineIcon d={f.icon} size={15} width={2} /></span>
                  <span><b>{f.title}</b><small>{f.body}</small></span>
                </li>
              ))}
            </ul>
            <div className="lv-offer-zone">
              <span>Your plan is ready in 2 minutes</span>
              <form action={action} className="lv-pill-form is-dark">
                <label htmlFor="price-site" className="sr-only">Your website</label>
                <input id="price-site" name="site" type="text" inputMode="url" autoComplete="url" required placeholder="yourcompany.com" />
                <button type="submit" className="lv-btn-terra">Start with your website</button>
              </form>
              <small>Cancel anytime. Nothing is posted until you approve it.</small>
            </div>
          </article>
        </div>
        <p className="lv-fineprint">The usual-way prices are typical 2026 monthly rates for freelancers and tools doing the same work for one small business. They are estimates, not quotes.</p>
      </div>
    </section>
  );
}
