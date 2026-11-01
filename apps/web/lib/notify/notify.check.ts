/**
 * Email (P6 C0) without network: which sender runs (the key alone never sends), what Resend is sent (only to its own
 * host, the one-click unsubscribe headers), and the two emails: links open the card, nothing approves, the footer
 * names support and the unsubscribe page.
 *
 *     cd apps/web && npx tsx lib/notify/notify.check.ts
 */
import assert from "node:assert/strict";

import { emailFooter, emailSender, expiringEmail, SUPPORT_EMAIL, unsubscribeUrl, type EmailSender } from "./email";
import { digestDue, sendExpiringEmails } from "./send";

async function main() {
  // Selection.
  assert.equal(emailSender({ RESEND_API_KEY: "re_x" }), null, "the key alone (production's .env.local) never sends");
  assert.equal(emailSender({ RESEND_API_KEY: "re_x", OPENCMO_EMAIL_LIVE: "1" })?.name, "resend");
  assert.equal(emailSender({ OPENCMO_DIGEST_LOCAL_MAIL: "1" })?.name, "local");
  assert.equal(emailSender({}), null);

  // Resend: the key goes to Resend's host only; the unsubscribe headers ride along.
  const seen: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
  }) as typeof fetch;
  const resend = emailSender({ RESEND_API_KEY: "re_secret", OPENCMO_EMAIL_LIVE: "1" }, fake)!;
  const url = unsubscribeUrl("https://opencmo.io/", "6f1c2c4e-3b0a-4c8e-9d7e-0a1b2c3d4e5f");
  assert.equal(url, "https://opencmo.io/unsubscribe?token=6f1c2c4e-3b0a-4c8e-9d7e-0a1b2c3d4e5f");
  assert.deepEqual(await resend.send({ to: "f@example.com", subject: "S", text: "T", html: "<p>H</p>", unsubscribeUrl: url }), { id: "email_123" });
  assert.equal(seen[0]!.url, "https://api.resend.com/emails");
  assert.equal((seen[0]!.init.headers as Record<string, string>).Authorization, "Bearer re_secret");
  const sent = JSON.parse(String(seen[0]!.init.body)) as { headers: Record<string, string>; reply_to: string; from: string };
  assert.equal(sent.headers["List-Unsubscribe"], `<${url}>`);
  assert.equal(sent.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.equal(sent.reply_to, SUPPORT_EMAIL);
  assert.ok(!JSON.stringify(sent).includes("re_secret"), "the key is never in the body");
  const refusing = emailSender({ RESEND_API_KEY: "re_x", OPENCMO_EMAIL_LIVE: "1" }, (async () => new Response("{}", { status: 422 })) as typeof fetch)!;
  await assert.rejects(refusing.send({ to: "f@example.com", subject: "S", text: "T", html: "H", unsubscribeUrl: url }), /refused it \(422\)/);

  // The expiring email: opens the card, never approves; times in the founder's zone; the footer.
  const m = expiringEmail({
    appUrl: "https://opencmo.io",
    cardId: "c-1",
    title: "Most AI video tools stop at the first draft <script> on X",
    expiresAt: "2026-11-02T02:00:00Z",
    timezone: "Asia/Ho_Chi_Minh",
    unsubscribeUrl: url,
  });
  assert.match(m.subject, /^Approve by Mon 09:00: /);
  assert.ok(m.html.includes('href="https://opencmo.io/app/inbox/c-1"'), "the link opens the card");
  assert.ok(!/approve\?|action=approve|decide/i.test(m.html + m.text), "no link decides anything");
  assert.ok(!m.html.includes("<script>"), "outside text is escaped");
  assert.ok(m.text.includes(SUPPORT_EMAIL) && m.html.includes(url.replace(/&/g, "&amp;")), "support and unsubscribe in the footer");
  const footer = emailFooter(url);
  assert.ok(footer.text.includes(url) && footer.html.includes("Stop these emails"));

  // The digest goes out at its hour, or up to two hours later when today's has not (a failed send is retried then).
  assert.ok(digestDue(8, 8) && digestDue(9, 8) && digestDue(10, 8) && !digestDue(11, 8) && !digestDue(7, 8));
  assert.ok(digestDue(23, 23) && !digestDue(0, 23) && !digestDue(1, 23), "the catch-up stops at midnight (the claim is per local date)");
  assert.ok(digestDue(22, 22) && digestDue(23, 22) && !digestDue(0, 22));
  assert.ok(!digestDue(8, null), "no digest hour, no digest");

  // A failure after the claim (here while building the email) records the claim as failed, so it never stays
  // `claimed` and blocks that card's email for good.
  const calls: [string, Record<string, unknown>][] = [];
  const table = (rows: unknown[]) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "lte", "order", "limit", "in"]) q[m] = () => q;
    q.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
    return q;
  };
  const broken = Object.defineProperty({}, "text", { get: () => { throw new Error("bad snapshot"); } });
  const admin = {
    from: (name: string) =>
      name === "approvals"
        ? table([{ id: "c-1", user_id: "u-1", kind: "schedule", snapshot: broken, expires_at: "2026-11-02T09:00:00Z" }])
        : table([{ id: "u-1", email: "f@example.com", timezone: "UTC" }]),
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      if (name === "notify_settings_for") return { data: { unsubscribe_token: "tok" }, error: null };
      if (name === "email_log_claim") return { data: [{ log_id: "log-1", approval_ids: ["c-1"] }], error: null };
      return { data: null, error: null };
    },
  };
  let sends = 0;
  const never: EmailSender = { name: "local", send: async () => ((sends += 1), { id: "x" }) };
  assert.equal(await sendExpiringEmails(admin as never, never, { appUrl: "https://opencmo.io", now: new Date("2026-11-02T08:00:00Z") }), 0);
  const done = calls.find(([n]) => n === "email_log_done");
  assert.ok(done && done[1].p_log === "log-1" && done[1].p_error === "bad snapshot", "the claim is recorded as failed");
  assert.equal(sends, 0);
  assert.ok(calls.findIndex(([n]) => n === "notify_settings_for") < calls.findIndex(([n]) => n === "email_log_claim"), "the token is read before the claim");

  console.log("notify: sender selection, Resend request, the expiring email, the footer, the digest hour and failed claims");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
