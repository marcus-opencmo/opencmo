/**
 * W6-lite — số liệu bài đã đăng (H5). Không Zernio, không model: người dùng tự đăng, nên ta đọc
 * số CÔNG KHAI của chính bài đó qua ScrapeCreators. Bài có link (dán lúc "Mark as posted") đọc
 * thẳng theo link; bài không link thì so chữ với ~100 bài nổi nhất của handle người dùng.
 */

import { xTopPosts, xTweet } from "../social/research";
import { ScBudget, SocialReadError, type SocialPost } from "../social/scrapecreators";
import { LlmError } from "./llm-error";
import type { JobContext, JobOutput } from "./runner";
import type { ItemRow, MetricRow } from "./types";

const MAX_POSTS = 10;
const WINDOW_DAYS = 14;

const norm = (s: string) => s.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);

/** Ghép bài đã đăng với bài đọc được: theo id trong link, rồi theo đầu câu. */
export function matchPosts(items: ItemRow[], posts: SocialPost[]): { item: ItemRow; post: SocialPost }[] {
  const out: { item: ItemRow; post: SocialPost }[] = [];
  for (const item of items) {
    const id = /status\/(\d+)/.exec(item.external_url ?? "")?.[1];
    const text = norm(item.final_text ?? String(item.body.text ?? ""));
    const post =
      (id && posts.find((p) => p.url.endsWith(`/status/${id}`))) ||
      (text.length >= 20 ? posts.find((p) => norm(p.text).startsWith(text.slice(0, 40))) : undefined);
    if (post) out.push({ item, post });
  }
  return out;
}

export async function pullMetrics(ctx: JobContext): Promise<JobOutput> {
  const { store, run } = ctx;
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const { docs, published } = await ctx.step("find_posts", "Finding posts you published", async () => ({
    docs: await store.documents(run.user_id),
    published: (await store.items(run.user_id, { statuses: ["published"], department: "post", limit: 50 })).filter((i) => (i.published_at ?? "") >= since).slice(-MAX_POSTS),
  }), (r) => `${r.published.length} posts in the last ${WINDOW_DAYS} days`);
  if (!published.length) return { measured: 0 };

  const budget = new ScBudget(MAX_POSTS + 1);
  const posts = await ctx.step("read_numbers", "Reading the numbers on X", async () => {
    const found: SocialPost[] = [];
    for (const item of published.filter((i) => i.external_url)) {
      try {
        const post = await xTweet(item.external_url!, budget);
        if (post) found.push(post);
      } catch (error) {
        if (!(error instanceof SocialReadError)) throw error;
      }
    }
    const handle = typeof docs.product?.x_handle === "string" ? docs.product.x_handle : "";
    if (handle && published.some((i) => !i.external_url)) {
      try {
        found.push(...(await xTopPosts(handle, budget)));
      } catch (error) {
        if (!(error instanceof SocialReadError)) throw error;
      }
    }
    return found;
  }, (found) => `${found.length} posts read`);

  const rows: MetricRow[] = matchPosts(published, posts).map(({ item, post }) => ({ item_id: item.id, url: post.url, views: post.views, likes: post.likes, replies: post.replies, reposts: post.reposts }));
  if (!rows.length && !published.some((i) => i.external_url)) {
    throw new LlmError("Add your X handle to Product Information, or paste the post link when you mark it as posted, so I can read the numbers.");
  }
  const saved = await ctx.step("save_metrics", "Saving the numbers", () => store.saveMetrics(run.user_id, rows), (n) => `${n} posts measured`);
  return { measured: saved, lookups: budget.used };
}
