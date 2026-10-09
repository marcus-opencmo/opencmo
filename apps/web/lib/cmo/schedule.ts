import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isoDay } from "@/lib/cmo/jobs/types";
import { dueLoops, type LoopState } from "@/lib/cmo/loops";
import { socialReaderReady } from "@/lib/cmo/social/reddit";

/**
 * Reads every user's state and enqueues the loops due today (`lib/cmo/loops.ts`). Only enqueues:
 * the runs are dispatched to `/api/internal/cmo/run` by Modal's `sweep()`, in parallel.
 *
 * Called once a day. The loops are daily and `enqueue_cmo_run_for` only dedupes runs that are
 * still queued or running, so calling this more often would re-run a loop whose run already
 * finished (the Monday plan, for one).
 */
export async function enqueueDueLoops(admin: SupabaseClient): Promise<{ users: number; queued: number }> {
  const today = isoDay();
  const weekday = new Date().getUTCDay();

  const { data: docs, error } = await admin.from("marketing_documents_latest").select("user_id, kind, body").in("kind", ["product", "competitors"]);
  if (error) throw new Error(`users: ${error.message}`);
  const rows = (docs ?? []) as { user_id: string; kind: string; body: Record<string, unknown> }[];
  const users = [...new Set(rows.filter((r) => r.kind === "product").map((r) => r.user_id))];
  const handles = new Map<string, number>();
  for (const row of rows.filter((r) => r.kind === "competitors")) {
    const list = Array.isArray(row.body.competitors) ? (row.body.competitors as { x_handle?: unknown }[]) : [];
    handles.set(row.user_id, list.filter((c) => typeof c.x_handle === "string" && c.x_handle.trim()).length);
  }

  const { data: due } = await admin
    .from("content_items")
    .select("user_id, department, idea, day")
    .in("department", ["post", "sales"])
    .eq("status", "planned")
    .lte("day", today)
    .order("day");
  const dueRows = (due ?? []) as { user_id: string; department: string; idea: string }[];
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const { data: published } = await admin.from("content_items").select("user_id").eq("status", "published").eq("department", "post").gte("published_at", since);
  const publishedBy = new Map<string, number>();
  for (const p of (published ?? []) as { user_id: string }[]) publishedBy.set(p.user_id, (publishedBy.get(p.user_id) ?? 0) + 1);
  const socialReader = socialReaderReady();

  let queued = 0;
  for (const user of users) {
    const firstDue = (department: string) => {
      const row = dueRows.find((d) => d.user_id === user && d.department === department);
      return row ? { idea: row.idea } : null;
    };
    const state: LoopState = {
      weekday,
      duePost: firstDue("post"),
      dueSales: firstDue("sales"),
      competitorHandles: handles.get(user) ?? 0,
      publishedRecently: publishedBy.get(user) ?? 0,
      socialReader,
    };
    for (const run of dueLoops(state)) {
      const { error: enqueueError } = await admin.rpc("enqueue_cmo_run_for", { p_user: user, p_kind: run.kind, p_input: { ...run.input, loop: run.loop } });
      // Out of credits or at the daily cap: skip this user, keep going for the others.
      if (enqueueError) console.warn("[cron] cmo: skipped", run.loop, enqueueError.message);
      else queued += 1;
    }
  }
  return { users: users.length, queued };
}
