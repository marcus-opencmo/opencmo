import { TEAM } from "../common";
import type { DashboardScreen } from "../dashboard";
import { POST_CARD, PRICE_CARD, REPLY_CARD, SCHEDULE_CARD, SHORTS_CARD } from "./cards";
import { at } from "./shared";

/** `Main.dc.html` at 10:42:00, Thursday 29 Oct. */
export const dashboardFixture: DashboardScreen = {
  cmo: { mode: "opencmo", pausedAt: null },
  week: {
    goal: "Launch the editor",
    deliverables: { done: 9, total: 14 },
    workingNow: 3,
    wordsDraftedToday: 1840,
    credits: { used: 38, budget: 80 },
  },
  team: {
    brain: { state: "on_track", watching: 14, nextCheckAt: at("2026-10-29", "18:00") },
    nodes: [
      { department: "research", state: "idle", line: "Asleep until 18:00 · metrics run", waiting: 0 },
      { department: "writer", state: "working", line: "Drafting LinkedIn post · line 3", waiting: 1 },
      { department: "studio", state: "working", line: "Rendering shot 9 of 12 · 62%", waiting: 2 },
      { department: "sales", state: "stuck", line: "Stuck: scan over budget", waiting: 1 },
      { department: "schedule", state: "working", line: "Next slot at 14:30", waiting: 1 },
      { department: "publish", state: "idle", line: "Posted 1 of 3 today · next 14:30", waiting: 0 },
    ],
  },
  log: [
    { id: "log-1", at: at("2026-10-29", "10:42"), who: "writer", text: "Drafted line 3 of the LinkedIn post" },
    { id: "log-2", at: at("2026-10-29", "10:41"), who: "writer", text: "Cut “seamless”: a word you always delete" },
    { id: "log-3", at: at("2026-10-29", "10:40"), who: "research", text: "Queued the 18:00 metrics run" },
    { id: "log-4", at: at("2026-10-29", "10:38"), who: "publish", text: "Confirmed the X post went out at 09:10" },
    { id: "log-5", at: at("2026-10-29", "10:35"), who: "studio", text: "Chose the music bed “Morning desk”" },
  ],
  results: {
    rows: [
      { where: { platform: "x", handle: "@opencmo" }, impressions: 14200, series: [1500, 1800, 1700, 2600, 2200, 2100, 2300], followers: 48, best: "Cut by words, a 20 s demo · 2.8×", noDataSince: null },
      { where: { platform: "tiktok", handle: "@opencmo" }, impressions: 18900, series: [1900, 2400, 2200, 3100, 2800, 3300, 3200], followers: 61, best: "Short “Cut by words” · 2.9×", noDataSince: null },
      { where: { platform: "linkedin", handle: "Marcus" }, impressions: 2100, series: [200, 250, 300, 410, 280, 320, 340], followers: 12, best: null, noDataSince: null },
      { where: { platform: "threads", handle: "@opencmo" }, impressions: null, series: [310, 280, null, null, null, null, null], followers: null, best: null, noDataSince: at("2026-10-27", "08:00") },
    ],
    brainUsed: { lessons: 3, text: "Demo clips on X, shorts at 18:00, no question openers." },
  },
  outToday: [
    { id: "out-1", at: at("2026-10-29", "08:00"), where: { platform: "threads", handle: "@opencmo" }, text: "Cut a video by deleting words from its transcript.", status: "failed", problem: "reconnect account", approvalId: null },
    { id: "out-2", at: at("2026-10-29", "09:10"), where: { platform: "x", handle: "@opencmo" }, text: "Most AI video tools stop at the first draft.", status: "posted", problem: null, approvalId: null },
    { id: "out-3", at: at("2026-10-29", "14:30"), where: { platform: "linkedin", handle: "Marcus" }, text: "What a week of approving cards taught me.", status: "scheduled", problem: null, approvalId: null },
    { id: "out-4", at: at("2026-10-29", "18:00"), where: { platform: "tiktok", handle: "@opencmo" }, text: "Short 1 · “Edit by asking”", status: "waiting_founder", problem: null, approvalId: SCHEDULE_CARD.id },
  ],
  digest: {
    dateLabel: "Thursday 29 Oct",
    waiting: [POST_CARD, PRICE_CARD, SHORTS_CARD, REPLY_CARD, SCHEDULE_CARD].map((c) => ({ id: c.id, title: c.title, department: c.department })),
    wentOut: [{ title: "Most AI video tools stop at the first draft.", where: "X" }],
    stuck: [{ title: "2 Reddit replies", department: "sales", reason: "This week's Sales budget is used." }],
  },
  queue: [POST_CARD, PRICE_CARD, SHORTS_CARD, REPLY_CARD, SCHEDULE_CARD],
};

/** What production shows for a part that has no backend yet: nothing, never sample numbers. */
export const dashboardEmpty: DashboardScreen = {
  cmo: { mode: "opencmo", pausedAt: null },
  week: { goal: null, deliverables: { done: 0, total: 0 }, workingNow: 0, wordsDraftedToday: 0, credits: { used: 0, budget: 0 } },
  team: {
    brain: { state: "on_track", watching: 0, nextCheckAt: null },
    nodes: TEAM.map((department) => ({ department, state: "idle", line: "Idle", waiting: 0 })),
  },
  log: [],
  results: { rows: [], brainUsed: null },
  outToday: [],
  digest: null,
  queue: [],
};
