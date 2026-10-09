import Link from "next/link";

import { Brand } from "@/components/brand/Brand";

/**
 * Nav dùng chung cho landing và blog.
 *
 * Trang blog render TĨNH nên không biết ai đang đăng nhập: `user` bỏ trống thì
 * nút là "Sign in" — người đã đăng nhập bấm vào vẫn được middleware đưa thẳng
 * vào app. Ở landing, link mục là `#…`; ở trang khác là `/#…`.
 */
export function MarketingNav({ user, onLanding = false, section }: { user?: boolean; onLanding?: boolean; section?: "blog" }) {
  const base = onLanding ? "" : "/";
  return (
    <nav className="marketing-nav" aria-label="Main">
      <Link href="/" aria-label="OpenCMO home"><Brand /></Link>
      <div>
        <a href={`${base}#how-it-works`}>How it works</a>
        <a href={`${base}#departments`}>Departments</a>
        <Link href="/blog" aria-current={section === "blog" ? "page" : undefined}>Blog</Link>
        <a href={`${base}#pricing`}>Pricing</a>
        <Link href={user ? "/app" : "/login"} className="marketing-nav-cta">
          {user ? "Open app" : "Sign in"}
        </Link>
      </div>
    </nav>
  );
}
