import { z } from "zod";

import { rpcOrThrow, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

/** The browser's `PushSubscription.toJSON()`; SQL checks the endpoint's host and the keys again (P6 C1). */
const subscribe = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
});

export const POST = withApi({ body: subscribe }, async ({ supabase, body, request }) => {
  const id = await rpcOrThrow<string>(supabase, "push_subscribe", {
    p_endpoint: body.endpoint,
    p_p256dh: body.keys.p256dh,
    p_auth: body.keys.auth,
    p_user_agent: (request.headers.get("user-agent") ?? "").slice(0, 300) || null,
  });
  return { id };
});

const unsubscribe = z.object({ endpoint: z.string().url().max(1000) });

export const DELETE = withApi({ body: unsubscribe }, async ({ supabase, body }) => ({
  removed: await rpcOrThrow<boolean>(supabase, "push_unsubscribe", { p_endpoint: body.endpoint }),
}));
