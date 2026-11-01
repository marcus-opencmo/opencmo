/**
 * Sample values shared by the fixtures. The frames are drawn on Thursday 29 Oct 2026 in Asia/Ho_Chi_Minh;
 * every fixture uses that clock so screens agree with each other. Sample data, never product data.
 */

import type { Account } from "../common";

export const TZ = "Asia/Ho_Chi_Minh";

/** `at("2026-10-29", "10:42")` → an ISO time in the frames' time zone. */
export const at = (date: string, time: string): string => `${date}T${time}:00+07:00`;

export const NOW = at("2026-10-29", "10:42");

export const ACCOUNTS: Account[] = [
  { id: "acc-x", platform: "x", handle: "@opencmo", status: "connected", syncedAt: at("2026-10-29", "10:40"), noDataSince: null },
  { id: "acc-tiktok", platform: "tiktok", handle: "@opencmo", status: "connected", syncedAt: at("2026-10-29", "10:40"), noDataSince: null },
  { id: "acc-linkedin", platform: "linkedin", handle: "Marcus", status: "connected", syncedAt: at("2026-10-29", "09:42"), noDataSince: null },
  { id: "acc-threads", platform: "threads", handle: "@opencmo", status: "reconnect", syncedAt: at("2026-10-27", "08:00"), noDataSince: at("2026-10-27", "08:00") },
  { id: "acc-youtube", platform: "youtube", handle: "OpenCMO", status: "connected", syncedAt: at("2026-10-29", "07:42"), noDataSince: null },
];
