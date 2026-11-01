import type { ScheduleScreen } from "../schedule";
import { ACCOUNTS, TZ, at } from "./shared";

export const scheduleFixture: ScheduleScreen = {
  timezone: TZ,
  from: at("2026-10-26", "00:00"),
  to: at("2026-11-02", "00:00"),
  slots: [
    { id: "sl-1", at: at("2026-10-26", "09:00"), where: { platform: "x", handle: "@opencmo" }, title: "Editor launch teaser", status: "posted", note: "4.1k views", approvalId: null, url: "https://x.com/opencmo/status/1850000000000000001" },
    { id: "sl-2", at: at("2026-10-26", "16:00"), where: { platform: "linkedin", handle: "Marcus" }, title: "Why we built the editor first", status: "posted", note: null, approvalId: null },
    { id: "sl-3", at: at("2026-10-27", "09:10"), where: { platform: "x", handle: "@opencmo" }, title: "Cut by words, a 20 s demo", status: "posted", note: null, approvalId: null },
    { id: "sl-4", at: at("2026-10-28", "12:00"), where: { platform: "threads", handle: "@opencmo" }, title: "Slideshow: 3 ways to cut a demo", status: "posted", note: null, approvalId: null },
    { id: "sl-5", at: at("2026-10-29", "08:00"), where: { platform: "threads", handle: "@opencmo" }, title: "Cut a video by deleting words", status: "failed", note: "reconnect", approvalId: null },
    { id: "sl-6", at: at("2026-10-29", "09:10"), where: { platform: "x", handle: "@opencmo" }, title: "Most AI video tools stop at the first draft", status: "posted", note: null, approvalId: null },
    { id: "sl-7", at: at("2026-10-29", "14:30"), where: { platform: "linkedin", handle: "Marcus" }, title: "What a week of approving cards taught me", status: "scheduled", note: null, approvalId: null },
    { id: "sl-8", at: at("2026-10-29", "18:00"), where: { platform: "tiktok", handle: "@opencmo" }, title: "Short 1 · Edit by asking", status: "waiting_founder", note: null, approvalId: "card-time" },
    { id: "sl-9", at: at("2026-10-30", "09:10"), where: { platform: "x", handle: "@opencmo" }, title: "Thread: building an editor as a marketing team of one", status: "scheduled", note: null, approvalId: null },
    { id: "sl-10", at: at("2026-10-30", "18:00"), where: { platform: "youtube", handle: "OpenCMO" }, title: "Short 2 · B-roll on the line", status: "proposed", note: null, approvalId: null },
    { id: "sl-11", at: at("2026-10-31", "11:00"), where: { platform: "instagram", handle: "@opencmo" }, title: "Short 3 · Cut by words", status: "proposed", note: null, approvalId: null },
  ],
  accounts: [
    ...ACCOUNTS.filter((a) => a.platform !== "youtube"),
    { id: "acc-instagram", platform: "instagram", handle: "", status: "not_connected", syncedAt: null, noDataSince: null },
  ],
  rules: [
    "At most 2 posts a day per platform, 3 hours apart.",
    "Best times come from your own results once there are 20 posts; until then, common defaults.",
    "Drag a slot to move it. A new time or account asks you again.",
    "Sunday review: no posts by default.",
  ],
};

export const scheduleEmpty: ScheduleScreen = { timezone: "UTC", from: at("2026-10-26", "00:00"), to: at("2026-11-02", "00:00"), slots: [], accounts: [], rules: [] };
