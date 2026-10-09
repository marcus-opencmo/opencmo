import type { Metadata } from "next";
import Link from "next/link";

import { Brand } from "@/components/brand/Brand";
import { Arabesque } from "@/components/marketing/Ornament";

import { LoginForm } from "@/components/LoginForm";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: true } };

/** Lỗi do `/auth/callback` gắn vào URL → câu tiếng Anh cho người dùng. */
const ERRORS: Record<string, string> = {
  "thieu-ma": "Google did not finish signing you in. Please try again.",
  "link-het-han": "That sign-in expired. Please try again.",
  "huy": "Sign-in was cancelled.",
};

/**
 * Đăng nhập bằng Google — không mật khẩu, không magic link (đổi 09/10/2026).
 *
 * Vì sao: một cú bấm là vào app; không có form quên mật khẩu, không có thư phải đi tìm.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string; site?: string; next?: string; error?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="auth-page">
      <Link href="/" aria-label="OpenCMO home"><Brand /></Link>
      <div className="auth-content">
        <aside className="auth-art">
          <div className="auth-visual" aria-hidden="true">
            <Arabesque id="auth-pattern" />
          </div>
          <h2>Your marketing team is ready.</h2><p>Tell OpenCMO about your business. It plans the week and drafts the work; you approve what goes out.</p></aside>
        <section className="auth-form">
      <h1>Sign in</h1>
      <p>Use your Google account. No password needed.</p>
      {params.error ? (
        <p className="auth-error" role="alert">
          {ERRORS[params.error] ?? "Sign-in did not work. Please try again."}
        </p>
      ) : null}

      {/* Website (landing) hoặc link video (trong app) đi cùng qua đây, để sau
          khi đăng nhập họ không phải gõ lại. */}
      <LoginForm nextUrl={params.next} sourceUrl={params.url} siteUrl={params.site} />
        </section>
      </div>
      <p className="auth-footer">OpenCMO · The AI CMO for founders.</p>
    </main>
  );
}
