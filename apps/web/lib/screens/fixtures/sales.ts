import type { SalesScreen } from "../sales";
import { at } from "./shared";

export const salesFixture: SalesScreen = {
  mentions: { used: 0, window: 10 },
  stuck: { text: "Scan stopped. This week's Sales budget is used (5 of 5 credits).", creditsToFinish: 5, found: 4 },
  threads: [
    {
      id: "t-1",
      score: 78,
      community: "r/SaaS",
      postedAt: at("2026-10-29", "04:42"),
      comments: 41,
      title: "What do you use to edit product demos?",
      url: "https://www.reddit.com/r/SaaS/comments/sample/what_do_you_use_to_edit_product_demos/",
      rule: { kind: "mention_allowed", text: "Mention allowed" },
      parts: [
        { label: "Pain", score: 22, max: 25 },
        { label: "Fit", score: 20, max: 25 },
        { label: "Timing", score: 18, max: 20 },
        { label: "Reach", score: 9, max: 15 },
      ],
      quotes: [
        { text: "I spend more time cutting my demo than building the feature.", from: "original post" },
        { text: "Timeline editors are overkill for a 40 second clip.", from: "top comment" },
      ],
      draft:
        "Same problem here. What helped me: record once, then cut by deleting words from the transcript instead of scrubbing a timeline. Ums and retakes go in a minute. For a 40 second demo, add captions and one zoom on the click that matters, nothing else. I built a tool for this (OpenCMO), but the transcript approach works in most editors now.",
      draftChecks: "No links · product named once, at the end · r/SaaS allows it",
      status: "open",
      approvalId: "card-reply",
    },
    { id: "t-2", score: 71, community: "r/indiehackers", postedAt: at("2026-10-28", "10:00"), comments: 18, title: "Solo founders: how do you make launch videos?", url: "https://www.reddit.com/r/indiehackers/comments/sample2/", rule: { kind: "help_only", text: "Help only: no self-promotion rule" }, parts: [], quotes: [], draft: null, draftChecks: null, status: "open", approvalId: null },
    { id: "t-3", score: 66, community: "r/startups", postedAt: at("2026-10-27", "10:00"), comments: 9, title: "Descript alternative for short demos?", url: "https://www.reddit.com/r/startups/comments/sample3/", rule: { kind: "mention_allowed", text: "Mention allowed" }, parts: [], quotes: [], draft: null, draftChecks: null, status: "open", approvalId: null },
    { id: "t-4", score: 61, community: "r/marketing", postedAt: at("2026-10-26", "10:00"), comments: null, title: "Do AI captions hurt reach?", url: "https://www.reddit.com/r/marketing/comments/sample4/", rule: { kind: "skipped", text: "Skipped: subreddit bans tool mentions" }, parts: [], quotes: [], draft: null, draftChecks: null, status: "open", approvalId: null },
  ],
  week: { replied: 1, dismissed: 3 },
  settings: { excludedSubreddits: ["memes"], pairs: [["video", "editor"]] },
};

export const salesEmpty: SalesScreen = { mentions: { used: 0, window: 10 }, stuck: null, threads: [], week: { replied: 0, dismissed: 0 }, settings: { excludedSubreddits: [], pairs: [] } };
