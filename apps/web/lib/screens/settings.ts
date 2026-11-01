/**
 * S12 Settings (`Settings.dc.html`).
 */

import { z } from "zod";

import { AccountSchema, CmoStateSchema } from "./common";

/** Bounds of the weekly credit budget; `save_cmo_settings` enforces the same (brain plan W1-1). */
export const BUDGET_MIN = 0;
export const BUDGET_MAX = 10_000;

export const SettingsScreenSchema = z.object({
  accounts: z.array(AccountSchema),
  cmo: CmoStateSchema,
  weeklyCreditBudget: z.number().int().min(BUDGET_MIN).max(BUDGET_MAX),
  /** IANA name, for example `Asia/Ho_Chi_Minh`. */
  timezone: z.string().max(64),
  /** Local hour of the morning digest, 0–23; null = off. */
  digestHour: z.number().int().min(0).max(23).nullable(),
  plan: z.object({ name: z.string().max(40), credits: z.number().int().nullable() }),
});
export type SettingsScreen = z.infer<typeof SettingsScreenSchema>;
