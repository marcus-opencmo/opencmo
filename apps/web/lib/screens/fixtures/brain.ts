import type { BrainScreen } from "../brain";
import { at } from "./shared";

/** `Brain.dc.html`, This week tab. */
export const brainFixture: BrainScreen = {
  cmo: { mode: "opencmo", pausedAt: null },
  week: { goal: "Launch the editor", done: 9, total: 14, credits: { used: 38, budget: 80 }, nextCheckAt: at("2026-10-29", "18:00") },
  orders: [
    { id: "o-video", parentId: null, title: "Long video “Editor launch”", department: "studio", dueAt: at("2026-10-29", "18:00"), dueText: null, credits: { used: 22, budget: 40 }, state: "running", stateText: "Running", approvalId: null },
    { id: "o-brief", parentId: "o-video", title: "Video brief", department: "writer", dueAt: at("2026-10-27", "18:00"), dueText: null, credits: { used: 1, budget: 2 }, state: "done", stateText: "Done", approvalId: null },
    { id: "o-shorts", parentId: "o-video", title: "3 shorts", department: "studio", dueAt: at("2026-10-30", "18:00"), dueText: null, credits: { used: 0, budget: 2 }, state: "waiting_order", stateText: "Waits on video", approvalId: null },
    { id: "o-captions", parentId: "o-shorts", title: "Captions + hashtags", department: "writer", dueAt: at("2026-10-30", "18:00"), dueText: null, credits: { used: 0, budget: 1 }, state: "waiting_order", stateText: "Waits on shorts", approvalId: null },
    { id: "o-posts", parentId: null, title: "5 posts", department: "writer", dueAt: null, dueText: "Mon–Sat", credits: { used: 4, budget: 5 }, state: "waiting_founder", stateText: "1 waits on you", approvalId: "card-post" },
    { id: "o-slides", parentId: null, title: "Slideshow “3 ways to cut a demo”", department: "studio", dueAt: at("2026-10-28", "18:00"), dueText: null, credits: { used: 0, budget: 3 }, state: "done", stateText: "Done", approvalId: null },
    { id: "o-replies", parentId: null, title: "2 Reddit replies", department: "sales", dueAt: at("2026-10-29", "18:00"), dueText: null, credits: { used: 5, budget: 5 }, state: "failed", stateText: "Stuck: budget", approvalId: "card-reply" },
    { id: "o-review", parentId: null, title: "Sunday review", department: "research", dueAt: at("2026-11-01", "07:00"), dueText: null, credits: { used: 0, budget: 3 }, state: "queued", stateText: "Queued", approvalId: null },
  ],
  learned: [
    { id: "l-1", kind: "lesson", scope: "X", text: "Demo clips in the first post of the day did better than text.", source: "From last week's results", at: at("2026-10-25", "07:00"), deletable: false },
    { id: "l-2", kind: "rule", scope: "you approved", text: "Don't open posts with a question.", source: "From 3 edits · Sunday", at: at("2026-10-25", "07:00"), deletable: true },
    { id: "l-3", kind: "skip_reason", scope: "Sales", text: "Not agencies; solo founders only.", source: "You dismissed 2 threads with this", at: at("2026-10-24", "15:00"), deletable: true },
    { id: "l-4", kind: "goal_result", scope: "last week", text: "Missed: 3 of 5 posts went out (Threads disconnected).", source: "This week checks accounts first", at: at("2026-10-25", "07:00"), deletable: false },
  ],
  corrections: [{ id: "correction-sample", rule: "Don't open posts with a question.", status: "active", at: at("2026-10-25", "07:00"), approvalId: null }],
  pastWeeks: [
    { week: "2026-10-19", goal: "Post every weekday on X", result: "Missed: 3 of 5 posts went out (Threads disconnected).", done: 9, total: 12, credits: { used: 51, budget: 80 } },
    { week: "2026-10-12", goal: "Set up the CMO", result: "Done: documents checked, first 4 posts approved.", done: 6, total: 6, credits: { used: 22, budget: 80 } },
  ],
  measures: [
    { key: "plan_accepted", value: 50, unit: "percent", change: 17, target: "Half of plans", note: "2 of 4 plans" },
    { key: "drafts_as_is", value: 62, unit: "percent", change: 8, target: "Rising week over week", note: "8 of 13 drafts" },
    { key: "orders_on_time", value: 86, unit: "percent", change: -4, target: "Most", note: "12 of 14 orders" },
    { key: "credits_per_approved", value: 3.2, unit: "credits", change: -0.6, target: "Falling week over week", note: "13 approved, 42 credits" },
    { key: "replans", value: 1, unit: "count", change: 0, target: "Few", note: null },
  ],
};

export const brainEmpty: BrainScreen = {
  cmo: { mode: "opencmo", pausedAt: null },
  week: { goal: null, done: 0, total: 0, credits: { used: 0, budget: 0 }, nextCheckAt: null },
  orders: [],
  learned: [],
  corrections: [],
  pastWeeks: [],
  measures: [
    { key: "plan_accepted", value: null, unit: "percent", change: null, target: "Half of plans", note: null },
    { key: "drafts_as_is", value: null, unit: "percent", change: null, target: "Rising week over week", note: null },
    { key: "orders_on_time", value: null, unit: "percent", change: null, target: "Most", note: null },
    { key: "credits_per_approved", value: null, unit: "credits", change: null, target: "Falling week over week", note: null },
    { key: "replans", value: null, unit: "count", change: null, target: "Few", note: null },
  ],
};
