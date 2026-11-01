import { NextResponse, type NextRequest } from "next/server";

import { cronAuthorized } from "@/lib/cron-auth";
import { kickCmoQueue } from "@/lib/cmo/jobs/start";
import { kickStudioOrders } from "@/lib/cmo/jobs/studio-orders";
import { cmoPausedEverywhere } from "@/lib/cmo/pause";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Room left for the slowest run or Studio step once it is claimed. */
const CLAIM_MARGIN_SECONDS = 120;

/**
 * Runs queued CMO work. Modal's `sweep()` counts the runs waiting in `cmo_runs` every minute and
 * calls this once per run, so runs execute in parallel, each in its own function.
 *
 * Answers 202 at once and works inside `after()`: Modal only waits a few seconds per call, and
 * the run claims its own lease, so a call that finds the queue empty simply does nothing.
 */
export async function POST(request: NextRequest) {
  if (!cronAuthorized(request.headers.get("authorization"), "cmo-run")) {
    return NextResponse.json({ error: "Forbidden." }, { status: 401 });
  }
  if (!cmoPausedEverywhere()) {
    // Stop claiming 120 s before the limit, not 40 s: a sales scan claimed at 250 s needs ~90 s and was killed mid-run,
    // then re-run from scratch with its paid calls (review R6). The sweep dispatches a call per waiting item anyway.
    kickCmoQueue(undefined, (maxDuration - CLAIM_MARGIN_SECONDS) * 1000);
    // Studio's orders (P2 A2) are not `cmo_runs`; the sweep counts them with `studio_work_count`.
    kickStudioOrders((maxDuration - CLAIM_MARGIN_SECONDS) * 1000);
  }
  return NextResponse.json({ accepted: true }, { status: 202 });
}
