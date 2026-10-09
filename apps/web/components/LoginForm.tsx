"use client";

import { useState } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * Đăng nhập bằng Google — một cú bấm, không email, không mật khẩu.
 *
 * Vì sao bỏ magic link: mỗi lượt đăng nhập phải rời app đi tìm thư, thư hay rơi vào spam, và
 * link mở nhầm trình duyệt là không có phiên. OAuth đi PKCE qua `/auth/callback` — cùng route cũ
 * đổi `code` lấy phiên và chặn `next` ra ngoài miền.
 */
export function LoginForm({
  nextUrl,
  sourceUrl,
  siteUrl,
}: {
  nextUrl?: string;
  sourceUrl?: string;
  /** Website nhập ở hero landing — onboarding CMO đọc nó sau khi đăng nhập. */
  siteUrl?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);

    const target = new URL("/auth/callback", process.env.NEXT_PUBLIC_SITE_URL || window.location.origin);
    target.searchParams.set("next", nextUrl || "/app");
    if (sourceUrl) target.searchParams.set("url", sourceUrl);
    if (siteUrl) target.searchParams.set("site", siteUrl);

    const { error } = await createClient().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: target.toString() },
    });
    // Thành công thì trình duyệt đã rời trang sang Google; chỉ còn nhánh lỗi chạy tới đây.
    if (error) {
      setError("Could not reach Google sign-in. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="auth-fields">
      <button type="button" className="primary-button auth-google" disabled={busy} onClick={() => void signIn()}>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48">
          <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
          <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" />
          <path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.7-2.9-.7-4.6s.3-3.2.7-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" />
          <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
        </svg>
        {busy ? "Opening Google…" : "Continue with Google"}
      </button>
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
