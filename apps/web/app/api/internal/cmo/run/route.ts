import { NextResponse, type NextRequest } from "next/server";

import { cronAuthorized } from "@/lib/cron-auth";
import { kickCmoQueue } from "@/lib/cmo/jobs/start";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
  kickCmoQueue(undefined, (maxDuration - 40) * 1000);
  return NextResponse.json({ accepted: true }, { status: 202 });
}
