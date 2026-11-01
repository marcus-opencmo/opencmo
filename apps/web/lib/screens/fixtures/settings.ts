import type { SettingsScreen } from "../settings";
import { ACCOUNTS, TZ } from "./shared";

/** `Settings.dc.html`. */
export const settingsFixture: SettingsScreen = {
  accounts: ACCOUNTS.filter((a) => a.platform !== "youtube"),
  cmo: { mode: "opencmo", pausedAt: null },
  weeklyCreditBudget: 80,
  timezone: TZ,
  digestHour: 7,
  plan: { name: "Starter", credits: 312 },
};

export const settingsEmpty: SettingsScreen = {
  accounts: [],
  cmo: { mode: "opencmo", pausedAt: null },
  weeklyCreditBudget: 0,
  timezone: "UTC",
  digestHour: null,
  plan: { name: "Free", credits: null },
};
