import type { Metadata } from "next";

import "./globals.css";
import "@/styles/design-system.css";
import "@/styles/marketing.css";
import "@/styles/landing.css";
import "@/styles/blog.css";
import "@/styles/app.css";
import "@/styles/cmo.css";

import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  icons: { icon: "/icon.svg" },
  title: { default: "OpenCMO — 1 long video, 10 vertical clips", template: "%s · OpenCMO" },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: { type: "website", siteName: SITE_NAME, locale: "en_US", url: "/" },
  twitter: { card: "summary_large_image" },
  alternates: { types: { "application/rss+xml": [{ url: "/blog/rss.xml", title: "OpenCMO Blog" }] } },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Script khởi động của /app (rail, theme) gắn `data-*` lên <html> trước khi
    // React hydrate; chỉ bỏ qua lệch thuộc tính ở đúng thẻ này, không lan xuống con.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
