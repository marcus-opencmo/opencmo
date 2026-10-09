/**
 * Reddit cho W4 (quét bán hàng) — lớp mỏng trên client ScrapeCreators chung (`scrapecreators.ts`,
 * H2). Giữ kiểu `RedditThread` cũ để `sales-scan.ts` không đổi.
 *
 * Không `server-only` để check chạy được; khoá chỉ đọc từ env phía server.
 */

import { redditSearch } from "./research";
import { itemsOf, redditPost, type ScBudget, socialReaderReady, SocialReadError } from "./scrapecreators";

export { socialReaderReady, SocialReadError };

export type RedditThread = {
  url: string;
  community: string;
  title: string;
  author: string;
  text: string;
  comments: number;
  postedAt: string | null;
};

const toThread = (p: NonNullable<ReturnType<typeof redditPost>>): RedditThread => ({
  url: p.url,
  community: p.community,
  title: p.title,
  author: p.author,
  text: p.text,
  comments: p.replies,
  postedAt: p.postedAt,
});

/** JSON của ScrapeCreators → thread hợp lệ (có link reddit.com và tiêu đề). */
export function parseRedditSearch(json: unknown): RedditThread[] {
  return itemsOf(json, ["posts", "results", "data", "items"])
    .map(redditPost)
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map(toThread);
}

export async function searchReddit(query: string, budget?: ScBudget): Promise<RedditThread[]> {
  return (await redditSearch(query, budget)).map(toThread);
}
