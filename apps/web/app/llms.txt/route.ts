import { CATEGORIES } from "@/content/blog/categories";
import { getAllPosts } from "@/lib/blog";
import { PLANS } from "@/lib/pricing";
import { SITE_DESCRIPTION, absoluteUrl } from "@/lib/site";

export const dynamic = "force-static";

/**
 * `/llms.txt` (llmstxt.org): bản tóm tắt bằng Markdown cho mô hình ngôn ngữ —
 * OpenCMO là gì, giá, và mục lục bài viết. Giá đọc từ PLANS để không bao giờ
 * lệch với bảng giá trên trang.
 */
export function GET() {
  const posts = getAllPosts();
  const paid = PLANS.filter((plan) => plan.price > 0);
  const lines = [
    "# OpenCMO",
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    "OpenCMO is software for founders. You enter your website; an AI CMO builds a strategy and a weekly plan, and three departments draft the work: Video (vertical clips with captions from recordings you own, a version per platform), Post (daily X posts in your voice) and Sales (public Reddit threads where people describe the problem you solve, with a reply drafted for you to post yourself). Nothing is published without your approval, and only to accounts you connect.",
    "",
    "## Pricing",
    "",
    ...paid.map((plan) => `- ${plan.name}: $${plan.price}/month${plan.interval === "year" ? ` (billed $${plan.billedPrice} yearly)` : ""} — ${plan.features.join(", ")}`),
    "- Credits are spent per piece of work (for example 1 credit per minute of video processed).",
    "",
    "## Links",
    "",
    `- [Home](${absoluteUrl("/")}): product overview and pricing`,
    `- [Blog](${absoluteUrl("/blog")}): marketing how-to guides, tips and playbooks for founders`,
    "",
    ...CATEGORIES.flatMap((category) => {
      const inCategory = posts.filter((post) => post.category === category.slug);
      if (inCategory.length === 0) return [];
      return [
        `## ${category.name}`,
        "",
        ...inCategory.map((post) => `- [${post.title}](${absoluteUrl(`/blog/${post.slug}`)}): ${post.description}`),
        "",
      ];
    }),
  ];
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
