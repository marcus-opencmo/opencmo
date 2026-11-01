/**
 * Numbers of published posts and connected accounts (W6-lite, P6 A1). Two sources (`metrics-source.ts`):
 * - `zernio`: posts a slot published through a connected account, and each connected account's followers and daily
 *   numbers, through Zernio's analytics (`lib/departments/publish/analytics.ts`). No model.
 * - `public`: every other published X post, read publicly through ScrapeCreators: by the link pasted at "Mark as
 *   posted", else by matching the text against the handle's ~100 top posts.
 * A post is measured by one source only, Zernio first.
 */

import { publishAnalytics, type PublishAnalytics } from "@/lib/departments/publish/analytics";
import { PublishError, type PublishPlatform } from "@/lib/departments/publish/types";

import { profileIdOf } from "../platforms";
import { xTopPosts, xTweet } from "../social/research";
import { ScBudget, SocialReadError, socialReaderReady, type SocialPost } from "../social/scrapecreators";
import { LlmError } from "./llm-error";
import type { AccountMetricRow } from "./metrics-source";
import { checkReplies } from "./reply-outcomes";
import type { JobContext, JobOutput } from "./runner";
import type { ConnectedAccountRow, ItemRow, MetricRow, ZernioPostRow } from "./types";

const MAX_POSTS = 10;
const WINDOW_DAYS = 14;
/** Account days read each run: Analytics shows up to 90, so a run refreshes the last 30 and older days stay. */
const ACCOUNT_DAYS = 30;

const norm = (s: string) => s.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Matches published posts with posts read: by the id in the link, then by the opening words. */
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

/** Zernio's readings for the slots it published → one row per calendar item (the newest slot wins). */
export function zernioRows(slots: ZernioPostRow[], read: Awaited<ReturnType<PublishAnalytics["posts"]>>): MetricRow[] {
  const out = new Map<string, MetricRow>();
  for (const slot of slots) {
    if (!slot.item_id || out.has(slot.item_id)) continue;
    const m = read.find((r) => r.ids.includes(slot.external_id));
    if (!m) continue;
    out.set(slot.item_id, {
      item_id: slot.item_id,
      url: m.url ?? slot.external_url ?? "",
      views: m.views ?? null,
      likes: m.likes ?? null,
      replies: m.replies ?? null,
      reposts: m.reposts ?? null,
      source: "zernio",
      impressions: m.impressions,
      engagements: m.engagements,
    });
  }
  return [...out.values()];
}

/** Zernio's account days → rows keyed by our `social_accounts.id`; an account Zernio no longer names is skipped. */
export function accountRows(accounts: ConnectedAccountRow[], read: Awaited<ReturnType<PublishAnalytics["accountDays"]>>): AccountMetricRow[] {
  const byZernio = new Map(accounts.map((a) => [a.zernio_account_id, a]));
  return read.flatMap((d) => {
    const a = byZernio.get(d.zernioAccountId);
    return a
      ? [{ social_account_id: a.id, platform: a.platform, handle: a.handle, day: d.day, followers: d.followers, impressions: d.impressions, engagements: d.engagements, video_views: d.videoViews, posts: d.posts }]
      : [];
  });
}

/** New numbers can move the founder's best hours (A2); schedule cards proposed from now on use them. */
async function bestHours(ctx: JobContext, measured: number): Promise<{ best_hours?: number }> {
  if (!measured) return {};
  const hours = await ctx.step("best_hours", "Updating your best times", () => ctx.store.refreshBestSlots(ctx.run.user_id), (n) => (n ? `${n} best hours` : "Not enough posts yet"));
  return { best_hours: hours };
}

export async function pullMetrics(ctx: JobContext): Promise<JobOutput> {
  const { store, run } = ctx;
  const now = Date.now();
  const since = new Date(now - WINDOW_DAYS * 86_400_000).toISOString();
  const analytics = ctx.analytics !== undefined ? ctx.analytics : publishAnalytics();
  const output: JobOutput = { measured: 0 };

  // A3: what the founder's replies got, three days on. Free on Hacker News, a lookup each on Reddit.
  const replies = await checkReplies(ctx);
  if (replies.checked) output.replies_checked = replies.checked;

  // Zernio: the founder's connected accounts and what went out through them.
  const measuredByZernio = new Set<string>();
  const connected = analytics ? await store.connectedAccounts(run.user_id) : { zernioProfileId: null, accounts: [] };
  if (analytics && connected.zernioProfileId && connected.accounts.length) {
    const profileId = connected.zernioProfileId;
    try {
      const saved = await ctx.step("read_accounts", "Reading your accounts' numbers", async () => {
        const slots = await store.zernioPosts(run.user_id, since);
        const posts = slots.length
          ? zernioRows(slots, await analytics.posts({ zernioProfileId: profileId, from: day(now - WINDOW_DAYS * 86_400_000), to: day(now), ids: slots.map((s) => s.external_id) }))
          : [];
        const days = accountRows(
          connected.accounts,
          await analytics.accountDays({
            zernioProfileId: profileId,
            from: day(now - ACCOUNT_DAYS * 86_400_000),
            to: day(now),
            accounts: connected.accounts.map((a) => ({ zernioAccountId: a.zernio_account_id, platform: a.platform as PublishPlatform, handle: a.handle })),
          }),
        );
        const postsSaved = posts.length ? await store.saveMetrics(run.user_id, posts) : 0;
        const daysSaved = days.length ? await store.saveAccountMetrics(run.user_id, days) : 0;
        return { postsSaved, daysSaved, items: posts.map((p) => p.item_id) };
      }, (r) => `${r.postsSaved} posts and ${r.daysSaved} account days`);
      for (const id of saved.items) measuredByZernio.add(id);
      output.measured = saved.postsSaved;
      output.account_days = saved.daysSaved;
    } catch (error) {
      // Zernio down or the analytics add-on missing: the public reading still runs; tomorrow's run tries again.
      if (!(error instanceof PublishError)) throw error;
      output.zernio = error.message;
    }
  }

  if (!socialReaderReady()) return { ...output, ...(await bestHours(ctx, Number(output.measured ?? 0))) };
  const { docs, published } = await ctx.step("find_posts", "Finding posts you published", async () => ({
    docs: await store.documents(run.user_id),
    // Only X posts: the numbers are read on X, and a Threads or LinkedIn post sharing an idea must not take an X post's.
    published: (await store.items(run.user_id, { statuses: ["published"], department: "post", limit: 50 }))
      .filter((i) => (i.published_at ?? "") >= since && (profileIdOf(i.platform) ?? "x") === "x" && !measuredByZernio.has(i.id))
      .slice(-MAX_POSTS),
  }), (r) => `${r.published.length} posts in the last ${WINDOW_DAYS} days`);
  if (!published.length) return { ...output, ...(await bestHours(ctx, Number(output.measured ?? 0))) };

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

  const rows: MetricRow[] = matchPosts(published, posts).map(({ item, post }) => ({ item_id: item.id, url: post.url, views: post.views, likes: post.likes, replies: post.replies, reposts: post.reposts, source: "public" }));
  if (!rows.length && !published.some((i) => i.external_url) && !connected.accounts.length) {
    throw new LlmError("Add your X handle to Product Information, or paste the post link when you mark it as posted, so I can read the numbers.");
  }
  const saved = await ctx.step("save_metrics", "Saving the numbers", () => store.saveMetrics(run.user_id, rows), (n) => `${n} posts measured`);
  const measured = Number(output.measured ?? 0) + saved;
  return { ...output, measured, lookups: budget.used, ...(await bestHours(ctx, measured)) };
}
