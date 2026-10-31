/**
 * Zernio's analytics (P6 A1) without network or key: parsing of the three endpoints, the 402 of a plan without the
 * analytics add-on, `pull_metrics` with the fake source on the memory store, and Analytics / Dashboard results built
 * from the stored numbers, where a number nobody reported stays null.
 *
 *     cd apps/web && NODE_OPTIONS=--conditions=react-server npx tsx lib/departments/publish/analytics.check.ts
 */
import assert from "node:assert/strict";

import { drainCmoQueue } from "@/lib/cmo/jobs/runner";
import { memoryStore } from "@/lib/cmo/jobs/memory-store";
import { isoDay, type ItemRow } from "@/lib/cmo/jobs/types";
import { AnalyticsScreenSchema } from "@/lib/screens/analytics";
import { buildAnalytics, buildResults, median, type AccountDayIn, type PostIn } from "@/lib/screens/analytics-build";
import { MeasureSchema } from "@/lib/screens/brain";
import { buildMeasures, type WeekCounts } from "@/lib/screens/brain-measures";
import { ResultRowSchema } from "@/lib/screens/dashboard";
import { nextPostText } from "@/lib/screens/rail";
import { bestTimeWhy, hourLabel } from "@/lib/screens/schedule-enrich";

import { createFakeAnalytics, createZernioAnalytics, parseDaily, parseFollowers, parsePosts, publishAnalytics } from "./analytics";
import { PublishError } from "./types";

const DOCS = { product: "Invoicer", audience: "", competitors: "", content: "", voice: "" } as never;

async function main() {
  // Parsing: one row per post and account; unknown platforms and missing numbers are left out or null.
  const posts = parsePosts({
    posts: [
      {
        _id: "z1",
        latePostId: "late-1",
        platformAnalytics: [
          { platform: "twitter", accountId: "acc-x", platformPostId: "1850", platformPostUrl: "https://x.com/me/status/1850", analytics: { views: 1200, impressions: 1500, likes: 30, comments: 4, shares: 2 } },
          { platform: "myspace", accountId: "acc-m", analytics: { views: 1 } },
          { platform: "linkedin", accountId: "acc-l", platformPostUrl: "javascript:alert(1)", analytics: { impressions: 300 } },
        ],
      },
    ],
  });
  assert.equal(posts.length, 2, "an unknown platform is skipped");
  assert.deepEqual(posts[0]!.ids.sort(), ["1850", "late-1", "z1"]);
  assert.equal(posts[0]!.platform, "x");
  assert.equal(posts[0]!.engagements, 36, "likes + comments + shares");
  assert.equal(posts[0]!.reposts, 2, "shares stand in for reposts");
  assert.equal(posts[1]!.views, null, "a number Zernio did not send is null");
  assert.equal(posts[1]!.url, null, "only https links are kept");

  const followers = parseFollowers({ stats: { "acc-x": [{ date: "2026-10-29T00:00:00Z", followers: 300 }, { date: "nope", followers: 1 }, { date: "2026-10-30", followers: -4 }] } });
  assert.deepEqual([...followers.get("acc-x")!.entries()], [["2026-10-29", 300]]);
  const daily = parseDaily({ dailyData: [{ date: "2026-10-30", postCount: 2, metrics: { impressions: 900, likes: 10, comments: 1 } }] });
  assert.deepEqual(daily.get("2026-10-30"), { impressions: 900, engagements: 11, videoViews: null, posts: 2 });

  // Selection mirrors the publish adapter: fake with the fake flag, Zernio only with a key and the live flag.
  assert.equal(publishAnalytics({ OPENCMO_PUBLISH_FAKE: "1" })?.name, "fake");
  assert.equal(publishAnalytics({ ZERNIO_API_KEY: "k" }), null, "no live flag, no calls");
  assert.equal(publishAnalytics({ ZERNIO_API_KEY: "k", OPENCMO_PUBLISH_LIVE: "1" })?.name, "zernio");

  // The client: bearer key, query, one retry on a 5xx, 402 = the add-on is missing (not retryable).
  {
    const seen: string[] = [];
    const replies = [{ status: 503 }, { status: 200, body: { posts: [] } }, { status: 402, body: { error: "Analytics add-on required" } }];
    const zernio = createZernioAnalytics({
      apiKey: "secret",
      baseUrl: "https://zernio.test/api/v1",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push(`${String(url)} ${(init?.headers as Record<string, string>).Authorization}`);
        const r = replies.shift()!;
        return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
      }) as typeof fetch,
    });
    assert.deepEqual(await zernio.posts({ zernioProfileId: "prof", from: "2026-10-17", to: "2026-10-31", ids: [] }), []);
    assert.equal(seen.length, 2, "one retry on a 5xx");
    assert.match(seen[1]!, /^https:\/\/zernio\.test\/api\/v1\/analytics\?profileId=prof&source=late&fromDate=2026-10-17&toDate=2026-10-31&limit=100&page=1 Bearer secret$/);
    await assert.rejects(
      zernio.accountDays({ zernioProfileId: "prof", from: "2026-10-01", to: "2026-10-31", accounts: [] }),
      (e: unknown) => e instanceof PublishError && e.code === "not_configured" && !e.retryable && !/zernio/i.test(e.message),
    );
  }

  // pull_metrics: Zernio measures what went out through it, the public reading is not asked about those posts.
  {
    const mem = memoryStore(DOCS);
    const now = new Date().toISOString();
    const item: ItemRow = { id: "post-1", run_id: null, department: "post", platform: "X", day: isoDay(), idea: "Launch", reason: "", status: "published", priority: "medium", body: { text: "Launch day." }, final_text: null, external_url: null, decided_at: null, published_at: now, created_at: now };
    mem.items.push(item);
    mem.zernio.profileId = "prof-1";
    mem.zernio.accounts.push({ id: "sa-1", platform: "x", handle: "@me", zernio_account_id: "acc-1" });
    mem.zernio.posts.push({ item_id: "post-1", external_id: "zp-7", external_url: "https://x.com/me/status/7", platform: "x", social_account_id: "sa-1", zernio_account_id: "acc-1", published_at: now });
    const run = mem.enqueue("pull_metrics");
    await drainCmoQueue(mem.store, { analytics: createFakeAnalytics() });
    assert.equal(run.status, "done", `pull_metrics done (${run.error})`);
    assert.equal(mem.metrics.length, 1);
    assert.equal(mem.metrics[0]!.source, "zernio");
    assert.equal(mem.metrics[0]!.url, "https://x.com/me/status/7", "the slot's link when Zernio sends none");
    assert.equal(mem.zernio.days.length, 31, "thirty days and today");
    assert.ok(mem.zernio.days.every((d) => d.social_account_id === "sa-1" && d.video_views === null), "X reports no video views");

    // Zernio refusing (no add-on) is not a failed run: the public reading still runs.
    const mem2 = memoryStore(DOCS);
    mem2.zernio.profileId = "prof-1";
    mem2.zernio.accounts.push({ id: "sa-1", platform: "x", handle: "@me", zernio_account_id: "acc-1" });
    const run2 = mem2.enqueue("pull_metrics");
    const refusing = {
      ...createFakeAnalytics(),
      accountDays: async () => {
        throw new PublishError("not_configured", "Account numbers are not set up on our side yet.", false);
      },
    };
    await drainCmoQueue(mem2.store, { analytics: refusing });
    assert.equal(run2.status, "done", `a refusal does not fail the run (${run2.error})`);
  }

  // Analytics from stored numbers.
  {
    const now = new Date("2026-10-31T12:00:00Z");
    const accounts = [
      { id: "sa-x", platform: "x", handle: "@me", avatarUrl: null, status: "connected", updatedAt: "2026-10-01T00:00:00Z" },
      { id: "sa-t", platform: "threads", handle: "@me", avatarUrl: null, status: "connected", updatedAt: "2026-10-01T00:00:00Z" },
      { id: "sa-l", platform: "linkedin", handle: "Me", avatarUrl: null, status: "error", updatedAt: "2026-10-20T00:00:00Z" },
      { id: "sa-gone", platform: "tiktok", handle: "@old", avatarUrl: null, status: "disconnected", updatedAt: "2026-09-01T00:00:00Z" },
    ];
    const days: AccountDayIn[] = [];
    for (let i = 0; i < 14; i++) {
      const day = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
      days.push({ social_account_id: "sa-x", platform: "x", handle: "@me", day, followers: 500 - i, impressions: i < 7 ? 1000 : 500, engagements: i < 7 ? 50 : 20, video_views: null, measured_at: now.toISOString() });
      // Threads stopped sending five days ago.
      if (i >= 5) days.push({ social_account_id: "sa-t", platform: "threads", handle: "@me", day, followers: 80, impressions: 100, engagements: null, video_views: null, measured_at: now.toISOString() });
    }
    const post = (id: string, impressions: number, daysAgo: number): PostIn => ({
      id,
      title: `Post ${id}`,
      platform: "x",
      publishedAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
      views: impressions,
      impressions,
      engagements: impressions / 20,
      likes: 0,
      replies: 0,
      reposts: 0,
      url: id === "a" ? "https://x.com/me/status/1" : "http://insecure",
    });
    const posts = [post("a", 4000, 1), post("b", 1000, 2), post("c", 900, 3), post("d", 100, 4), post("e", 950, 5), post("f", 1100, 6), post("old", 50, 10)];

    const screen = buildAnalytics({ range: 7, now, accounts, days, posts, publishedInRange: 8 });
    AnalyticsScreenSchema.parse(screen);
    const kpi = (k: string) => screen.kpis.find((x) => x.key === k)!;
    assert.equal(kpi("impressions").value, 7000 + 2 * 100, "X's week plus Threads' two days in range");
    assert.equal(kpi("impressions").change, Math.round(((7200 - (3500 + 700)) / 4200) * 100), "against the week before");
    assert.equal(kpi("video_views").value, null, "nobody reported video views");
    assert.equal(kpi("posts_measured").value, 6);
    assert.equal(kpi("posts_measured").note, "2 without data");
    assert.equal(kpi("followers").value, 6 + 0, "followers gained over the range; the disconnected account is not counted");
    assert.equal(kpi("followers").note, "across 2 accounts");
    assert.equal(screen.accounts.length, 3, "a disconnected account has no row");
    assert.equal(screen.accounts.find((a) => a.id === "sa-l")!.status, "reconnect");
    assert.deepEqual(screen.daily.at(-1)!.values, { x: 1000 }, "Threads sent nothing today: missing, not zero");
    const threads = screen.byAccount.find((a) => a.where.platform === "threads")!;
    assert.ok(threads.noDataSince, "an account silent for days says since when");
    assert.equal(threads.medianImpressions, null);
    const x = screen.byAccount.find((a) => a.where.platform === "x")!;
    assert.equal(x.change, 6, "followers over the range");
    assert.equal(x.medianImpressions, median([4000, 1000, 900, 100, 950, 1100]));
    assert.equal(screen.posts[0]!.id, "a", "best first");
    assert.equal(screen.posts[0]!.url, "https://x.com/me/status/1");
    assert.equal(screen.posts.at(-1)!.id, "d", "worst last");
    assert.ok(screen.posts.every((p) => p.url === null || p.url.startsWith("https://")));
    assert.deepEqual(screen.brainReads, []);

    const empty = buildAnalytics({ range: 30, now, accounts: [], days: [], posts: [], publishedInRange: 0 });
    AnalyticsScreenSchema.parse(empty);
    assert.ok(empty.kpis.filter((k) => k.key !== "posts_measured").every((k) => k.value === null), "nothing measured: dashes, not zeros");

    const results = buildResults({ now, accounts, days, posts });
    results.rows.forEach((r) => ResultRowSchema.parse(r));
    const xr = results.rows.find((r) => r.where.platform === "x")!;
    assert.equal(xr.impressions, 7000);
    assert.equal(xr.followers, 6);
    assert.match(xr.best ?? "", /^Post a · 4(\.\d)?×$/);
    assert.equal(results.rows.find((r) => r.where.platform === "threads")!.series.at(-1), null);

    // A post Zernio gave no reach number for (no views, no impressions): a dash, and out of the median.
    const unreported: PostIn = { ...post("n", 0, 1), views: null, impressions: null, engagements: null, likes: null, replies: null, reposts: null };
    const withGap = buildAnalytics({ range: 7, now, accounts, days, posts: [...posts, unreported], publishedInRange: 9 });
    AnalyticsScreenSchema.parse(withGap);
    assert.equal(withGap.byAccount.find((a) => a.where.platform === "x")!.medianImpressions, x.medianImpressions, "not counted as zero");
    const gapRow = withGap.posts.find((p) => p.id === "n");
    assert.ok(!gapRow || (gapRow.impressions === null && gapRow.engagementRate === null && gapRow.vsMedian === null), "shown as a dash");
  }

  // A4: the brain's measures; an empty week is dashes, not zeros.
  const none: WeekCounts = { plans: { asIs: 0, decided: 0 }, drafts: { asIs: 0, total: 0 }, orders: { onTime: 0, due: 0 }, credits: { spent: 0, approved: 0 }, replans: 0 };
  const week: WeekCounts = { plans: { asIs: 1, decided: 2 }, drafts: { asIs: 8, total: 13 }, orders: { onTime: 12, due: 14 }, credits: { spent: 42, approved: 13 }, replans: 1 };
  const m = buildMeasures(week, { ...none, drafts: { asIs: 5, total: 10 } });
  m.forEach((x) => MeasureSchema.parse(x));
  assert.deepEqual(m.map((x) => x.value), [50, 62, 86, 3.2, 1]);
  assert.deepEqual(m.map((x) => x.change), [null, 12, null, null, 1], "a change only against a week with data");
  assert.equal(m[3]!.note, "13 approved, 42 credits");
  assert.ok(buildMeasures(none, none).every((x) => x.value === null && x.note === null));

  // F14: the rail's Schedule line, in the founder's timezone; short enough for a 184 px rail.
  const noon = new Date("2026-10-31T05:00:00Z");
  assert.equal(nextPostText("2026-10-31T09:00:00Z", "Asia/Ho_Chi_Minh", noon), "Next post 16:00");
  assert.equal(nextPostText("2026-11-02T02:00:00Z", "Asia/Ho_Chi_Minh", noon), "Next post Mon 9:00");
  assert.equal(nextPostText("2026-11-02T02:00:00Z", "Not/AZone", noon), "Next post Mon 2:00", "a bad timezone falls back to UTC");
  assert.ok(nextPostText("2026-11-04T23:59:00Z", "UTC", noon).length <= 20);

  // A2: the schedule card's one-line reason for its time.
  assert.deepEqual([0, 9, 12, 16].map(hourLabel), ["12 am", "9 am", "12 pm", "4 pm"]);
  assert.equal(bestTimeWhy("x", 9, 0, [{ hour: 9 }, { hour: 14 }], ["09:00"]), "Your posts on X do best around 9 am.");
  assert.equal(bestTimeWhy("x", 10, 30, [{ hour: 9 }], ["09:00"]), null, "a time moved off the best hours has no reason");
  assert.equal(bestTimeWhy("threads", 12, 0, [], ["09:00", "12:00"]), "A common best time on Threads, until your own posts say better.");
  assert.equal(bestTimeWhy("threads", 13, 0, [], ["09:00", "12:00"]), null);

  console.log("analytics: Zernio parsing, 402, pull_metrics with the fake, Analytics and results from stored numbers, best-time reasons");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
