/**
 * Blog: mỗi bài là một file `content/blog/<slug>.html`, đọc lúc BUILD.
 *
 * Không có DB: lịch Claude viết bài chỉ cần ghi một file rồi mở PR — không cần
 * khoá Supabase, có lịch sử git, có preview Vercel để duyệt trước khi lên.
 *
 * Đầu file là một khối meta JSON trong comment `<!--meta … -->`; phần còn lại
 * là HTML thân bài (không có `<h1>` — tiêu đề lấy từ meta). Luật viết bài ở
 * `content/blog/AUTHORING.md`; `npm run check:blog` cưỡng chế nó.
 */

import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { AUTHORS, type AuthorId } from "@/content/blog/authors";
import { CATEGORIES, type CategorySlug } from "@/content/blog/categories";

export const BLOG_DIR = path.join(process.cwd(), "content/blog");
export const POSTS_PER_PAGE = 12;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const PostMetaSchema = z.object({
  title: z.string().min(10).max(80),
  description: z.string().min(50).max(170),
  category: z.enum(CATEGORIES.map((c) => c.slug) as [CategorySlug, ...CategorySlug[]]),
  date: z.string().regex(DATE),
  updated: z.string().regex(DATE).optional(),
  author: z.enum(Object.keys(AUTHORS) as [AuthorId, ...AuthorId[]]),
  /** Câu trả lời ngắn đặt đầu bài — đoạn AI và featured snippet trích. */
  answer: z.string().min(80),
  faq: z.array(z.object({ q: z.string().min(5), a: z.string().min(20) })).default([]),
  keywords: z.array(z.string()).default([]),
  draft: z.boolean().default(false),
});

export type PostMeta = z.infer<typeof PostMetaSchema>;

export type TocItem = { id: string; text: string; level: 2 | 3 };

export type Post = PostMeta & {
  slug: string;
  updated: string;
  /** HTML đúng như người viết (cho `check:blog`); `html` là bản đã thêm neo/khung bảng. */
  body: string;
  html: string;
  toc: TocItem[];
  words: number;
  readingMinutes: number;
};

const META_BLOCK = /^\s*<!--meta\s*([\s\S]*?)-->/;
const HEADING = /<h([23])\s+id="([^"]+)"([^>]*)>([\s\S]*?)<\/h\1>/g;

export function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "’")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tách meta + thân bài. Ném lỗi có tên file để `check:blog` và build chỉ đúng chỗ. */
export function parsePost(slug: string, source: string): Post {
  const match = source.match(META_BLOCK);
  if (!match) throw new Error(`${slug}.html: thiếu khối <!--meta {…} --> ở đầu file`);
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`${slug}.html: meta không phải JSON hợp lệ (${(error as Error).message})`);
  }
  const parsed = PostMetaSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${slug}.html: meta sai — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const body = source.slice(match[0].length).trim();

  const toc: TocItem[] = [];
  for (const m of body.matchAll(HEADING)) {
    toc.push({ level: Number(m[1]) as 2 | 3, id: m[2], text: stripTags(m[4]) });
  }
  const words = stripTags(body).split(" ").filter(Boolean).length;

  return {
    ...parsed.data,
    slug,
    updated: parsed.data.updated ?? parsed.data.date,
    body,
    html: enhance(body),
    toc,
    words,
    readingMinutes: Math.max(1, Math.round(words / 230)),
  };
}

/**
 * Thêm phần trình bày mà người viết bài không phải nhớ: neo `#` cho tiêu đề,
 * khung cuộn ngang cho bảng (bảng rộng không được đẩy trang tràn ngang trên
 * điện thoại), ảnh tải lười.
 */
function enhance(html: string): string {
  return html
    .replace(HEADING, (_all, level, id, attrs, inner) =>
      `<h${level} id="${id}"${attrs}>${inner}<a class="heading-anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`)
    .replace(/<table/g, '<div class="blog-table"><table')
    .replace(/<\/table>/g, "</table></div>")
    .replace(/<img(?![^>]*\sloading=)/g, '<img loading="lazy" decoding="async"');
}

let cache: Post[] | null = null;

/** Mọi bài đã đăng, mới nhất trước. Bản nháp chỉ hiện khi `next dev`. */
export function getAllPosts(): Post[] {
  if (cache && process.env.NODE_ENV === "production") return cache;
  const files = fs.existsSync(BLOG_DIR) ? fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith(".html")) : [];
  const posts = files
    .map((file) => parsePost(file.replace(/\.html$/, ""), fs.readFileSync(path.join(BLOG_DIR, file), "utf8")))
    .filter((post) => !post.draft || process.env.NODE_ENV === "development")
    .sort((a, b) => (a.date === b.date ? a.slug.localeCompare(b.slug) : b.date.localeCompare(a.date)));
  cache = posts;
  return posts;
}

export function getPost(slug: string): Post | undefined {
  return getAllPosts().find((post) => post.slug === slug);
}

export function getPostsByCategory(category: string): Post[] {
  return getAllPosts().filter((post) => post.category === category);
}

/** Cùng category trước, thiếu thì bù bằng bài mới nhất. */
export function getRelatedPosts(post: Post, count = 3): Post[] {
  const others = getAllPosts().filter((p) => p.slug !== post.slug);
  const same = others.filter((p) => p.category === post.category);
  const rest = others.filter((p) => p.category !== post.category);
  return [...same, ...rest].slice(0, count);
}

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / POSTS_PER_PAGE));
}

export function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
