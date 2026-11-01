import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { SUPPORT_EMAIL } from "@/lib/notify/email";

export const dynamic = "force-dynamic";

/**
 * The link at the foot of every email (P6 C0). It works signed out: the token is the only thing it names. GET only
 * asks, because mail scanners open links; POST acts (the button here, or the mail client's own one-click button,
 * RFC 8058). An unknown token answers the same as a known one.
 */
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(title: string, body: string, status = 200): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} · OpenCMO</title></head>
<body style="margin:0;background:#f6f5f1;color:#2b2723;font:16px/1.5 Inter,system-ui,sans-serif">
<main style="max-width:520px;margin:12vh auto;padding:0 20px"><h1 style="font-size:24px;margin:0 0 12px">${title}</h1>${body}
<p style="color:#69695d;font-size:14px;margin-top:32px">Questions: <a href="mailto:${SUPPORT_EMAIL}" style="color:#69695d">${SUPPORT_EMAIL}</a></p></main></body></html>`;
  return new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  if (!TOKEN.test(token)) return page("This link is not complete", "<p>Open the link from the email again, or turn emails off in Settings.</p>", 400);
  return page(
    "Stop OpenCMO emails?",
    `<p>You will stop getting the morning digest and the emails before a card expires. Cards still wait for you in the app.</p>
<form method="post"><input type="hidden" name="token" value="${token}"><button type="submit" style="font:inherit;padding:10px 18px;border:1px solid #2b2723;background:#2b2723;color:#f6f5f1;border-radius:4px;cursor:pointer">Stop emails</button></form>`,
  );
}

export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const token = String(form?.get("token") ?? request.nextUrl.searchParams.get("token") ?? "");
  if (!TOKEN.test(token)) return page("This link is not complete", "<p>Open the link from the email again, or turn emails off in Settings.</p>", 400);
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { error } = await anon.rpc("email_unsubscribe", { p_token: token });
  if (error) return page("That did not work", "<p>Try again in a minute, or turn emails off in Settings.</p>", 500);
  return page("You will not get these emails anymore", "<p>Turn them back on any time in Settings.</p>");
}
