import { z } from "zod";

import { withApi } from "@/lib/api/handler";
import { continueTurn } from "@/lib/agent/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const body = z.object({
  decisions: z
    .array(z.object({ tool_use_id: z.string().min(1).max(128), approved: z.boolean() }))
    .min(1)
    .max(8),
});

/**
 * Approve or Cancel an approval card (a priced `generate_media`), then the turn continues on the
 * same Server-Sent Events as the `turns` route. A waiting tool with no decision counts as Cancel:
 * the Assistant never spends credits the user did not approve.
 */
export const POST = withApi({ body }, async ({ supabase, user, body, params }) =>
  continueTurn(
    supabase,
    user.id,
    params.id,
    body.decisions.map((decision) => ({ tool_use_id: decision.tool_use_id, approved: decision.approved })),
  ),
);
