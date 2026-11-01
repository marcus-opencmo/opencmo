import { KPI_KEYS, type AnalyticsScreen } from "../analytics";
import { ACCOUNTS, at } from "./shared";

/** 30 days ending Thu 29 Oct; Threads sends nothing from 27 Oct (missing, not zero). */
function daily(): AnalyticsScreen["daily"] {
  const days: AnalyticsScreen["daily"] = [];
  for (let i = 29; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(2026, 9, 29 - i));
    const dayIso = date.toISOString().slice(0, 10);
    const wave = (n: number) => Math.round(n * (1 + 0.35 * Math.sin((30 - i) / 3)));
    days.push({
      day: dayIso,
      values: {
        x: wave(1400),
        tiktok: wave(1700),
        linkedin: wave(260),
        threads: dayIso >= "2026-10-27" ? null : wave(300),
      },
    });
  }
  return days;
}

export const analyticsFixture: AnalyticsScreen = {
  range: 30,
  accounts: ACCOUNTS,
  kpis: [
    { key: "impressions", value: 114400, change: 18, changeUnit: "percent", note: null },
    { key: "engagements", value: 5032, change: 9, changeUnit: "percent", note: null },
    { key: "engagement_rate", value: 4.4, change: -0.3, changeUnit: "points", note: null },
    { key: "followers", value: 334, change: null, changeUnit: "percent", note: "across 5 accounts" },
    { key: "video_views", value: 51500, change: 31, changeUnit: "percent", note: null },
    { key: "posts_measured", value: 26, change: null, changeUnit: "percent", note: "4 without data" },
  ],
  daily: daily(),
  brainReads: [
    { text: "Demo clips beat text on X.", evidence: "2.8× your median impressions · 6 posts", feeds: "feeds Writer and Monday's plan" },
    { text: "Shorts at 18:00 do better than at noon.", evidence: "1.9× views · 5 shorts", feeds: "feeds Schedule's best times" },
    { text: "Question openers underperform.", evidence: "0.6× engagement · 4 posts", feeds: "matches the rule from your edits" },
    { text: "Not enough data on LinkedIn yet.", evidence: "3 of 10 posts needed before it changes anything", feeds: "" },
  ],
  byAccount: [
    { where: { platform: "x", handle: "@opencmo" }, followers: 2410, change: 148, posts: 12, medianImpressions: 1920, engagementRate: 3.9, worksBest: "Demo clip, morning", noDataSince: null },
    { where: { platform: "tiktok", handle: "@opencmo" }, followers: 880, change: 121, posts: 5, medianImpressions: 3400, engagementRate: 6.1, worksBest: "Short under 25 s, 18:00", noDataSince: null },
    { where: { platform: "linkedin", handle: "Marcus" }, followers: 1105, change: 43, posts: 3, medianImpressions: 640, engagementRate: 5.2, worksBest: "Not enough posts yet", noDataSince: null },
    { where: { platform: "threads", handle: "@opencmo" }, followers: 530, change: null, posts: 4, medianImpressions: null, engagementRate: null, worksBest: null, noDataSince: at("2026-10-27", "08:00") },
    { where: { platform: "youtube", handle: "OpenCMO" }, followers: 96, change: 22, posts: 2, medianImpressions: 1150, engagementRate: 4.0, worksBest: "Not enough posts yet", noDataSince: null },
  ],
  posts: [
    { id: "p-1", title: "Short · “Cut by words”", platform: "tiktok", impressions: 9820, engagementRate: 7.4, vsMedian: 2.9, read: "Before/after in the first 2 s", url: null },
    { id: "p-2", title: "“Cut by words, a 20 s demo”", platform: "x", impressions: 5410, engagementRate: 5.1, vsMedian: 2.8, read: "Demo clip attached", url: null },
    { id: "p-3", title: "“Why we built the editor first”", platform: "linkedin", impressions: 710, engagementRate: 6.0, vsMedian: 1.1, read: "Too few posts to judge", url: null },
    { id: "p-4", title: "“Tired of editing demos?”", platform: "x", impressions: 1050, engagementRate: 2.2, vsMedian: 0.5, read: "Question opener, text only", url: null },
  ],
};

export const analyticsEmpty: AnalyticsScreen = {
  range: 30,
  accounts: [],
  kpis: KPI_KEYS.map((key) => ({
    key,
    value: null,
    change: null,
    changeUnit: key === "engagement_rate" ? "points" : "percent",
    note: null,
  })),
  daily: [],
  brainReads: [],
  byAccount: [],
  posts: [],
};
