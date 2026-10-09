import Link from "next/link";

import { findCategory } from "@/content/blog/categories";
import { formatDate, type Post } from "@/lib/blog";

import { PostCover } from "./PostCover";

/** Cả thẻ là một link; tiêu đề là `h2`/`h3` để trang danh sách có dàn ý đúng. */
export function PostCard({ post, featured = false, headingLevel = 3 }: { post: Post; featured?: boolean; headingLevel?: 2 | 3 }) {
  const Heading = `h${headingLevel}` as "h2" | "h3";
  return (
    <article className={`post-card ${featured ? "is-featured" : ""}`}>
      <Link href={`/blog/${post.slug}`} className="post-card-link">
        <PostCover slug={post.slug} category={post.category} size={featured ? "feature" : "card"} />
        <div className="post-card-body">
          <span className="post-card-category">{findCategory(post.category)?.name}</span>
          <Heading>{post.title}</Heading>
          <p>{post.description}</p>
          <span className="post-card-meta">
            <time dateTime={post.date}>{formatDate(post.date)}</time> · {post.readingMinutes} min read
          </span>
        </div>
      </Link>
    </article>
  );
}
