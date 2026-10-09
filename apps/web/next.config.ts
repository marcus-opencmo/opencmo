import type { NextConfig } from "next";

import { CATEGORY_REDIRECTS } from "./content/blog/categories";
import blogRedirects from "./content/blog/redirects.json";

/**
 * Header bảo mật.
 *
 * CSP viết theo đúng những thứ app này thật sự nạp; không có `unsafe-eval`,
 * không có wildcard host. Ba chỗ bắt buộc phải nới, kèm lý do:
 *
 *   - `script-src 'unsafe-inline'`: Next nhúng dữ liệu hydration bằng thẻ
 *     `<script>` inline. Nonce cho từng request thì phải bỏ hẳn render tĩnh.
 *   - `style-src 'unsafe-inline'`: canvas editor đặt vị trí chữ bằng `style`
 *     trên từng phần tử — đó là cách người dùng kéo chữ trên khung hình.
 *   - `script-src 'wasm-unsafe-eval'`: CanvasKit (Skottie, vẽ Lottie ở preview)
 *     là WebAssembly; thiếu nó trình duyệt từ chối biên dịch wasm. Chỉ mở wasm,
 *     không mở `eval`.
 *
 * `'unsafe-eval'` CHỈ thêm khi `next dev`: Fast Refresh của React chạy module
 * bằng `eval`, không có nó thì mỗi lần sửa file là một lỗi CSP và hot reload
 * chết. Bản production dựng sẵn không cần eval, nên không bao giờ nới ở đó —
 * điều kiện dựa vào `NODE_ENV`, thứ mà `next build` luôn đặt là `production`.
 *
 * `connect-src`/`media-src` phải có host Supabase: trình duyệt nói THẲNG với
 * Storage và Realtime (ràng buộc web số 3 và số 5 — file không đi qua Next).
 *
 * Biến môi trường đọc BÊN TRONG `headers()`, không ở thân module: `next start`
 * nạp `.env.local` sau khi require file config, nên đọc ở ngoài sẽ ra chuỗi
 * rỗng và CSP tự chặn chính Supabase của mình.
 */
/**
 * Host của trình phát YouTube.
 *
 * `default-src 'self'` chặn iframe, nên thiếu `frame-src` thì ô video im lặng
 * không hiện — không có lỗi nào ngoài một dòng trong console. Và `iframe_api`
 * nạp tiếp một script từ `s.ytimg.com`, nên thiếu host đó thì iframe hiện lên
 * nhưng thanh chọn đoạn không biết video dài bao nhiêu.
 *
 * Liệt kê đúng ba host, không wildcard: CSP của app này viết theo những thứ nó
 * THẬT SỰ nạp, và một wildcard là chỗ để thứ khác lẫn vào sau này.
 */

const YOUTUBE_FRAME = "https://www.youtube-nocookie.com https://www.youtube.com";
const YOUTUBE_SCRIPT = "https://www.youtube.com https://s.ytimg.com";
const YOUTUBE_THUMBS = "https://i.ytimg.com";

function securityHeaders(): { key: string; value: string }[] {
  const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
  const host = supabaseUrl.replace(/^https?:\/\//, "");
  const ws = host ? `${supabaseUrl.startsWith("https") ? "wss" : "ws"}://${host}` : "";
  // Storage của Supabase cloud phát file từ một host riêng
  // (`<ref>.storage.supabase.co`); trên máy local mọi thứ chung một origin.
  const storage = host.replace(/^([^.]+)\.supabase\.co$/, "$1.storage.supabase.co");
  // `wss` chỉ có nghĩa với `connect-src` (Realtime); đưa nó vào `media-src`
  // hay `img-src` là rác trong header, và rác trong CSP là chỗ để lẫn lỗi.
  const httpOrigins = [supabaseUrl, storage && storage !== host ? `https://${storage}` : ""]
    .filter(Boolean)
    .join(" ");
  const origins = [httpOrigins, ws].filter(Boolean).join(" ");

  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${YOUTUBE_SCRIPT}${
      process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""
    }`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${origins} https://*.sentry.io`.replace(/\s+/g, " "),
    `media-src 'self' blob: ${httpOrigins}`.replace(/\s+/g, " ").trim(),
    // `i.ytimg.com` là ảnh bìa YouTube. Màn xử lý hiện nó ngay khi job bắt
    // đầu: clip đầu tiên phải mất một phút mới có, và một phút nhìn chữ
    // "Reading your video…" là một phút người dùng nghĩ máy đang treo.
    `img-src 'self' data: blob: ${YOUTUBE_THUMBS} ${httpOrigins}`.replace(/\s+/g, " ").trim(),
    // Font phục vụ ở `/fonts/` (chép từ `packages/clip-media` lúc build) — cùng origin, không cần host ngoài.
    "font-src 'self'",
    "worker-src 'self' blob:",
    // 'self': iframe sandbox preview cảnh 3D (/sandbox/three.html) của editor.
    `frame-src 'self' ${YOUTUBE_FRAME}`,
  ].join("; ");

  return [
    { key: "Content-Security-Policy", value: csp },
    // Vercel tự gắn HSTS cho custom domain, nhưng header bảo mật của app không
    // nên phụ thuộc vào nhà cung cấp: đổi chỗ host là mất, mà mất thì im lặng.
    // Hai năm + subdomain vì `opencmo.io` chỉ phục vụ HTTPS.
    {
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains; preload",
    },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    },
  ];
}

/**
 * Trang sandbox preview cảnh 3D (spec code-scenes): chạy code three.js do
 * agent viết. `sandbox allow-scripts` cho nó origin mờ — không cookie, không
 * storage, không gọi được API của app; `connect-src 'none'` chặn mạng hẳn.
 * `unsafe-eval` CHỈ ở đây (code của cảnh là chương trình); trang chính vẫn cấm.
 * Script inline vì runtime nằm trong trang (origin mờ không nạp file cùng host).
 */
function sandboxHeaders(): { key: string; value: string }[] {
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "worker-src blob:",
    "img-src data: blob:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    "sandbox allow-scripts",
  ].join("; ");
  return [
    { key: "Content-Security-Policy", value: csp },
    { key: "Cache-Control", value: "public, max-age=3600" },
  ];
}

const e2eBuild = process.env.OPENCMO_E2E_BUILD === "1";
const config: NextConfig = {
  // Test và dev có thể cùng mở trên máy: không ghi đè manifest của nhau.
  distDir: e2eBuild ? ".next-e2e" : ".next",
  // Clip là file lớn: app không bao giờ proxy chúng, chỉ phát signed URL trỏ
  // thẳng vào Supabase Storage. Xem lib/storage.ts.
  experimental: { serverActions: { bodySizeLimit: "1mb" }, ...(e2eBuild ? { cpus: 2 } : {}) },
  /**
   * `editor-core`, `clip-doc`, `clip-render`, `clip-assets` là nguồn TypeScript
   * trong workspace (import có đuôi `.ts`): route `/api/v1/editor/*` áp op trên
   * server, shell editor vẽ preview bằng chúng trong trình duyệt — Next phải
   * transpile.
   */
  transpilePackages: ["@opencmo/editor-core", "@opencmo/clip-doc", "@opencmo/clip-render", "@opencmo/clip-assets", "@opencmo/clip-icons", "@opencmo/clip-three"],
  /**
   * CanvasKit là bản Emscripten có nhánh Node (`require("fs")`) không bao giờ
   * chạy trong trình duyệt; bundle phía client bỏ hai module đó.
   */
  webpack(config, { isServer }) {
    if (!isServer) config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false };
    return config;
  },
  async headers() {
    // Luật sau ghi đè luật trước cho cùng header: trang sandbox có CSP riêng.
    return [{ source: "/:path*", headers: securityHeaders() }, { source: "/sandbox/three.html", headers: sandboxHeaders() }];
  },
  /**
   * Slug bài viết là bất biến; đổi slug thì slug cũ phải vào
   * `content/blog/redirects.json` (cũ → mới). 308 giữ thứ hạng và link ngoài.
   */
  async redirects() {
    const posts = Object.entries(blogRedirects as Record<string, string>).map(([from, to]) => ({
      source: `/blog/${from}`,
      destination: `/blog/${to}`,
      permanent: true,
    }));
    const categories = Object.entries(CATEGORY_REDIRECTS).map(([from, to]) => ({
      source: `/blog/category/${from}`,
      destination: `/blog/category/${to}`,
      permanent: true,
    }));
    return [...posts, ...categories];
  },
};

export default config;
