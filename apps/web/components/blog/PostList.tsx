import Link from "next/link";

import type { Post } from "@/lib/blog";

import { PostCard } from "./PostCard";

/** Bài đầu tiên của trang 1 thành thẻ nổi bật; còn lại vào lưới 3 cột. */
export function PostList({ posts, feature }: { posts: Post[]; feature: boolean }) {
  if (posts.length === 0) {
    // Không hứa "sắp có" (luật sản phẩm 1): chỉ trỏ về bài đang có.
    return (
      <p className="blog-empty">
        No posts in this category yet. <Link href="/blog">Read all posts</Link>.
      </p>
    );
  }
  const [first, ...rest] = posts;
  return (
    <>
      {feature && <PostCard post={first} featured headingLevel={2} />}
      <div className="post-grid">
        {(feature ? rest : posts).map((post) => <PostCard key={post.slug} post={post} headingLevel={2} />)}
      </div>
    </>
  );
}
