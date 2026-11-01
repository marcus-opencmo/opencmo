import type { ResearchScreen } from "../research";
import { at } from "./shared";

export const researchFixture: ResearchScreen = {
  lastRunAt: at("2026-10-25", "07:00"),
  nextRunAt: at("2026-11-01", "07:00"),
  insights: [
    { id: "i-1", type: "hook", scope: "competitors", platform: "X", text: "Before/after in the first line beats a feature list.", evidence: "3.4× the account's median views", usedIn: "used in Thursday's post", sources: ["https://x.com/sample/status/1"] },
    { id: "i-2", type: "format", scope: "niche_video", platform: "Shorts", text: "Screen recording with one zoom on the click, under 25 s.", evidence: "5 of the top 10 niche shorts", usedIn: "fed the video brief", sources: ["https://www.youtube.com/shorts/sample1", "https://www.youtube.com/shorts/sample2"] },
    { id: "i-3", type: "idea", scope: "competitors", platform: "LinkedIn", text: "“What I stopped doing” posts from solo founders.", evidence: "2 competitor outliers", usedIn: null, sources: ["https://www.linkedin.com/posts/sample-1", "https://www.linkedin.com/posts/sample-2"] },
  ],
  dropped: 2,
  results: [
    { id: "r-1", title: "Editor launch teaser", platform: "x", views: 4100, replies: 12 },
    { id: "r-2", title: "Editor first", platform: "linkedin", views: 710, replies: 4 },
    { id: "r-3", title: "Reply · r/SaaS", platform: "reddit", views: null, replies: 3 },
  ],
};

export const researchEmpty: ResearchScreen = { lastRunAt: null, nextRunAt: null, insights: [], dropped: 0, results: [] };
