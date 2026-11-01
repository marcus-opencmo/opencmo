import "server-only";

/**
 * Thả một việc CMO vào hàng đợi (dưới quyền người dùng: trần mỗi ngày, giữ
 * credit nằm trong `enqueue_cmo_run`) rồi chạy NGAY sau khi trả lời request,
 * bằng service role — cùng đường với cron, nên chỉ có một cách một việc chạy.
 */

import { after } from "next/server";

import { ApiError } from "@/lib/api/errors";
import { firstRow, rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import { createAdminClient } from "@/lib/supabase/admin";

import { PAUSED_EVERYWHERE, cmoPausedEverywhere } from "../pause";
import { socialReaderReady } from "../social/reddit";

import { drainCmoQueue } from "./runner";
import { supabaseStore } from "./store";
import type { CmoJobKind } from "./types";

export type StartedRun = { id: string; kind: CmoJobKind; status: "queued" | "running" | "done" | "failed"; created_at: string };

/**
 * Runs `runId` (or drains the queue) after the response is sent. Errors are only logged: the run
 * stays queued and Modal's `sweep()` dispatches it again within a minute.
 */
export function kickCmoQueue(runId?: string, budgetMs = 250_000): void {
  after(async () => {
    try {
      await drainCmoQueue(supabaseStore(createAdminClient()), { runId, budgetMs });
    } catch (error) {
      console.error("[cmo] chạy hàng đợi thất bại", error);
    }
  });
}

export async function startCmoRun(supabase: SupabaseClient, kind: CmoJobKind, input: Record<string, unknown> = {}): Promise<StartedRun> {
  if (cmoPausedEverywhere()) throw new ApiError(503, PAUSED_EVERYWHERE);
  // Kiểm TRƯỚC khi giữ credit: không có khoá đọc Reddit thì lượt nào cũng hỏng.
  if (kind === "sales_scan" && !socialReaderReady()) throw new ApiError(503, "Reddit scanning is not set up on this server yet.");
  if ((kind === "competitor_research" || kind === "niche_video_research" || kind === "pull_metrics") && !socialReaderReady()) throw new ApiError(503, "Social research is not set up on this server yet.");
  const run = firstRow(await rpcOrThrow<StartedRun | StartedRun[]>(supabase, "enqueue_cmo_run", { p_kind: kind, p_input: input }));
  if (!run) throw new ApiError(500, "Could not start this task.");
  // An inbox run only goes as far as its first model call: Modal's sweep opens it within a
  // minute, and over MCP there is no Next.js `after()` to run it here.
  if (run.status === "queued" && input.brain !== "claude") kickCmoQueue(run.id);
  return run;
}
