import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";
import { continueTurn } from "@/lib/agent/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const body = z.object({ extend: z.boolean().optional() });

/**
 * Continues a turn paused between two requests (spec agent-editor §5):
 * - paused at one request's time or step limit (`awaiting_continue`, 'time' / 'steps'): the tab
 *   calls this at once, nobody is asked;
 * - paused because the held credits ran out ('budget'): runs only with `extend: true`, after the
 *   user pressed "Continue for N credits" and SQL held more.
 */
export const POST = withApi({ body }, async ({ supabase, user, body, params }) => {
  if (body.extend !== true) {
    // Only a turn paused at a request limit continues without anyone: a turn waiting for an answer
    // or an approval card would get here with the question skipped and the card cancelled.
    const { data } = await supabase
      .from("agent_turns")
      .select("status, pause_reason")
      .eq("session_id", params.id)
      .order("number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const turn = data as { status: string; pause_reason: string | null } | null;
    if (turn?.status !== "awaiting_continue" || (turn.pause_reason !== "time" && turn.pause_reason !== "steps")) {
      throw new ApiError(409, "The assistant is not waiting to continue.");
    }
  }
  return continueTurn(supabase, user.id, params.id, [], { extend: body.extend === true });
});
