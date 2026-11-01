/**
 * Email (P6 C0, F1; `approval.md` §7, §12 2): the morning digest and one email before a time-bound card expires.
 * An email only opens a card behind login; nothing in it decides (mail scanners open links), so there is no approve
 * link, and the unsubscribe link asks before it acts.
 *
 * Where it goes, like the publish adapter: Resend only with `RESEND_API_KEY` **and** `OPENCMO_EMAIL_LIVE=1` (the key
 * alone is in production's `.env.local`, which local scripts read), the local stack's mail catcher with
 * `OPENCMO_DIGEST_LOCAL_MAIL=1`, otherwise nowhere (the digest still shows on the Dashboard). The key goes only to
 * Resend's own host.
 */

import { isProduction } from "@/lib/production";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The page that asks before unsubscribing; also sent as `List-Unsubscribe` for the mail client's own button. */
  unsubscribeUrl: string;
};

export type EmailSender = { readonly name: "resend" | "local"; send(message: EmailMessage): Promise<{ id: string }> };

export class EmailError extends Error {}

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 15_000;
export const SUPPORT_EMAIL = "support@opencmo.io";

export function emailSender(env: Record<string, string | undefined> = process.env, doFetch: typeof fetch = fetch): EmailSender | null {
  const key = env.RESEND_API_KEY?.trim();
  if (key && env.OPENCMO_EMAIL_LIVE === "1") return resendSender(key, env.OPENCMO_EMAIL_FROM?.trim() || "OpenCMO <cmo@opencmo.io>", doFetch);
  if (env.OPENCMO_DIGEST_LOCAL_MAIL === "1" && !isProduction()) return localSender((env.OPENCMO_LOCAL_MAIL_URL ?? "http://127.0.0.1:54324").replace(/\/$/, ""), doFetch);
  return null;
}

function resendSender(key: string, from: string, doFetch: typeof fetch): EmailSender {
  return {
    name: "resend",
    async send(m) {
      let res: Response;
      try {
        res = await doFetch(RESEND_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from,
            to: [m.to],
            subject: m.subject,
            text: m.text,
            html: m.html,
            reply_to: SUPPORT_EMAIL,
            // RFC 8058: the mail client's own unsubscribe button posts to the same page, which then acts at once.
            headers: { "List-Unsubscribe": `<${m.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
          }),
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new EmailError("The email service did not answer.");
      }
      const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
      if (!res.ok || typeof body?.id !== "string") throw new EmailError(`The email service refused it (${res.status}).`);
      return { id: body.id.slice(0, 100) };
    },
  };
}

/** The local stack's mail catcher (Inbucket/Mailpit HTTP send API), so a digest can be opened in dev and e2e. */
function localSender(base: string, doFetch: typeof fetch): EmailSender {
  return {
    name: "local",
    async send(m) {
      const res = await doFetch(`${base}/api/v1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          From: { Email: "cmo@opencmo.local", Name: "Your CMO" },
          To: [{ Email: m.to }],
          Subject: m.subject,
          Text: m.text,
          HTML: m.html,
          Headers: { "List-Unsubscribe": `<${m.unsubscribeUrl}>` },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new EmailError(`local mail answered ${res.status}`);
      const body = (await res.json().catch(() => null)) as { ID?: unknown } | null;
      return { id: typeof body?.ID === "string" ? body.ID.slice(0, 100) : "local" };
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The footer every email carries: why it came, how to stop it, where to write. */
export function emailFooter(unsubscribeUrl: string): { text: string; html: string } {
  return {
    text: `\n\n--\nYou get this because cards wait on you in OpenCMO.\nStop these emails: ${unsubscribeUrl}\nQuestions: ${SUPPORT_EMAIL}`,
    html:
      `<p style="font:12px/1.5 Inter,sans-serif;color:#69695d;margin-top:28px;border-top:1px solid #e3e1da;padding-top:12px">` +
      `You get this because cards wait on you in OpenCMO. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#69695d">Stop these emails</a>. ` +
      `Questions: <a href="mailto:${SUPPORT_EMAIL}" style="color:#69695d">${SUPPORT_EMAIL}</a></p>`,
  };
}

/** One card about to expire: what it is, when it expires, the link that opens it. */
export function expiringEmail(input: { appUrl: string; cardId: string; title: string; expiresAt: string; timezone: string; unsubscribeUrl: string }): Omit<EmailMessage, "to"> {
  const link = `${input.appUrl.replace(/\/$/, "")}/app/inbox/${encodeURIComponent(input.cardId)}`;
  let when: string;
  try {
    when = new Intl.DateTimeFormat("en-GB", { timeZone: input.timezone, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(input.expiresAt));
  } catch {
    when = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(input.expiresAt));
  }
  const title = input.title.slice(0, 120);
  const subject = `Approve by ${when}: ${title}`.slice(0, 150);
  const footer = emailFooter(input.unsubscribeUrl);
  return {
    subject,
    text: `${subject}\n\nThis card expires at ${when}. After that it does not go out, and you get a new time to approve.\n\nOpen it: ${link}${footer.text}`,
    html:
      `<div style="font:14px/1.5 Inter,sans-serif;color:#2b2723;max-width:560px">` +
      `<h1 style="font:600 18px Inter,sans-serif;margin:0 0 8px">Approve by ${escapeHtml(when)}</h1>` +
      `<p><a href="${escapeHtml(link)}" style="color:#c93a0f">${escapeHtml(title)}</a></p>` +
      `<p>This card expires at ${escapeHtml(when)}. After that it does not go out, and you get a new time to approve.</p>` +
      `${footer.html}</div>`,
    unsubscribeUrl: input.unsubscribeUrl,
  };
}

export function unsubscribeUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, "")}/unsubscribe?token=${encodeURIComponent(token)}`;
}
