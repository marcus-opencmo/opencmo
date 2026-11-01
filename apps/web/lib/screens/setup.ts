/**
 * S13 Setup (`Setup.dc.html`): five steps, replacing today's onboarding view under the flag.
 */

import { z } from "zod";

import { AccountSchema, iso } from "./common";

export const SETUP_STEPS = ["website", "documents", "accounts", "brand", "goal"] as const;

export const SetupScreenSchema = z.object({
  site: z.string().max(200).nullable(),
  /** The step the founder is on; earlier ones are done. */
  step: z.enum(SETUP_STEPS),
  done: z.array(z.enum(SETUP_STEPS)),
  documents: z.array(
    z.object({
      kind: z.enum(["product", "strategy", "competitors", "content_strategy"]),
      title: z.string().max(80),
      /** "9 fields", "drafted", "4 found". */
      note: z.string().max(60),
      updatedAt: iso.nullable(),
    }),
  ),
  accounts: z.array(AccountSchema),
  hasBrandKit: z.boolean(),
  /** The proposed or approved goal of the first week. */
  goal: z.object({ id: z.string(), text: z.string().max(200), status: z.enum(["proposed", "approved"]) }).nullable(),
});
export type SetupScreen = z.infer<typeof SetupScreenSchema>;
