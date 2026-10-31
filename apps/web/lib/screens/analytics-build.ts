/**
 * Analytics and the Dashboard's results from stored numbers (P6 A1, F5): `account_metrics` per connected account
 * per day (Zernio) and `post_metrics` per post (Zernio or the public reading). Pure, so `screens.check.ts` runs it.
 *
 * A number nobody reported stays null (a dash, a gap in the chart), never zero. No model reads these numbers here:
 * `brainReads` stays empty until the brain writes its own lines.
 */

import type { Account, Platform } from "./common";
import { PLATFORMS } from "./common";
import type { AnalyticsScreen, Range } from "./analytics";
import type { DashboardScreen } from "./dashboard";

export type AccountIn = { id: string; platform: string; handle: string; avatarUrl: string | null; status: string; updatedAt: string };
export type AccountDayIn = {
  social_account_id: string | null;
  platform: string;
  handle: string;
  day: string;
  followers: number | null;
  impressions: number | null;
  engagements: number | null;
  video_views: number | null;
  measured_at: string;
};
/** The newest reading of one published post. */
export type PostIn = {
  id: string;
  title: string;
  platform: string;
  publishedAt: string;
  /** Null: not reported (Zernio leaves out what a platform does not give), never zero. */
  views: number | null;
  impressions: number | null;
  engagements: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  url: string | null;
};

const DAY_MS = 86_400_000;
/** An account that sent nothing for this long shows "no data since" instead of numbers. */
const STALE_DAYS = 3;
const MIN_POSTS_TO_JUDGE = 3;

const isPlatform = (p: string): p is Platform => (PLATFORMS as readonly string[]).includes(p);
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const sumOrNull = (values: (number | null)[]): number | null => (values.some((v) => v !== null) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : null);
const round1 = (n: number) => Math.round(n * 10) / 10;

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The days of a range ending today, oldest first. */
export function rangeDays(now: Date, days: number): string[] {
  const end = Date.parse(`${dayOf(now.getTime())}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => dayOf(end - (days - 1 - i) * DAY_MS));
}

/** Null when the post has no reach number at all: it is left out of medians and sums, and shows a dash. */
const reach = (p: PostIn): number | null => p.impressions ?? p.views;
const engaged = (p: PostIn): number | null => p.engagements ?? sumOrNull([p.likes, p.replies, p.reposts]);
const rate = (eng: number | null, impressions: number | null) => (eng !== null && impressions !== null && impressions > 0 ? round1((eng / impressions) * 100) : null);
const reachOf = (ps: PostIn[]): number[] => ps.map(reach).filter((v): v is number => v !== null);
const byReach = (x: PostIn, y: PostIn) => (reach(y) ?? -1) - (reach(x) ?? -1);

/** Connected or broken accounts as the screens show them; a disconnected account keeps its history but no row. */
export function analyticsAccounts(accounts: AccountIn[], days: AccountDayIn[]): Account[] {
  return accounts.flatMap((a): Account[] => {
    if (!isPlatform(a.platform) || a.status === "disconnected") return [];
    const connected = a.status === "connected";
    const last = days.filter((d) => d.social_account_id === a.id).reduce<string | null>((m, d) => (m && m > d.measured_at ? m : d.measured_at), null);
    return [{
      id: a.id,
      platform: a.platform,
      handle: a.handle.slice(0, 80),
      avatarUrl: a.avatarUrl,
      status: connected ? "connected" : "reconnect",
      syncedAt: last ? new Date(last).toISOString() : null,
      noDataSince: connected ? null : new Date(a.updatedAt).toISOString(),
    }];
  });
}

/** When an account last sent a number, if that is long enough ago to say so; null while it is fresh. */
function noDataSince(account: AccountIn, days: AccountDayIn[], now: Date): string | null {
  if (account.status !== "connected") return new Date(account.updatedAt).toISOString();
  const mine = days.filter((d) => d.social_account_id === account.id && (d.impressions !== null || d.followers !== null));
  if (!mine.length) return null;
  const last = mine.reduce((m, d) => (d.day > m ? d.day : m), "");
  return Date.parse(`${last}T00:00:00Z`) < now.getTime() - STALE_DAYS * DAY_MS ? new Date(`${last}T00:00:00Z`).toISOString() : null;
}

function followersAt(days: AccountDayIn[], accountId: string, until: string): number | null {
  let best: AccountDayIn | null = null;
  for (const d of days) if (d.social_account_id === accountId && d.followers !== null && d.day <= until && (!best || d.day > best.day)) best = d;
  return best?.followers ?? null;
}

function followerChange(days: AccountDayIn[], accountId: string, from: string, to: string): number | null {
  const end = followersAt(days, accountId, to);
  const start = followersAt(days, accountId, from);
  return end !== null && start !== null ? end - start : null;
}

function percentChange(now: number | null, before: number | null): number | null {
  if (now === null || before === null || before === 0) return null;
  return Math.round(((now - before) / before) * 100);
}

export type AnalyticsInput = { range: Range; now: Date; accounts: AccountIn[]; days: AccountDayIn[]; posts: PostIn[]; publishedInRange: number };

export function buildAnalytics({ range, now, accounts, days, posts, publishedInRange }: AnalyticsInput): AnalyticsScreen {
  const current = rangeDays(now, range);
  const previous = rangeDays(new Date(now.getTime() - range * DAY_MS), range);
  const inDays = (set: string[]) => {
    const s = new Set(set);
    return days.filter((d) => s.has(d.day));
  };
  const cur = inDays(current);
  const prev = inDays(previous);
  const from = current[0]!;
  const prevFrom = previous[0]!;
  const curPosts = posts.filter((p) => p.publishedAt.slice(0, 10) >= from);
  const prevPosts = posts.filter((p) => p.publishedAt.slice(0, 10) >= prevFrom && p.publishedAt.slice(0, 10) < from);

  // Account days measure everything an account did; without them (public reading only) the posts are all there is.
  const impressionsOf = (rows: AccountDayIn[], ps: PostIn[]) => (rows.some((d) => d.impressions !== null) ? sumOrNull(rows.map((d) => d.impressions)) : sumOrNull(ps.map(reach)));
  const engagementsOf = (rows: AccountDayIn[], ps: PostIn[]) => (rows.some((d) => d.engagements !== null) ? sumOrNull(rows.map((d) => d.engagements)) : sumOrNull(ps.map(engaged)));
  const impressions = impressionsOf(cur, curPosts);
  const engagements = engagementsOf(cur, curPosts);
  const prevImpressions = impressionsOf(prev, prevPosts);
  const prevEngagements = engagementsOf(prev, prevPosts);
  const engagementRate = impressions !== null && engagements !== null ? rate(engagements, impressions) : null;
  const prevRate = prevImpressions !== null && prevEngagements !== null ? rate(prevEngagements, prevImpressions) : null;
  const videoViews = sumOrNull(cur.map((d) => d.video_views));

  const live = accounts.filter((a) => a.status !== "disconnected" && isPlatform(a.platform));
  // "Followers gained": the change over the range, summed over the accounts that reported both ends.
  const followerValues = live.map((a) => followerChange(days, a.id, from, current.at(-1)!)).filter((f): f is number => f !== null);
  const followers = followerValues.length ? followerValues.reduce((a, b) => a + b, 0) : null;
  const withoutData = Math.max(0, publishedInRange - curPosts.length);

  const kpis: AnalyticsScreen["kpis"] = [
    { key: "impressions", value: impressions, change: percentChange(impressions, prevImpressions), changeUnit: "percent", note: null },
    { key: "engagements", value: engagements, change: percentChange(engagements, prevEngagements), changeUnit: "percent", note: null },
    {
      key: "engagement_rate",
      value: engagementRate,
      change: engagementRate !== null && prevRate !== null ? round1(engagementRate - prevRate) : null,
      changeUnit: "points",
      note: null,
    },
    { key: "followers", value: followers, change: null, changeUnit: "percent", note: followerValues.length ? `across ${followerValues.length} account${followerValues.length === 1 ? "" : "s"}` : null },
    { key: "video_views", value: videoViews, change: percentChange(videoViews, sumOrNull(prev.map((d) => d.video_views))), changeUnit: "percent", note: null },
    { key: "posts_measured", value: curPosts.length, change: null, changeUnit: "percent", note: withoutData ? `${withoutData} without data` : null },
  ];

  const daily: AnalyticsScreen["daily"] = current.map((day) => {
    const values: AnalyticsScreen["daily"][number]["values"] = {};
    for (const d of cur) {
      if (d.day !== day || !isPlatform(d.platform) || d.impressions === null) continue;
      values[d.platform] = (values[d.platform] ?? 0) + d.impressions;
    }
    return { day, values };
  });

  const medianByPlatform = new Map<string, number | null>();
  for (const p of PLATFORMS) medianByPlatform.set(p, median(reachOf(curPosts.filter((x) => x.platform === p))));

  const byAccount: AnalyticsScreen["byAccount"] = live.map((a) => {
    const mine = curPosts.filter((p) => p.platform === a.platform);
    const top = [...mine].sort(byReach)[0];
    const impr = sumOrNull(mine.map(reach));
    return {
      where: { platform: a.platform as Platform, handle: a.handle.slice(0, 80) },
      followers: followersAt(days, a.id, current.at(-1)!),
      change: followerChange(days, a.id, from, current.at(-1)!),
      posts: mine.length,
      medianImpressions: reachOf(mine).length ? Math.round(median(reachOf(mine))!) : null,
      engagementRate: mine.length ? rate(sumOrNull(mine.map(engaged)), impr) : null,
      worksBest: !mine.length ? null : mine.length < MIN_POSTS_TO_JUDGE || !top ? "Not enough posts yet" : `“${top.title}”`.slice(0, 120),
      noDataSince: noDataSince(a, days, now),
    };
  });

  const scored = curPosts.map((p) => {
    const m = medianByPlatform.get(p.platform) ?? null;
    const r = reach(p);
    return { p, vs: m && m > 0 && r !== null ? round1(r / m) : null };
  });
  const ranked = [...scored].sort((a, b) => (b.vs ?? 0) - (a.vs ?? 0) || byReach(a.p, b.p));
  // Best three, then the worst two that are not already shown.
  const picked = ranked.length <= 5 ? ranked : [...ranked.slice(0, 3), ...ranked.slice(-2)];
  const postRows: AnalyticsScreen["posts"] = picked.flatMap(({ p, vs }) =>
    isPlatform(p.platform)
      ? [{
          id: p.id,
          title: p.title.slice(0, 200),
          platform: p.platform,
          impressions: reach(p),
          engagementRate: rate(engaged(p), reach(p)),
          vsMedian: vs,
          read: null,
          url: p.url && p.url.startsWith("https://") ? p.url : null,
        }]
      : [],
  );

  return { range, accounts: analyticsAccounts(accounts, days), kpis, daily, brainReads: [], byAccount, posts: postRows };
}

/** The Dashboard's results: the last seven days per account. */
export function buildResults({ now, accounts, days, posts }: Omit<AnalyticsInput, "range" | "publishedInRange">): DashboardScreen["results"] {
  const week = rangeDays(now, 7);
  const from = week[0]!;
  const rows = accounts
    .filter((a) => a.status !== "disconnected" && isPlatform(a.platform))
    .map((a) => {
      const mine = days.filter((d) => d.social_account_id === a.id);
      const series = week.map((day) => mine.find((d) => d.day === day)?.impressions ?? null);
      const myPosts = posts.filter((p) => p.platform === a.platform && p.publishedAt.slice(0, 10) >= from);
      const m = median(reachOf(myPosts));
      const top = [...myPosts].sort(byReach)[0];
      const topReach = top ? reach(top) : null;
      const impressions = series.some((v) => v !== null) ? sumOrNull(series) : sumOrNull(myPosts.map(reach));
      return {
        where: { platform: a.platform as Platform, handle: a.handle.slice(0, 80) },
        impressions,
        series,
        followers: followerChange(days, a.id, from, week.at(-1)!),
        best: top ? `${top.title.slice(0, 90)}${m && m > 0 && myPosts.length >= MIN_POSTS_TO_JUDGE && topReach !== null ? ` · ${round1(topReach / m)}×` : ""}` : null,
        noDataSince: noDataSince(a, days, now),
      };
    });
  return { rows, brainUsed: null };
}
