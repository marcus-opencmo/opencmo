import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CategoryChips, Pagination } from "@/components/blog/BlogChrome";
import { PostList } from "@/components/blog/PostList";
import { POSTS_PER_PAGE, getAllPosts, pageCount } from "@/lib/blog";

export const dynamicParams = false;

export function generateStaticParams() {
  // Trang 1 là `/blog` — không dựng `/blog/page/1`, một nội dung chỉ một URL.
  const pages = pageCount(getAllPosts().length);
  return Array.from({ length: pages - 1 }, (_, i) => ({ n: String(i + 2) }));
}

export async function generateMetadata({ params }: { params: Promise<{ n: string }> }): Promise<Metadata> {
  const { n } = await params;
  return {
    title: `Blog — page ${n}`,
    alternates: { canonical: `/blog/page/${n}` },
  };
}

export default async function BlogPage({ params }: { params: Promise<{ n: string }> }) {
  const n = Number((await params).n);
  const posts = getAllPosts();
  const pages = pageCount(posts.length);
  if (!Number.isInteger(n) || n < 2 || n > pages) notFound();
  return (
    <main className="blog-main">
      <header className="blog-header is-compact">
        <p className="section-kicker">Blog · Page {n}</p>
        <h1>Older posts</h1>
      </header>
      <CategoryChips />
      <PostList posts={posts.slice((n - 1) * POSTS_PER_PAGE, n * POSTS_PER_PAGE)} feature={false} />
      <Pagination page={n} pages={pages} />
    </main>
  );
}
