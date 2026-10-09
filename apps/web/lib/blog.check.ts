/**
 * `npm run check:blog` — luật của `content/blog/AUTHORING.md`, viết thành code.
 *
 * Bài do lịch Claude tự viết rồi mở PR; check này là thứ đứng giữa một bài
 * sai luật và production. Mỗi lỗi in ra tên file + lý do; thoát mã 1 nếu có lỗi.
 *
 *   tsx lib/blog.check.ts             kiểm mọi bài trong content/blog
 *   tsx lib/blog.check.ts a.html …    kiểm đúng các file chỉ định
 */

import fs from "node:fs";
import path from "node:path";

import redirects from "../content/blog/redirects.json";
import { BLOG_DIR, parsePost, stripTags, type Post } from "./blog";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+){1,5}$/;
const STOP_EDGE = new Set(["a", "an", "the", "of", "and", "or", "to", "in", "for", "on", "with", "your", "my"]);
const ALLOWED_TAGS = new Set([
  "p", "h2", "h3", "h4", "ul", "ol", "li", "a", "strong", "em", "b", "i", "blockquote", "figure", "figcaption",
  "img", "table", "thead", "tbody", "tr", "th", "td", "code", "pre", "hr", "br", "sup", "sub", "mark", "small",
]);
const ALLOWED_ATTRS = new Set(["id", "href", "src", "alt", "title", "width", "height", "colspan", "rowspan", "loading", "rel", "target"]);

function checkSlug(slug: string): string[] {
  const errors: string[] = [];
  if (!SLUG.test(slug)) errors.push(`slug "${slug}" phải là 2–6 từ thường a-z0-9 nối bằng "-"`);
  if (slug.length > 60) errors.push(`slug dài ${slug.length} ký tự (tối đa 60)`);
  if (/(^|-)(19|20)\d{2}(-|$)/.test(slug)) errors.push("slug không được chứa năm — bài cập nhật thì URL vẫn phải đúng");
  const words = slug.split("-");
  if (STOP_EDGE.has(words[0]) || STOP_EDGE.has(words[words.length - 1])) {
    errors.push(`slug không mở đầu/kết thúc bằng từ nối ("${words[0]}"/"${words[words.length - 1]}")`);
  }
  return errors;
}

function checkHtml(html: string): string[] {
  const errors: string[] = [];
  for (const m of html.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
    const tag = m[1].toLowerCase();
    if (m[0].startsWith("</")) continue;
    if (!ALLOWED_TAGS.has(tag)) {
      errors.push(`thẻ <${tag}> không được phép${tag === "h1" ? " (tiêu đề lấy từ meta.title)" : ""}`);
      continue;
    }
    for (const a of m[2].matchAll(/([a-zA-Z-:]+)\s*=/g)) {
      const attr = a[1].toLowerCase();
      if (attr.startsWith("on")) errors.push(`thuộc tính sự kiện ${attr}= trong <${tag}>`);
      else if (!ALLOWED_ATTRS.has(attr)) errors.push(`thuộc tính ${attr}= trong <${tag}> không được phép (style/class do blog.css lo)`);
    }
  }
  if (/javascript:/i.test(html)) errors.push("link javascript:");

  const ids = new Set<string>();
  for (const m of html.matchAll(/<(h[234])(\s[^>]*)?>/g)) {
    const id = m[2]?.match(/\sid="([^"]+)"/)?.[1];
    if (!id) errors.push(`<${m[1]}> thiếu id (mục lục và link neo cần nó)`);
    else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) errors.push(`id "${id}" phải là chữ thường nối "-"`);
    else if (ids.has(id) || id === "faq") errors.push(`id "${id}" trùng`);
    else ids.add(id);
  }
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    if (!/\salt="[^"]+"/.test(m[0])) errors.push("<img> thiếu alt mô tả");
  }
  if (!/<h2\b/.test(html)) errors.push("bài cần ít nhất một <h2>");
  if (!/<(table|ul|ol)\b/.test(html)) errors.push("bài cần ít nhất một bảng hoặc danh sách (AEO trích chúng)");
  return errors;
}

function checkPost(post: Post, slugs: Set<string>): string[] {
  const errors = [...checkSlug(post.slug), ...checkHtml(post.body)];
  if (post.title.length > 65) errors.push(`title dài ${post.title.length} ký tự (tối đa 65 — Google cắt sau đó)`);
  if (post.description.length > 160) errors.push(`description dài ${post.description.length} ký tự (tối đa 160)`);
  const answerWords = post.answer.split(/\s+/).length;
  if (answerWords < 30 || answerWords > 80) errors.push(`answer có ${answerWords} từ (cần 30–80: một đoạn trả lời trọn vẹn)`);
  if (post.faq.length < 3 || post.faq.length > 6) errors.push(`faq có ${post.faq.length} câu (cần 3–6)`);
  if (post.updated < post.date) errors.push("updated sớm hơn date");
  if (post.date > new Date().toISOString().slice(0, 10)) errors.push(`date ${post.date} ở tương lai — blog build tĩnh, bài sẽ hiện ngay khi merge`);
  if (post.words < 500) errors.push(`thân bài chỉ ${post.words} từ (tối thiểu 500)`);

  const contentLinks = [...post.body.matchAll(/<a\s[^>]*href="(\/[^"]*)"/g)].map((m) => m[1]);
  if (contentLinks.length < 2) errors.push(`cần ≥ 2 link nội bộ (landing hoặc bài khác), đang có ${contentLinks.length}`);
  for (const href of contentLinks) {
    const target = href.match(/^\/blog\/([^/#?]+)$/)?.[1];
    if (target && target !== "rss.xml" && !slugs.has(target)) errors.push(`link tới bài không tồn tại: ${href}`);
  }
  if (/\b(19|20)\d{2}\b/.test(post.title)) errors.push("title không chứa năm — làm bài cũ đi nhanh");
  if (stripTags(post.body).includes("Lorem ipsum")) errors.push("còn chữ giữ chỗ Lorem ipsum");
  return errors;
}

function main() {
  const only = process.argv.slice(2).map((f) => path.basename(f).replace(/\.html$/, ""));
  const files = fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith(".html"));
  const posts: Post[] = [];
  const failures: string[] = [];

  for (const file of files) {
    try {
      posts.push(parsePost(file.replace(/\.html$/, ""), fs.readFileSync(path.join(BLOG_DIR, file), "utf8")));
    } catch (error) {
      failures.push((error as Error).message);
    }
  }

  const slugs = new Set(posts.map((p) => p.slug));
  for (const [from, to] of Object.entries(redirects as Record<string, string>)) {
    if (slugs.has(from)) failures.push(`redirects.json: "${from}" vẫn là một bài đang sống — slug cũ không được dùng lại`);
    if (!slugs.has(to)) failures.push(`redirects.json: "${from}" trỏ tới "${to}" không tồn tại`);
  }
  const titles = new Map<string, string>();
  for (const post of posts) {
    const key = post.title.toLowerCase();
    if (titles.has(key)) failures.push(`${post.slug}.html: trùng title với ${titles.get(key)}.html`);
    titles.set(key, post.slug);
    if (only.length > 0 && !only.includes(post.slug)) continue;
    for (const error of checkPost(post, slugs)) failures.push(`${post.slug}.html: ${error}`);
  }

  if (failures.length > 0) {
    console.error(`check:blog — ${failures.length} lỗi:\n` + failures.map((f) => `  ✗ ${f}`).join("\n"));
    process.exit(1);
  }
  console.log(`check:blog — ${posts.length} bài, không lỗi.`);
}

main();
