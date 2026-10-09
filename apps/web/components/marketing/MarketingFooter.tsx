import Link from "next/link";

import { Brand } from "@/components/brand/Brand";
import { SUPPORT_EMAIL } from "@/lib/site";

/**
 * Footer dùng chung cho landing, blog và trang pháp lý.
 *
 * Bốn link pháp lý + email hỗ trợ là điều kiện duyệt của Polar/Creem: người
 * duyệt phải thấy chúng mà không cần đăng nhập, và email phải trùng email khai
 * với bên thanh toán (docs/cmo/san-pham.md §2, luật 6).
 */
export function MarketingFooter({ user }: { user?: boolean }) {
  return (
    <footer className="marketing-footer">
      <div className="marketing-footer-main">
        <Link href="/" aria-label="OpenCMO home"><Brand /></Link>
        <nav className="marketing-footer-links" aria-label="Footer">
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/acceptable-use">Acceptable Use</Link>
          <Link href="/refund">Refunds</Link>
          <Link href="/blog">Blog</Link>
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </nav>
        <Link href={user ? "/app" : "/login"}>{user ? "Open app" : "Get started"} →</Link>
      </div>
      <p>
        OpenCMO is independent software and is not affiliated with TikTok, YouTube, Meta, X or Reddit.
        <br />Use OpenCMO only with content you own or have the rights to use.
      </p>
    </footer>
  );
}
