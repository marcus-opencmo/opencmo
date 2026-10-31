/**
 * Sending the two emails (P6 C0) with the service role, from the hourly cron. Every send is claimed first in SQL
 * (`email_log_claim`: one digest a founder's local day, one expiring email per card, only cards that still wait,
 * nothing once unsubscribed) and recorded after (`email_log_done`), so a retry or a second cron run never sends twice.
 *
 * Whatever can fail runs before the claim (the unsubscribe token) or inside `sendClaimed` (building the email), so a
 * claim is always recorded as sent or failed. A failed one frees its digest day for the next run. Only a process that
 * dies between the provider's answer and `email_log_done` leaves a claim open, which errs toward never sending twice.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { buildDigest, loadDigestInput, localClock } from "@/lib/cmo/digest";

import { emailFooter, expiringEmail, unsubscribeUrl, type EmailSender } from "./email";

type Claim = { log_id: string; approval_ids: string[] };

async function claim(admin: SupabaseClient, userId: string, kind: "digest" | "expiring", ids: string[]): Promise<Claim | null> {
  const { data, error } = await admin.rpc("email_log_claim", { p_user: userId, p_kind: kind, p_approval_ids: ids });
  if (error) throw new Error(`email_log_claim: ${error.message}`);
  return ((data ?? []) as Claim[])[0] ?? null;
}

async function token(admin: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await admin.rpc("notify_settings_for", { p_user: userId });
  if (error || !data) throw new Error(`notify_settings_for: ${error?.message ?? "missing"}`);
  return (data as { unsubscribe_token: string }).unsubscribe_token;
}

/** How many hours after a founder's digest hour the cron still sends a digest not yet sent today (a failed send). */
export const DIGEST_CATCH_UP_HOURS = 3;

/** Whether the cron sends the digest at this local hour: the digest hour, or up to two hours after it. */
export function digestDue(localHour: number, digestHour: number | null): boolean {
  return digestHour !== null && (localHour - digestHour + 24) % 24 < DIGEST_CATCH_UP_HOURS;
}

async function sendClaimed(admin: SupabaseClient, sender: EmailSender, c: Claim, send: () => Promise<{ id: string }>): Promise<boolean> {
  try {
    const { id } = await send();
    await admin.rpc("email_log_done", { p_log: c.log_id, p_provider_id: id, p_error: null });
    return true;
  } catch (err) {
    const message = (err instanceof Error ? err.message : "send failed").slice(0, 500);
    await admin.rpc("email_log_done", { p_log: c.log_id, p_provider_id: null, p_error: message });
    console.warn(`[notify] ${sender.name}: not sent`, message);
    return false;
  }
}

export type Founder = { id: string; email: string | null; timezone: string; digest_hour: number | null };

/** The morning digest for one founder whose digest is due (`digestDue`); false when nothing was sent. */
export async function sendDigestEmail(admin: SupabaseClient, sender: EmailSender, founder: Founder, opts: { appUrl: string; now: Date }): Promise<boolean> {
  if (!founder.email) return false;
  const clock = localClock(opts.now, founder.timezone);
  const input = await loadDigestInput(admin, founder.id, { appUrl: opts.appUrl, dateLabel: clock.dateLabel, now: opts.now });
  if (!input.waiting.length) return false;
  const url = unsubscribeUrl(opts.appUrl, await token(admin, founder.id));
  const c = await claim(admin, founder.id, "digest", input.waiting.map((w) => w.id));
  if (!c) return false;
  return sendClaimed(admin, sender, c, async () => {
    // Only the cards the claim kept (still waiting, the founder's own).
    const kept = new Set(c.approval_ids);
    const digest = buildDigest({ ...input, waiting: input.waiting.filter((w) => kept.has(w.id)) });
    const footer = emailFooter(url);
    return sender.send({ to: founder.email!, subject: digest.subject, text: digest.text + footer.text, html: digest.html.replace(/<\/div>$/, `${footer.html}</div>`), unsubscribeUrl: url });
  });
}

/** Time-bound cards (schedule cards) expiring in the next two hours get one email each. */
export async function sendExpiringEmails(admin: SupabaseClient, sender: EmailSender, opts: { appUrl: string; now: Date }): Promise<number> {
  const from = new Date(opts.now.getTime() + 15 * 60_000).toISOString();
  const to = new Date(opts.now.getTime() + 2 * 3_600_000).toISOString();
  const { data, error } = await admin
    .from("approvals")
    .select("id, user_id, kind, snapshot, expires_at")
    .eq("status", "waiting")
    .gte("expires_at", from)
    .lte("expires_at", to)
    .order("expires_at")
    .limit(200);
  if (error) throw new Error(`approvals: ${error.message}`);
  const cards = (data ?? []) as { id: string; user_id: string; kind: string; snapshot: Record<string, unknown>; expires_at: string }[];
  if (!cards.length) return 0;
  const { data: founders, error: fErr } = await admin.from("profiles").select("id, email, timezone").in("id", [...new Set(cards.map((c) => c.user_id))]);
  if (fErr) throw new Error(`profiles: ${fErr.message}`);
  const byId = new Map(((founders ?? []) as { id: string; email: string | null; timezone: string }[]).map((f) => [f.id, f]));
  let sent = 0;
  const tokens = new Map<string, string>();
  for (const card of cards) {
    const founder = byId.get(card.user_id);
    if (!founder?.email) continue;
    try {
      if (!tokens.has(founder.id)) tokens.set(founder.id, await token(admin, founder.id));
      const url = unsubscribeUrl(opts.appUrl, tokens.get(founder.id)!);
      const c = await claim(admin, founder.id, "expiring", [card.id]);
      if (!c) continue;
      const ok = await sendClaimed(admin, sender, c, async () => {
        const s = card.snapshot;
        const what = typeof s.text === "string" && s.text ? s.text : typeof s.title === "string" && s.title ? s.title : "A post waits for your time";
        const where = typeof s.platform === "string" ? ` on ${String(s.platform).toUpperCase() === "X" ? "X" : s.platform}` : "";
        const message = expiringEmail({ appUrl: opts.appUrl, cardId: card.id, title: `${what}${where}`, expiresAt: card.expires_at, timezone: founder.timezone, unsubscribeUrl: url });
        return sender.send({ to: founder.email!, ...message });
      });
      if (ok) sent += 1;
    } catch (err) {
      console.warn("[notify] expiring email", card.id, err instanceof Error ? err.message : err);
    }
  }
  return sent;
}
