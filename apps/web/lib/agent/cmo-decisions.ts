import "server-only";

/**
 * Decisions from the CMO chat (plan 2026-11-02-cmo-chat-decisions): the founder approves, schedules or changes a
 * setting by asking, and confirms a card the chat shows. Each tool is planned as an approval card; nothing runs
 * until the founder confirms it, and then it calls the same RPC as the button.
 *
 * The card's content hash is read here, when the card is shown, and kept in the prepared input on the server: the
 * model never passes a hash, so it cannot decide a card the founder did not see. These tools are never offered over
 * MCP (`lib/cmo/mcp/cmo.ts` hides them).
 */

import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { firstRow, rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import { APPROVAL_COLUMNS, approvalToCard, type ApprovalRow } from "@/lib/screens/cards";
import { BUDGET_MAX, BUDGET_MIN } from "@/lib/screens/settings";

import type { PanelOpen } from "./panel";
import type { ToolOutcome, ToolSpec } from "./tools";

/** What the chat shows to confirm a decision: one line per change, in the founder's words. */
export type DecisionCard = { changes: string[]; credits?: number };

const CARD_ACTIONS = [
  "approve", "skip", "replied", "dismissed", "reject", "edit", "send_back", "cancel", "retry", "change_time", "change_account",
] as const;

export const DECISION_TOOL_SPECS: ToolSpec[] = [
  {
    name: "decide_card",
    description: [
      "Decide a card that waits on the founder in Approvals, ONLY when the founder asks for it in this message (\"approve the pricing post\", \"skip the second reply\").",
      "card_id comes from list_approvals. The founder sees a confirmation card and must confirm it; you never decide on your own.",
      "Actions by card kind: post approve|skip (text = the version to post, reason for skip); reply replied|dismissed; goal approve|reject (goal, target to edit);",
      "finished_video/shorts_batch/slideshow approve|send_back (reason); script/price approve|cancel; schedule approve|cancel|retry,",
      "change_time (publish_at = local time YYYY-MM-DDTHH:MM in the founder's time zone) or change_account (account_id from the card's platform, or null to copy and post by hand).",
    ].join(" "),
    schema: {
      type: "object",
      properties: {
        card_id: { type: "string" },
        action: { type: "string", enum: [...CARD_ACTIONS] },
        text: { type: "string", description: "Post or reply text the founder chose or edited." },
        reason: { type: "string" },
        goal: { type: "string" },
        target: { type: "integer" },
        publish_at: { type: "string", description: "Local time YYYY-MM-DDTHH:MM, for change_time." },
        account_id: { type: ["string", "null"], description: "A connected account id, for change_account." },
      },
      required: ["card_id", "action"],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    name: "mark_done",
    description:
      "Mark an approved post as posted, when the founder says they posted it themselves (copy and post). card_id from list_approvals or item_id from list_calendar; url = the post's link if they gave one. Confirmed on a card.",
    schema: {
      type: "object",
      properties: { card_id: { type: "string" }, item_id: { type: "string" }, url: { type: "string" } },
      additionalProperties: false,
    },
    strict: false,
  },
  {
    name: "set_sales_settings",
    description:
      "Change what Sales scans, when the founder asks: add or remove subreddits it never reads (\"stop showing r/memes\"), and pairs of terms a thread must both contain. Only the changes; the rest stays. Confirmed on a card.",
    schema: {
      type: "object",
      properties: {
        exclude: { type: "array", items: { type: "string" } },
        include: { type: "array", items: { type: "string" }, description: "Subreddits to read again." },
        add_pairs: { type: "array", items: { type: "array", items: { type: "string" } } },
        remove_pairs: { type: "array", items: { type: "array", items: { type: "string" } } },
      },
      additionalProperties: false,
    },
    strict: false,
  },
  {
    name: "set_cmo_paused",
    description: "Pause or resume the CMO when the founder asks. Paused, the schedule queues nothing and nothing new starts; the work is kept. Confirmed on a card.",
    schema: { type: "object", properties: { paused: { type: "boolean" } }, required: ["paused"], additionalProperties: false },
    strict: true,
  },
  {
    name: "update_cmo_settings",
    description:
      "Change the CMO's settings when the founder asks: weekly credit budget, time zone (IANA, like Europe/Berlin) or the morning digest hour (0-23, or null for no digest). Only the fields given change. Confirmed on a card.",
    schema: {
      type: "object",
      properties: {
        weekly_credit_budget: { type: "integer" },
        timezone: { type: "string" },
        digest_hour: { type: ["integer", "null"] },
      },
      additionalProperties: false,
    },
    strict: false,
  },
  {
    name: "get_credits",
    description: "Read the founder's credit balance and plan. Read only.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
];

export const DECISION_TOOLS = new Set(DECISION_TOOL_SPECS.map((spec) => spec.name));
/** Decisions that write: each goes through a confirmation card. */
export const DECISION_WRITES = new Set([...DECISION_TOOLS].filter((name) => name !== "get_credits"));

const uuid = z.string().uuid();
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "publish_at: YYYY-MM-DDTHH:MM");
const subreddit = z.string().trim().min(1).max(23);
const term = z.string().trim().min(1).max(60);
const pair = z.tuple([term, term]);

const cardInput = z.object({
  card_id: uuid,
  action: z.enum(CARD_ACTIONS),
  text: z.string().max(5000).optional(),
  reason: z.string().trim().max(400).optional(),
  goal: z.string().trim().min(3).max(200).optional(),
  target: z.number().int().min(1).max(1_000_000).optional(),
  publish_at: localTime.optional(),
  account_id: uuid.nullable().optional(),
});
const postedInput = z
  .object({ card_id: uuid.optional(), item_id: uuid.optional(), url: z.string().trim().url().max(500).optional() })
  .refine((v) => Boolean(v.card_id) !== Boolean(v.item_id), "Give card_id or item_id.");
const salesInput = z.object({
  exclude: z.array(subreddit).max(50).optional(),
  include: z.array(subreddit).max(50).optional(),
  add_pairs: z.array(pair).max(20).optional(),
  remove_pairs: z.array(pair).max(20).optional(),
});
const pauseInput = z.object({ paused: z.boolean() });
const settingsInput = z
  .object({
    weekly_credit_budget: z.number().int().min(BUDGET_MIN).max(BUDGET_MAX).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    digest_hour: z.number().int().min(0).max(23).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Give at least one setting.");

/** What `decide()` runs, kept with the pending tool call: the model cannot change it after the card was shown. */
export type Prepared =
  | { tool: "decide_card"; cardId: string; action: string; payload: Record<string, unknown>; contentHash: string; screen: PanelOpen }
  | { tool: "mark_done"; itemId: string; url: string | null }
  | { tool: "set_sales_settings"; excluded: string[]; pairs: [string, string][] }
  | { tool: "set_cmo_paused"; paused: boolean }
  | { tool: "update_cmo_settings"; budget: number; timezone: string; digestHour: number | null };

export type PreparedDecision = { ok: true; prepared: Prepared; card: DecisionCard } | { ok: false; content: string; summary: string };

const refused = (message: string, summary = "Could not prepare this"): PreparedDecision => ({
  ok: false,
  content: JSON.stringify({ INVALID_INPUT: message }),
  summary,
});

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const subredditName = (s: string) => s.trim().replace(/^\/?r\//i, "").toLowerCase();
const samePair = (a: [string, string], b: [string, string]) =>
  (a[0].toLowerCase() === b[0].toLowerCase() && a[1].toLowerCase() === b[1].toLowerCase()) ||
  (a[0].toLowerCase() === b[1].toLowerCase() && a[1].toLowerCase() === b[0].toLowerCase());

/** `YYYY-MM-DDTHH:MM` in `timeZone` → an ISO instant with offset (no library: two passes of Intl are exact). */
export function localToIso(local: string, timeZone: string): string {
  const [date, time] = local.split("T") as [string, string];
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (instant: number) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(instant))
      .reduce<Record<string, number>>((acc, p) => (p.type === "literal" ? acc : { ...acc, [p.type]: Number(p.value) }), {});
    return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!) - instant;
  };
  let instant = asUtc - offsetAt(asUtc);
  instant = asUtc - offsetAt(instant);
  return new Date(instant).toISOString();
}

/** The local time a card names, for the confirmation line ("Tue 4 Nov, 09:00"). */
function localLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

async function founderTimezone(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.from("profiles").select("timezone").maybeSingle<{ timezone: string | null }>();
  if (error) throw new ApiError(503, "Could not read your time zone. Try again in a moment.");
  return data?.timezone || "UTC";
}

const SCREEN_OF_KIND: Record<string, PanelOpen> = {
  post: { screen: "dashboard" },
  reply: { screen: "sales" },
  goal: { screen: "dashboard" },
  schedule: { screen: "schedule" },
  finished_video: { screen: "studio" },
  shorts_batch: { screen: "studio" },
  slideshow: { screen: "studio" },
  script: { screen: "studio" },
  price: { screen: "studio" },
  correction: { screen: "dashboard" },
};

const VERB: Record<string, string> = {
  approve: "Approve",
  skip: "Skip",
  replied: "Mark as replied",
  dismissed: "Dismiss",
  reject: "Reject",
  edit: "Edit",
  send_back: "Send back",
  cancel: "Cancel",
  retry: "Retry",
  change_time: "Move",
  change_account: "Post from another account",
};

async function prepareCard(supabase: SupabaseClient, raw: unknown): Promise<PreparedDecision> {
  const parsed = cardInput.safeParse(raw);
  if (!parsed.success) return refused("card_id must be a card id from list_approvals, and action one of the card's actions.");
  const input = parsed.data;
  const { data, error } = await supabase.from("approvals").select(APPROVAL_COLUMNS).eq("id", input.card_id).maybeSingle();
  if (error) return refused("Could not read that card right now. Try again in a moment.", "Could not read the card");
  const row = data as ApprovalRow | null;
  const card = row ? approvalToCard(row) : null;
  if (!row || !card) return refused("There is no card with that id. Read list_approvals again.", "Card not found");
  if (row.status !== "waiting") return refused(`That card is already ${row.status}.`, "Already decided");

  const payload: Record<string, unknown> = { source: "chat" };
  if (input.text !== undefined) payload.text = input.text;
  if (input.reason !== undefined) payload.reason = input.reason;
  if (input.goal !== undefined) payload.goal = input.goal;
  if (input.target !== undefined) payload.target = input.target;

  const changes: string[] = [];
  const what = `${clip(card.title, 120)}${card.meta ? ` (${clip(card.meta, 80)})` : ""}`;
  if (input.action === "change_time") {
    if (card.kind !== "schedule" || !input.publish_at) return refused("change_time is for schedule cards, with publish_at YYYY-MM-DDTHH:MM.");
    const zone = await founderTimezone(supabase);
    let iso: string;
    try {
      iso = localToIso(input.publish_at, zone);
    } catch {
      return refused(`publish_at could not be read in your time zone (${zone}).`);
    }
    if (Date.parse(iso) <= Date.now() + 60_000) return refused("That time has passed. Choose a time from now on.", "Time has passed");
    payload.publish_at = iso;
    changes.push(`Move "${what}" to ${localLabel(iso, zone)} (${zone})`);
  } else if (input.action === "change_account") {
    if (card.kind !== "schedule" || input.account_id === undefined) return refused("change_account is for schedule cards, with account_id (or null).");
    if (input.account_id !== null) {
      const { data: account } = await supabase.from("social_accounts").select("id, handle, platform").eq("id", input.account_id).maybeSingle<{ id: string; handle: string | null; platform: string }>();
      if (!account) return refused("That account is not one of your connected accounts.");
      changes.push(`Post "${what}" from ${account.platform} @${account.handle ?? "account"}`);
    } else {
      changes.push(`Copy and post "${what}" yourself instead`);
    }
    payload.account_id = input.account_id;
  } else {
    changes.push(`${VERB[input.action] ?? input.action} "${what}"`);
    if (input.text) changes.push(`Text: "${clip(input.text.replace(/\s+/g, " "), 200)}"`);
    if (input.reason) changes.push(`Reason: ${clip(input.reason, 160)}`);
    if (input.goal || input.target) changes.push(`Goal: ${input.goal ?? card.title}${input.target ? ` (target ${input.target})` : ""}`);
  }
  if (card.kind === "post" && input.action === "approve") changes.push("It goes out at its approved time; nothing is posted by OpenCMO now.");

  return {
    ok: true,
    prepared: {
      tool: "decide_card",
      cardId: row.id,
      action: input.action,
      payload,
      contentHash: row.content_hash,
      screen: SCREEN_OF_KIND[card.kind] ?? { screen: "dashboard" },
    },
    card: { changes, ...(card.priceCredits ? { credits: card.priceCredits } : {}) },
  };
}

async function preparePosted(supabase: SupabaseClient, raw: unknown): Promise<PreparedDecision> {
  const parsed = postedInput.safeParse(raw);
  if (!parsed.success) return refused("Give card_id (from list_approvals) or item_id (from list_calendar), and url if the founder gave the link.");
  let itemId = parsed.data.item_id;
  if (parsed.data.card_id) {
    const { data } = await supabase.from("approvals").select("ref_kind, ref_id").eq("id", parsed.data.card_id).maybeSingle<{ ref_kind: string; ref_id: string }>();
    if (!data || data.ref_kind !== "content_item") return refused("That card is not a post card.");
    itemId = data.ref_id;
  }
  const { data: item } = await supabase.from("content_items").select("id, idea, platform, status").eq("id", itemId!).maybeSingle<{ id: string; idea: string; platform: string | null; status: string }>();
  if (!item) return refused("There is no post with that id.", "Post not found");
  const url = parsed.data.url ?? null;
  return {
    ok: true,
    prepared: { tool: "mark_done", itemId: item.id, url },
    card: { changes: [`Mark "${clip(item.idea, 120)}"${item.platform ? ` on ${item.platform}` : ""} as posted`, ...(url ? [`Link: ${clip(url, 120)}`] : [])] },
  };
}

async function prepareSales(supabase: SupabaseClient, raw: unknown): Promise<PreparedDecision> {
  const parsed = salesInput.safeParse(raw);
  if (!parsed.success) return refused("exclude and include are subreddit names; add_pairs and remove_pairs are pairs of terms.");
  const { data, error } = await supabase.from("sales_settings").select("excluded_subreddits, co_occurrence").maybeSingle<{ excluded_subreddits: string[]; co_occurrence: [string, string][] }>();
  if (error) return refused("Could not read your Sales settings right now.", "Could not read settings");
  const excluded = new Set((data?.excluded_subreddits ?? []).map(subredditName));
  let pairs = [...(data?.co_occurrence ?? [])];
  const changes: string[] = [];
  for (const s of parsed.data.exclude ?? []) if (!excluded.has(subredditName(s))) (excluded.add(subredditName(s)), changes.push(`Never read r/${subredditName(s)}`));
  for (const s of parsed.data.include ?? []) if (excluded.delete(subredditName(s))) changes.push(`Read r/${subredditName(s)} again`);
  for (const p of parsed.data.add_pairs ?? []) if (!pairs.some((q) => samePair(q, p))) (pairs.push(p), changes.push(`Only threads with both "${p[0]}" and "${p[1]}"`));
  for (const p of parsed.data.remove_pairs ?? []) {
    const before = pairs.length;
    pairs = pairs.filter((q) => !samePair(q, p));
    if (pairs.length < before) changes.push(`Drop the pair "${p[0]}" + "${p[1]}"`);
  }
  if (!changes.length) return refused("Nothing would change: those settings are already in place.", "Nothing to change");
  if (excluded.size > 50 || pairs.length > 20) return refused("Sales takes at most 50 excluded subreddits and 20 term pairs.");
  return { ok: true, prepared: { tool: "set_sales_settings", excluded: [...excluded], pairs }, card: { changes } };
}

async function prepareSettings(supabase: SupabaseClient, raw: unknown): Promise<PreparedDecision> {
  const parsed = settingsInput.safeParse(raw);
  if (!parsed.success) return refused(`weekly_credit_budget ${BUDGET_MIN}-${BUDGET_MAX}, timezone like Europe/Berlin, digest_hour 0-23 or null.`);
  const { data, error } = await supabase.from("profiles").select("weekly_credit_budget, timezone, digest_hour").maybeSingle<{ weekly_credit_budget: number; timezone: string; digest_hour: number | null }>();
  if (error || !data) return refused("Could not read your settings right now.", "Could not read settings");
  const next = {
    budget: parsed.data.weekly_credit_budget ?? data.weekly_credit_budget,
    timezone: parsed.data.timezone ?? data.timezone,
    digestHour: parsed.data.digest_hour !== undefined ? parsed.data.digest_hour : data.digest_hour,
  };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: next.timezone });
  } catch {
    return refused(`"${next.timezone}" is not a time zone. Use one like Europe/Berlin.`);
  }
  const changes: string[] = [];
  if (next.budget !== data.weekly_credit_budget) changes.push(`Weekly credit budget: ${data.weekly_credit_budget} → ${next.budget}`);
  if (next.timezone !== data.timezone) changes.push(`Time zone: ${data.timezone} → ${next.timezone}`);
  if (next.digestHour !== data.digest_hour) changes.push(`Morning digest: ${data.digest_hour === null ? "off" : `${data.digest_hour}:00`} → ${next.digestHour === null ? "off" : `${next.digestHour}:00`}`);
  if (!changes.length) return refused("Nothing would change: those settings are already in place.", "Nothing to change");
  return { ok: true, prepared: { tool: "update_cmo_settings", ...next }, card: { changes } };
}

/** The confirmation card for a decision tool, or why it cannot be offered. Reads only. */
export async function prepareDecision(supabase: SupabaseClient, name: string, input: unknown): Promise<PreparedDecision> {
  switch (name) {
    case "decide_card":
      return prepareCard(supabase, input);
    case "mark_done":
      return preparePosted(supabase, input);
    case "set_sales_settings":
      return prepareSales(supabase, input);
    case "set_cmo_paused": {
      const parsed = pauseInput.safeParse(input);
      if (!parsed.success) return refused("paused must be true or false.");
      return {
        ok: true,
        prepared: { tool: "set_cmo_paused", paused: parsed.data.paused },
        card: {
          changes: parsed.data.paused
            ? ["Pause your CMO: nothing new starts and the schedule queues nothing", "Your work and cards are kept"]
            : ["Resume your CMO: paused work runs again and the schedule starts tomorrow"],
        },
      };
    }
    case "update_cmo_settings":
      return prepareSettings(supabase, input);
    default:
      return refused(`Unknown decision ${name}.`, "Unknown tool");
  }
}

const done = (summary: string, screen: PanelOpen, extra: Record<string, unknown> = {}): ToolOutcome => ({
  ok: true,
  content: JSON.stringify({ done: true, ...extra }),
  summary,
  view: { open: screen },
});

/** Runs a confirmed decision: the same RPC as the button, under the founder's own client. */
export async function runDecision(supabase: SupabaseClient, prepared: Prepared): Promise<ToolOutcome> {
  try {
    switch (prepared.tool) {
      case "decide_card": {
        const row = firstRow(
          await rpcOrThrow<ApprovalRow | ApprovalRow[]>(supabase, "approval_decide", {
            p_id: prepared.cardId,
            p_action: prepared.action,
            // `via` is 'app' (SQL accepts app or mcp); `source` says it came through the chat.
            p_payload: { ...prepared.payload, content_hash: prepared.contentHash, via: "app" },
          }),
        );
        if (row?.ref_kind === "studio_step" || row?.ref_kind === "short_batch") {
          const { kickStudioOrders } = await import("@/lib/cmo/jobs/studio-orders");
          kickStudioOrders();
        }
        return done(`${VERB[prepared.action] ?? "Decided"}: done`, prepared.screen, { status: row?.status ?? null });
      }
      case "mark_done":
        await rpcOrThrow(supabase, "cmo_mark_posted", { p_id: prepared.itemId, p_url: prepared.url });
        return done("Marked as posted", { screen: "dashboard" });
      case "set_sales_settings":
        await rpcOrThrow(supabase, "sales_settings_save", { p_excluded: prepared.excluded, p_pairs: prepared.pairs });
        return done("Sales settings saved", { screen: "sales" });
      case "set_cmo_paused":
        await rpcOrThrow(supabase, prepared.paused ? "cmo_pause" : "cmo_resume", {});
        return done(prepared.paused ? "Your CMO is paused" : "Your CMO is running again", { screen: "settings" });
      case "update_cmo_settings":
        await rpcOrThrow(supabase, "save_cmo_settings", {
          p_weekly_credit_budget: prepared.budget,
          p_timezone: prepared.timezone,
          p_digest_hour: prepared.digestHour,
        });
        return done("Settings saved", { screen: "settings" });
    }
  } catch (error) {
    // A changed card is refused by approval_decide's hash check: say so plainly.
    const message = error instanceof ApiError ? error.message : "That did not go through. Try again in a moment.";
    const changed = /changed|hash|no longer/i.test(message);
    return {
      ok: false,
      content: JSON.stringify({ error: changed ? "This card changed since it was shown. Read it again before deciding." : message }),
      summary: changed ? "The card changed" : "Could not finish",
    };
  }
}

/** `get_credits`: the balance and plan, read only. */
export async function readCredits(supabase: SupabaseClient): Promise<ToolOutcome> {
  const { data, error } = await supabase.rpc("account_summary", {});
  if (error) return { ok: false, content: JSON.stringify({ error: "Could not read your credits right now." }), summary: "Could not read credits" };
  const row = (Array.isArray(data) ? data[0] : data) as { credits?: number; plan?: string } | null;
  return { ok: true, content: JSON.stringify({ credits: row?.credits ?? null, plan: row?.plan ?? null }), summary: `${row?.credits ?? "?"} credits` };
}
