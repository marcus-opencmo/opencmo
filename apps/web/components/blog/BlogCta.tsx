import { PLANS } from "@/lib/pricing";

/** Thẻ kêu gọi cuối bài: cùng form dán link với hero, đi qua bước đăng nhập. */
export function BlogCta() {
  const from = Math.min(...PLANS.filter((plan) => plan.price > 0).map((plan) => plan.price));
  return (
    <aside className="blog-cta" aria-labelledby="blog-cta-title">
      <p className="blog-cta-kicker">Try OpenCMO</p>
      <h2 id="blog-cta-title">Turn your next long video into clips.</h2>
      <p>Paste a link. OpenCMO finds the moments, frames the speaker and writes the captions.</p>
      <form action="/login" className="blog-cta-form">
        <label htmlFor="blog-cta-url" className="sr-only">Video link</label>
        <input id="blog-cta-url" name="url" type="url" required placeholder="Paste a YouTube or video link" />
        <button type="submit">Get clips</button>
      </form>
      <p className="blog-cta-fine">From ${from}/month · 1 credit = 1 minute</p>
    </aside>
  );
}
