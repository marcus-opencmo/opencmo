import type { MetadataRoute } from "next";

import { CATEGORIES } from "@/content/blog/categories";
import { getAllPosts, getPostsByCategory, pageCount } from "@/lib/blog";
import { absoluteUrl } from "@/lib/site";

/** Chỉ trang công khai, có nội dung. `lastModified` lấy từ ngày cập nhật THẬT của bài. */
export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getAllPosts();
  const latest = posts[0]?.updated;
  const pages = pageCount(posts.length);

  return [
    { url: absoluteUrl("/"), changeFrequency: "weekly", priority: 1 },
    { url: absoluteUrl("/blog"), lastModified: latest, changeFrequency: "daily", priority: 0.8 },
    ...["/terms", "/privacy", "/acceptable-use", "/refund"].map((path) => ({ url: absoluteUrl(path), changeFrequency: "yearly" as const, priority: 0.2 })),
    ...Array.from({ length: pages - 1 }, (_, i) => ({ url: absoluteUrl(`/blog/page/${i + 2}`), lastModified: latest })),
    ...CATEGORIES.filter((c) => getPostsByCategory(c.slug).length > 0).map((c) => ({
      url: absoluteUrl(`/blog/category/${c.slug}`),
      lastModified: getPostsByCategory(c.slug)[0]?.updated,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
    ...posts.map((post) => ({
      url: absoluteUrl(`/blog/${post.slug}`),
      lastModified: post.updated,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];
}
