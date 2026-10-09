import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";

/**
 * Mở cho MỌI bot, kể cả bot của AI (GPTBot, ClaudeBot, PerplexityBot,
 * Google-Extended): được các trợ lý AI trích dẫn là một kênh phân phối, không
 * phải thứ cần chặn. Chỉ đóng phần sau đăng nhập và API — không có gì để index
 * ở đó, và crawl chúng là tốn quota vô ích.
 */
const PRIVATE = ["/app", "/editor", "/api/", "/auth/", "/login"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE },
      ...["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "PerplexityBot", "Google-Extended", "Applebot-Extended"].map(
        (userAgent) => ({ userAgent, allow: "/", disallow: PRIVATE }),
      ),
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
