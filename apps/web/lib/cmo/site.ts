import "server-only";

/**
 * Đọc website của người dùng cho W0 Onboarding (tool `fetch_site`).
 *
 * Server đi lấy một URL do người dùng gõ là cửa SSRF kinh điển: URL trỏ vào
 * 169.254.169.254, localhost, mạng nội bộ. Nên:
 * - chỉ http/https, cổng mặc định, không user:pass, host phải là tên miền;
 * - phân giải DNS và từ chối mọi địa chỉ riêng/loopback/link-local trước khi gọi;
 * - tự đi theo redirect (tối đa 3 lần), kiểm lại từng chặng;
 * - trần thời gian và trần dung lượng mỗi trang.
 * Còn khe DNS rebinding giữa lúc kiểm và lúc fetch; chấp nhận được vì không có
 * gì trả về cho người gọi ngoài chữ đã rút gọn của trang.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const TIMEOUT_MS = 8000;
const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const TEXT_PER_PAGE = 8000;
/** Trang phụ đáng đọc: giá, giới thiệu, tính năng. */
const EXTRA_PAGE = /\/(pricing|plans|about|features|product|how-it-works)\/?$/i;

export class SiteError extends Error {}

export type SitePage = { url: string; title: string; description: string; headings: string[]; text: string };
export type SiteSnapshot = { url: string; pages: SitePage[] };

/** Chuẩn hoá ô "Your website": thêm https://, bỏ path, chặn mọi thứ không phải tên miền công khai. */
export function normalizeSite(input: string): URL {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SiteError("Enter a website address like yourcompany.com.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new SiteError("Use an http or https address.");
  if (url.username || url.password || url.port) throw new SiteError("Enter just the website address.");
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost") {
    throw new SiteError("Enter a public website address.");
  }
  return new URL(`${url.protocol}//${host}/`);
}

export function privateAddress(address: string): boolean {
  if (address.includes(":")) {
    const a = address.toLowerCase();
    if (a === "::" || a === "::1") return true;
    if (a.startsWith("::ffff:")) return privateAddress(a.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(a);
  }
  const [x, y] = address.split(".").map(Number);
  return (
    x === 0 || x === 10 || x === 127 || x >= 224 ||
    (x === 100 && y >= 64 && y <= 127) ||
    (x === 169 && y === 254) ||
    (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && y === 168) ||
    (x === 198 && (y === 18 || y === 19))
  );
}

async function assertPublic(url: URL) {
  const host = url.hostname;
  if (isIP(host)) throw new SiteError("Enter a public website address.");
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new SiteError("We could not find that website. Check the address.");
  }
  if (addresses.length === 0 || addresses.some((a) => privateAddress(a.address))) {
    throw new SiteError("Enter a public website address.");
  }
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

/** Lấy một trang HTML, tự theo redirect và kiểm lại từng chặng. Trả null nếu không phải HTML. */
export async function fetchPage(start: URL): Promise<{ url: URL; html: string } | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new SiteError("That website redirects somewhere we can't read.");
    await assertPublic(url);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "OpenCMOBot/1.0 (+https://opencmo.io)", accept: "text/html,application/xhtml+xml" },
      });
    } catch {
      throw new SiteError("We could not reach that website. Check the address and try again.");
    }
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      if (!next) break;
      url = new URL(next, url);
      continue;
    }
    if (!response.ok) return null;
    if (!(response.headers.get("content-type") ?? "").includes("html")) return null;
    return { url, html: await readCapped(response) };
  }
  throw new SiteError("That website redirects too many times.");
}

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

const clean = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Rút chữ đọc được từ HTML: tiêu đề, mô tả, các heading, thân bài (đã bỏ script/style/nav). */
export function extractPage(url: string, html: string): SitePage {
  const body = html
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const title = clean(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const description = clean(
    body.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
      body.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
      "",
  );
  const headings = [...body.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => clean(m[1])).filter(Boolean).slice(0, 30);
  const text = clean(body.replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, " ")).slice(0, TEXT_PER_PAGE);
  return { url, title: title.slice(0, 200), description: description.slice(0, 400), headings, text };
}

function extraLinks(base: URL, html: string): URL[] {
  const seen = new Set<string>();
  const out: URL[] = [];
  for (const match of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    let link: URL;
    try {
      link = new URL(match[1], base);
    } catch {
      continue;
    }
    if (link.hostname !== base.hostname || !EXTRA_PAGE.test(link.pathname)) continue;
    const key = link.pathname.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(new URL(link.pathname, base));
    if (out.length === 3) break;
  }
  return out;
}

/** Trang chủ + tối đa 3 trang phụ cùng miền. Trang chủ không đọc được thì báo lỗi cho người dùng. */
export async function readSite(input: string): Promise<SiteSnapshot> {
  const home = await fetchPage(normalizeSite(input));
  if (!home) throw new SiteError("We could not read that website. Is it public?");
  const pages = [extractPage(home.url.toString(), home.html)];
  const extras = await Promise.all(
    extraLinks(home.url, home.html).map((link) => fetchPage(link).catch(() => null)),
  );
  for (const page of extras) if (page) pages.push(extractPage(page.url.toString(), page.html));
  if (pages.every((p) => p.text.length < 80 && !p.description)) {
    throw new SiteError("That website has almost no text we can read. Try your main marketing site.");
  }
  return { url: home.url.toString(), pages };
}
