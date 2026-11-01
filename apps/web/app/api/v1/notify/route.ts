import { z } from "zod";

import { rpcOrThrow, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

type Settings = { email_digest: boolean; push: boolean };

/**
 * The founder's email and push switches (P6 C0, C1). `vapidPublicKey` is null where push is not set up, and Settings
 * then offers no push button.
 */
export const GET = withApi({}, async ({ supabase, user }) => {
  const { data } = await supabase.from("notify_settings").select("email_digest, push").eq("user_id", user.id).maybeSingle();
  const row = (data as Settings | null) ?? { email_digest: true, push: true };
  return { emailDigest: row.email_digest, push: row.push, vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() || null };
});

const body = z.object({ emailDigest: z.boolean(), push: z.boolean() }).strict();

export const PUT = withApi({ body }, async ({ supabase, body }) => {
  const row = await rpcOrThrow<Settings>(supabase, "notify_settings_save", { p_email_digest: body.emailDigest, p_push: body.push });
  return { emailDigest: row.email_digest, push: row.push };
});
