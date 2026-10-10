import { NextResponse, type NextRequest } from "next/server";

import { cronAuthorized } from "@/lib/cron-auth";
import { enqueueDueLoops } from "@/lib/cmo/schedule";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The CMO's daily schedule. Modal's `cmo_schedule` cron calls this at 00:05 UTC (7:05 in
 * Vietnam), right after midnight UTC so the calendar's "today" (a UTC date, like
 * `current_date`) matches the user's morning.
 *
 * Only enqueues the loops due today. Running them is not done here: Modal's `sweep()` sees the
 * queued runs within a minute and calls `/api/internal/cmo/run` once per run, so every run gets
 * its own function instead of one 300 s function walking every user.
 */
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request.headers.get("authorization"), "cmo")) {
    return NextResponse.json({ error: "Forbidden." }, { status: 401 });
  }
  const admin = createAdminClient(AbortSignal.timeout((maxDuration - 10) * 1000));
  try {
    return NextResponse.json(await enqueueDueLoops(admin));
  } catch (error) {
    console.error("[cron] cmo", error);
    return NextResponse.json({ error: "Could not read users." }, { status: 500 });
  }
}
