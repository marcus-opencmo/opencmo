import { findCategory } from "@/content/blog/categories";
import { getAllPosts, getPost } from "@/lib/blog";
import { OG_SIZE, ogCard } from "@/lib/og/card";

export const alt = "OpenCMO blog post";
export const size = OG_SIZE;
export const contentType = "image/png";

export function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const post = getPost((await params).slug);
  return ogCard({
    kicker: post ? (findCategory(post.category)?.name ?? "Blog") : "Blog",
    title: post?.title ?? "OpenCMO Blog",
    footer: "opencmo.io/blog",
  });
}
