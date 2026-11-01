/**
 * The screen table: one entry per v2 screen, keyed by the name in `/api/v1/screens/[name]`.
 *
 * `live` lists the top-level fields whose loader reads real rows (brain plan W1-5 adds to it); every other field
 * is the fixture outside production and `empty` in production, so sample data never reaches a production user.
 * `release` lists the fields that must be live before the screen shows in production (the rail hides it until
 * then; nothing is shown as "coming soon").
 *
 * Pure module (no server-only): the check and the route import it; client pages import only the schemas.
 */

import type { z } from "zod";

import { AnalyticsScreenSchema } from "./analytics";
import { BrainScreenSchema } from "./brain";
import { DashboardScreenSchema } from "./dashboard";
import { analyticsEmpty, analyticsFixture } from "./fixtures/analytics";
import { brainEmpty, brainFixture } from "./fixtures/brain";
import { dashboardEmpty, dashboardFixture } from "./fixtures/dashboard";
import { libraryEmpty, libraryFixture } from "./fixtures/library";
import { researchEmpty, researchFixture } from "./fixtures/research";
import { salesEmpty, salesFixture } from "./fixtures/sales";
import { scheduleEmpty, scheduleFixture } from "./fixtures/schedule";
import { settingsEmpty, settingsFixture } from "./fixtures/settings";
import { setupEmpty, setupFixture } from "./fixtures/setup";
import { studioEmpty, studioFixture } from "./fixtures/studio";
import { writerEmpty, writerFixture } from "./fixtures/writer";
import { LibraryScreenSchema } from "./library";
import { ResearchScreenSchema } from "./research";
import { SalesScreenSchema } from "./sales";
import { ScheduleScreenSchema } from "./schedule";
import { SettingsScreenSchema } from "./settings";
import { SetupScreenSchema } from "./setup";
import { StudioScreenSchema } from "./studio";
import { WriterScreenSchema } from "./writer";

type Entry<S extends z.ZodObject> = {
  schema: S;
  fixture: z.infer<S>;
  empty: z.infer<S>;
  live: readonly (keyof z.infer<S> & string)[];
  release: readonly (keyof z.infer<S> & string)[];
};

function entry<S extends z.ZodObject>(e: Entry<S>): Entry<S> {
  return e;
}

export const SCREENS = {
  dashboard: entry({
    schema: DashboardScreenSchema,
    fixture: dashboardFixture,
    empty: dashboardEmpty,
    live: ["cmo", "week", "team", "log", "results", "outToday", "digest", "queue"],
    release: ["cmo", "week", "team", "log", "results", "outToday", "queue"],
  }),
  // P6 A1: from `account_metrics` and `post_metrics`. `brainReads` is live and empty until the brain writes its own lines.
  analytics: entry({ schema: AnalyticsScreenSchema, fixture: analyticsFixture, empty: analyticsEmpty, live: ["range", "accounts", "kpis", "daily", "brainReads", "byAccount", "posts"], release: ["accounts", "kpis", "daily", "byAccount", "posts"] }),
  brain: entry({
    schema: BrainScreenSchema,
    fixture: brainFixture,
    empty: brainEmpty,
    live: ["cmo", "week", "orders", "learned", "corrections", "pastWeeks", "measures"],
    release: ["cmo", "week", "orders", "learned", "corrections"],
  }),
  library: entry({
    schema: LibraryScreenSchema,
    fixture: libraryFixture,
    empty: libraryEmpty,
    live: ["site", "documents", "brandKits", "voice", "skills"],
    release: ["site", "documents", "brandKits", "voice", "skills"],
  }),
  research: entry({
    schema: ResearchScreenSchema,
    fixture: researchFixture,
    empty: researchEmpty,
    live: ["lastRunAt", "nextRunAt", "insights", "dropped", "results"],
    release: ["lastRunAt", "insights", "results"],
  }),
  // Drafts per platform (posts, captions, briefs for Studio) and the voice Writer reads (P3 A3).
  writer: entry({ schema: WriterScreenSchema, fixture: writerFixture, empty: writerEmpty, live: ["drafts", "voice"], release: ["drafts", "voice"] }),
  // Uploads come from /api/v1/projects on the page; `items` holds only generated work (none before S1).
  studio: entry({ schema: StudioScreenSchema, fixture: studioFixture, empty: studioEmpty, live: ["items", "team", "editStates"], release: ["items"] }),
  // P5 R1: the mention counter, the stuck banner and the founder's Sales settings read real rows.
  sales: entry({ schema: SalesScreenSchema, fixture: salesFixture, empty: salesEmpty, live: ["threads", "week", "mentions", "stuck", "settings"], release: ["threads", "week"] }),
  // P4 A3: slots, accounts and rules read schedule_slots and social_accounts.
  schedule: entry({
    schema: ScheduleScreenSchema,
    fixture: scheduleFixture,
    empty: scheduleEmpty,
    live: ["timezone", "from", "to", "slots", "accounts", "rules"],
    release: ["slots", "accounts"],
  }),
  settings: entry({
    schema: SettingsScreenSchema,
    fixture: settingsFixture,
    empty: settingsEmpty,
    // P4 A3: accounts read social_accounts (every publish platform, connected or not).
    live: ["accounts", "cmo", "weeklyCreditBudget", "timezone", "digestHour", "plan"],
    release: ["cmo", "weeklyCreditBudget", "timezone", "digestHour", "plan"],
  }),
  setup: entry({ schema: SetupScreenSchema, fixture: setupFixture, empty: setupEmpty, live: [], release: ["site", "step", "done", "documents"] }),
};

export type ScreenName = keyof typeof SCREENS;
export const SCREEN_NAMES = Object.keys(SCREENS) as ScreenName[];

export type ScreenData<N extends ScreenName> = (typeof SCREENS)[N]["fixture"];

/** What `GET /api/v1/screens/[name]` answers. `live[field]` false = sample (or empty in production). */
export type ScreenResponse<N extends ScreenName> = { data: ScreenData<N>; live: Record<keyof ScreenData<N>, boolean> };

export function isScreenName(name: string): name is ScreenName {
  return Object.hasOwn(SCREENS, name);
}

/** A screen shows in production only when every release field reads real rows. */
export function released(name: ScreenName): boolean {
  const { live, release } = SCREENS[name] as Entry<z.ZodObject>;
  return release.every((field) => live.includes(field));
}

/**
 * Builds the response from what the loader read. Only fields listed in `live` are taken from `loaded` (a loader
 * cannot make a field live by accident); the rest come from the fixture, or from `empty` in production and when
 * the caller asks for no samples. `sample` forces the pure fixture (look checks and e2e, never in production).
 */
export function compose<N extends ScreenName>(
  name: N,
  loaded: Partial<ScreenData<N>>,
  opts: { production: boolean; sample: boolean },
): ScreenResponse<N> {
  const screen = SCREENS[name] as unknown as Entry<z.ZodObject>;
  const useSample = opts.sample && !opts.production;
  const base = (opts.production ? screen.empty : screen.fixture) as Record<string, unknown>;
  const data: Record<string, unknown> = { ...base };
  const live: Record<string, boolean> = {};
  for (const field of Object.keys(base)) {
    let isLive = !useSample && screen.live.includes(field) && Object.hasOwn(loaded, field);
    if (isLive) {
      // A row the contract cannot carry drops only its own field back to the non-live value.
      const parsed = (screen.schema.shape[field] as z.ZodType).safeParse((loaded as Record<string, unknown>)[field]);
      if (parsed.success) data[field] = parsed.data;
      else {
        isLive = false;
        console.warn(`[screens] ${name}.${field} did not match the contract`, parsed.error.issues[0]);
      }
    }
    live[field] = isLive;
    if (!isLive && useSample) data[field] = (screen.fixture as Record<string, unknown>)[field];
  }
  return { data: screen.schema.parse(data) as ScreenData<N>, live: live as ScreenResponse<N>["live"] };
}
