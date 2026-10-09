import Link from "next/link";

import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { MarketingNav } from "@/components/marketing/MarketingNav";

export default function NotFound() {
  return (
    <div className="marketing blog">
      <MarketingNav />
      <main className="blog-main blog-notfound">
        <p className="section-kicker">404</p>
        <h1>This page isn’t here.</h1>
        <p>It may have moved, or the link has a typo.</p>
        <div>
          <Link href="/blog" className="blog-notfound-primary">Read the blog</Link>
          <Link href="/">Go to the homepage</Link>
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
