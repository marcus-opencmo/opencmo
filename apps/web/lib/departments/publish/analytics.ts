/**
 * Zernio's analytics for the founder's own connected accounts (P6 A1, F5). Kept apart from the publish adapter:
 * reading numbers never posts, and it needs Zernio's analytics add-on (a 402 without it), which is its own owner gate.
 *
 * Endpoints, from Zernio's OpenAPI (`zernio.com/openapi.json`, v1.429.1, read 2026-10-31):
 * - `GET /v1/analytics?profileId&source=late&fromDate&toDate&page&limit`: posts published through Zernio with their
 *   lifetime numbers, one `platformAnalytics` entry per account the post went to.
 * - `GET /v1/accounts/follower-stats?profileId&fromDate&toDate&granularity=daily`: follower history per account
 *   (refreshed once a day), `stats[accountId] = [{date, followers}]`.
 * - `GET /v1/analytics/daily-metrics?accountId&fromDate&toDate&attribution=received`: per-day sums for one account,
 *   with engagement counted on the day it arrived.
 *
 * Selection mirrors `adapter.ts`: the fake with `OPENCMO_PUBLISH_FAKE=1`, Zernio only with `ZERNIO_API_KEY` and
 * `OPENCMO_PUBLISH_LIVE=1`, otherwise none (the public reading still measures what it can).
 */

import { createHash } from "node:crypto";

import { PublishError, type PublishPlatform } from "./types";
import { ZERNIO_BASE_URL, fromZernioSlug, zernioError } from "./zernio";

/** One post's lifetime numbers on one account. A null number is "not reported", never zero. */
export type ZernioPostMetric = {
  /** Every id the post is known by (Zernio's post id and the platform's own), so a slot's `external_id` matches. */
  ids: string[];
  platform: PublishPlatform;
  zernioAccountId: string;
  url: string | null;
  views: number | null;
  impressions: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  engagements: number | null;
};

export type AccountRef = { zernioAccountId: string; platform: PublishPlatform; handle: string };

/** One account on one day. */
export type ZernioAccountDay = {
  zernioAccountId: string;
  day: string;
  followers: number | null;
  impressions: number | null;
  engagements: number | null;
  videoViews: number | null;
  posts: number | null;
};

export interface PublishAnalytics {
  readonly name: "zernio" | "fake";
  /** Posts published through Zernio under the profile between two days; `ids` are the posts we know of. */
  posts(input: { zernioProfileId: string; from: string; to: string; ids: string[] }): Promise<ZernioPostMetric[]>;
  /** Followers and per-day numbers of the given accounts, oldest day first. */
  accountDays(input: { zernioProfileId: string; from: string; to: string; accounts: AccountRef[] }): Promise<ZernioAccountDay[]>;
}

export function publishAnalytics(env: Record<string, string | undefined> = process.env): PublishAnalytics | null {
  if (env.OPENCMO_PUBLISH_FAKE === "1") return createFakeAnalytics();
  const apiKey = env.ZERNIO_API_KEY?.trim();
  if (apiKey && env.OPENCMO_PUBLISH_LIVE === "1") return createZernioAnalytics({ apiKey });
  return null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const sum = (...values: (number | null)[]): number | null => (values.every((v) => v === null) ? null : values.reduce<number>((a, v) => a + (v ?? 0), 0));
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Zernio's numbers for one post on one account. */
function metricOf(a: Json): Pick<ZernioPostMetric, "views" | "impressions" | "likes" | "replies" | "reposts" | "engagements"> {
  const likes = count(a.likes);
  const replies = count(a.comments);
  const reposts = count(a.reposts) ?? count(a.shares);
  return {
    views: count(a.views),
    impressions: count(a.impressions),
    likes,
    replies,
    reposts,
    engagements: sum(likes, replies, count(a.shares), count(a.saves), count(a.clicks)),
  };
}

/** `GET /v1/analytics` list page → one row per post and account. Exported for `analytics.check.ts`. */
export function parsePosts(body: unknown): ZernioPostMetric[] {
  const out: ZernioPostMetric[] = [];
  for (const raw of arr(obj(body).posts)) {
    const post = obj(raw);
    const postIds = [str(post._id), str(post.latePostId), str(post.postId)].filter((x): x is string => Boolean(x));
    for (const rawTarget of arr(post.platformAnalytics)) {
      const t = obj(rawTarget);
      const platform = fromZernioSlug(str(t.platform) ?? "");
      const account = str(t.accountId);
      if (!platform || !account) continue;
      const url = str(t.platformPostUrl);
      out.push({
        ids: [...new Set([...postIds, ...(str(t.platformPostId) ? [str(t.platformPostId)!] : [])])],
        platform,
        zernioAccountId: account,
        url: url && url.startsWith("https://") && url.length <= 500 ? url : null,
        ...metricOf(obj(t.analytics)),
      });
    }
  }
  return out;
}

/** `GET /v1/accounts/follower-stats` → followers per account per day. */
export function parseFollowers(body: unknown): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [account, points] of Object.entries(obj(obj(body).stats))) {
    const days = new Map<string, number>();
    for (const raw of arr(points)) {
      const p = obj(raw);
      const day = str(p.date)?.slice(0, 10);
      const followers = count(p.followers);
      if (day && DAY.test(day) && followers !== null) days.set(day, followers);
    }
    out.set(account, days);
  }
  return out;
}

/** `GET /v1/analytics/daily-metrics` → per-day sums of one account. */
export function parseDaily(body: unknown): Map<string, Omit<ZernioAccountDay, "zernioAccountId" | "day" | "followers">> {
  const out = new Map<string, Omit<ZernioAccountDay, "zernioAccountId" | "day" | "followers">>();
  for (const raw of arr(obj(body).dailyData)) {
    const d = obj(raw);
    const day = str(d.date)?.slice(0, 10);
    if (!day || !DAY.test(day)) continue;
    const m = obj(d.metrics);
    out.set(day, {
      impressions: count(m.impressions),
      engagements: sum(count(m.likes), count(m.comments), count(m.shares), count(m.saves), count(m.clicks)),
      videoViews: count(m.views),
      posts: count(d.postCount),
    });
  }
  return out;
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`) && out.length < 400; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function joinDays(account: AccountRef, from: string, to: string, followers: Map<string, number> | undefined, daily: ReturnType<typeof parseDaily>): ZernioAccountDay[] {
  return daysBetween(from, to)
    .filter((day) => followers?.has(day) || daily.has(day))
    .map((day) => ({
      zernioAccountId: account.zernioAccountId,
      day,
      followers: followers?.get(day) ?? null,
      impressions: daily.get(day)?.impressions ?? null,
      engagements: daily.get(day)?.engagements ?? null,
      videoViews: daily.get(day)?.videoViews ?? null,
      posts: daily.get(day)?.posts ?? null,
    }));
}

/** At most this many pages of 100 posts a run: a founder's two weeks fit in one. */
const MAX_PAGES = 5;
const TIMEOUT_MS = 20_000;

export function createZernioAnalytics(options: { apiKey: string; baseUrl?: string; fetch?: typeof fetch }): PublishAnalytics {
  const base = (options.baseUrl ?? ZERNIO_BASE_URL).replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;

  async function get(path: string, query: Record<string, string>): Promise<unknown> {
    const url = `${base}${path}?${new URLSearchParams(query).toString()}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        if (attempt === 0) continue;
        throw new PublishError("unavailable", "The analytics service did not answer. The numbers update tomorrow.", true);
      }
      let body: unknown = null;
      try {
        body = JSON.parse(await res.text());
      } catch {
        body = null;
      }
      if (res.status >= 500 && attempt === 0) continue;
      if (res.ok) return body;
      if (res.status === 402) throw new PublishError("not_configured", "Account numbers are not set up on our side yet.", false);
      throw zernioError(res.status, body, "reading its numbers");
    }
  }

  return {
    name: "zernio",
    async posts({ zernioProfileId, from, to }) {
      const out: ZernioPostMetric[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = await get("/analytics", { profileId: zernioProfileId, source: "late", fromDate: from, toDate: to, limit: "100", page: String(page) });
        const rows = parsePosts(body);
        out.push(...rows);
        if (arr(obj(body).posts).length < 100) break;
      }
      return out;
    },
    async accountDays({ zernioProfileId, from, to, accounts }) {
      const followers = parseFollowers(await get("/accounts/follower-stats", { profileId: zernioProfileId, fromDate: from, toDate: to, granularity: "daily" }));
      const out: ZernioAccountDay[] = [];
      for (const account of accounts) {
        const daily = parseDaily(
          await get("/analytics/daily-metrics", {
            accountId: account.zernioAccountId,
            fromDate: `${from}T00:00:00.000Z`,
            toDate: `${to}T23:59:59.999Z`,
            attribution: "received",
          }),
        );
        out.push(...joinDays(account, from, to, followers.get(account.zernioAccountId), daily));
      }
      return out;
    },
  };
}

/** A number from 0 to `max` that is the same for the same key: the fake's readings never change between runs. */
const stable = (max: number, ...key: string[]) => parseInt(createHash("sha256").update(key.join("\u0000")).digest("hex").slice(0, 8), 16) % (max + 1);

/**
 * The fake answers for the posts and accounts it is asked about, with steady numbers: views grow with the post's id
 * hash, followers climb a little each day. A post whose id ends in `0` reports no views, so Analytics' "not reported"
 * path is reached. It knows nothing about platforms or accounts: the job keys its rows by the slot it asked about.
 */
export function createFakeAnalytics(): PublishAnalytics {
  return {
    name: "fake",
    async posts({ ids }) {
      return ids.map((id) => {
        const views = id.endsWith("0") ? null : 200 + stable(4800, "views", id);
        const likes = stable(120, "likes", id);
        const replies = stable(30, "replies", id);
        const reposts = stable(20, "reposts", id);
        return {
          ids: [id],
          platform: "x" as PublishPlatform,
          zernioAccountId: "",
          url: null,
          views,
          impressions: views === null ? null : views + stable(2000, "impr", id),
          likes,
          replies,
          reposts,
          engagements: likes + replies + reposts,
        };
      });
    },
    async accountDays({ from, to, accounts }) {
      return accounts.flatMap((account) =>
        daysBetween(from, to).map((day, i) => {
          const start = 300 + stable(2000, "followers", account.zernioAccountId);
          const impressions = 400 + stable(3000, "day", account.zernioAccountId, day);
          return {
            zernioAccountId: account.zernioAccountId,
            day,
            followers: start + i * (1 + stable(4, "growth", account.zernioAccountId)),
            impressions,
            engagements: Math.round(impressions * (0.02 + stable(30, "rate", account.zernioAccountId) / 1000)),
            videoViews: account.platform === "x" || account.platform === "linkedin" || account.platform === "threads" ? null : impressions,
            posts: stable(2, "posts", account.zernioAccountId, day),
          };
        }),
      );
    },
  };
}
