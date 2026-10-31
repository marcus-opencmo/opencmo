import { NextResponse, type NextRequest } from "next/server";

import { cronAuthorized } from "@/lib/cron-auth";
import { localClock } from "@/lib/cmo/digest";
import { readAll } from "@/lib/cmo/jobs/progress-run";
import { emailSender } from "@/lib/notify/email";
import { pushNewCards, vapidFromEnv } from "@/lib/notify/push";
import { digestDue, sendDigestEmail, sendExpiringEmails } from "@/lib/notify/send";
import { SITE_URL } from "@/lib/site";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Releases held cards whose day has come, then sends the morning digest to founders at their `digest_hour` (or up to
 * two hours after, when today's has not gone out: a failed send is retried), one email for each schedule card about to
 * expire, and one push per browser for new cards. Called once an hour; `email_log_claim` makes a second call send
 * nothing twice. With no sender it only counts: the digest is on the Dashboard anyway.
 */
export async function GET(request: NextRequest) {
  const started = Date.now();
  if (!cronAuthorized(request.headers.get("authorization"), "cmo-digest")) {
    return NextResponse.json({ error: "Forbidden." }, { status: 401 });
  }
  const admin = createAdminClient(AbortSignal.timeout((maxDuration - 10) * 1000));
  // Cards held past a day's budget (P6 A4) come back first, so the morning digest names them.
  const released = await admin.rpc("approval_release_held", { p_limit: 500 });
  if (released.error) console.warn("[cron] cmo-digest: held cards not released", released.error.message);
  const send = emailSender();
  const now = new Date();
  type Profile = { id: string; email: string | null; timezone: string; digest_hour: number };
  let profiles: Profile[];
  try {
    profiles = await readAll<Profile>((from, to) =>
      admin.from("profiles").select("id, email, timezone, digest_hour").not("digest_hour", "is", null).order("id").range(from, to),
    );
  } catch {
    return NextResponse.json({ error: "Could not read founders." }, { status: 500 });
  }

  let due = 0;
  let sent = 0;
  for (const profile of profiles) {
    const clock = localClock(now, profile.timezone);
    if (!digestDue(clock.hour, profile.digest_hour) || !profile.email) continue;
    due += 1;
    if (!send) continue;
    try {
      if (await sendDigestEmail(admin, send, profile, { appUrl: SITE_URL, now })) sent += 1;
    } catch (err) {
      console.warn("[cron] cmo-digest: not sent", profile.id, err instanceof Error ? err.message : err);
    }
  }
  // One email before a time-bound card expires (schedule cards), at most once per card.
  let expiring = 0;
  if (send) {
    try {
      expiring = await sendExpiringEmails(admin, send, { appUrl: SITE_URL, now });
    } catch (err) {
      console.warn("[cron] cmo-digest: expiring emails not sent", err instanceof Error ? err.message : err);
    }
  }
  // One push per browser for the cards raised since its last push (P6 C1); none without VAPID keys.
  let pushed = 0;
  const vapid = vapidFromEnv();
  if (vapid) {
    try {
      // A batch can take one push timeout (10 s) past the deadline; the admin client gives up at maxDuration - 10 s.
      pushed = await pushNewCards(admin, vapid, fetch, { deadline: started + (maxDuration - 25) * 1000 });
    } catch (err) {
      console.warn("[cron] cmo-digest: pushes not sent", err instanceof Error ? err.message : err);
    }
  }
  return NextResponse.json({ due, sent, expiring, pushed, released: released.data ?? 0, sender: send?.name ?? null });
}
