/**
 * Where `pull_metrics` reads numbers from (P6 A0). `public`: the public reading of the founder's own posts through the
 * social reader (no account needed). `zernio`: per post, per account and follower numbers of the founder's connected
 * accounts through Zernio's analytics. A post is measured by one source only: Zernio when it went out through a
 * connected account, public otherwise.
 */

import type { ItemRow, MetricRow } from "./types";

export type MetricsSourceName = "public" | "zernio";

/** One connected account on one day. A null number is "not reported", never zero. */
export type AccountMetricRow = {
  /** `social_accounts.id`; the row stays when the account is disconnected later. */
  social_account_id: string;
  platform: "x" | "threads" | "linkedin" | "tiktok" | "youtube" | "instagram";
  handle: string;
  /** The founder's local day, `YYYY-MM-DD`. */
  day: string;
  followers: number | null;
  impressions: number | null;
  engagements: number | null;
  video_views: number | null;
  posts: number | null;
};

export interface MetricsSource {
  readonly name: MetricsSourceName;
  /** The posts among `items` this source can measure; the rest go to the next source. */
  covers(items: ItemRow[]): ItemRow[];
  /** Numbers for the covered posts; a post it could not read is left out, not zeroed. */
  posts(items: ItemRow[]): Promise<MetricRow[]>;
  /** Per account and per day; only a source that reads accounts (Zernio) has it. */
  accounts?(since: string): Promise<AccountMetricRow[]>;
}
