import type { Metadata } from "next";

import { CategoryChips, Pagination } from "@/components/blog/BlogChrome";
import { PostList } from "@/components/blog/PostList";
import { JsonLd } from "@/components/seo/JsonLd";
import { POSTS_PER_PAGE, getAllPosts, pageCount } from "@/lib/blog";
import { OG_DEFAULTS, absoluteUrl } from "@/lib/site";

const TITLE = "Blog — marketing guides and tips for founders";
const DESCRIPTION =
  "How-to guides, tips and playbooks on marketing for solo founders and small teams: positioning, content, social posts and finding customers.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/blog" },
  openGraph: { ...OG_DEFAULTS, type: "website", title: TITLE, description: DESCRIPTION, url: "/blog" },
};

export default function BlogIndex() {
  const posts = getAllPosts();
  return (
    <main className="blog-main">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: TITLE,
          description: DESCRIPTION,
          url: absoluteUrl("/blog"),
          hasPart: posts.slice(0, POSTS_PER_PAGE).map((post) => ({
            "@type": "BlogPosting",
            headline: post.title,
            url: absoluteUrl(`/blog/${post.slug}`),
            datePublished: post.date,
          })),
        }}
      />
      <header className="blog-header">
        <p className="section-kicker">Blog</p>
        <h1>Marketing you can do yourself.</h1>
        <p>{DESCRIPTION}</p>
      </header>
      <CategoryChips />
      <PostList posts={posts.slice(0, POSTS_PER_PAGE)} feature />
      <Pagination page={1} pages={pageCount(posts.length)} />
    </main>
  );
}
