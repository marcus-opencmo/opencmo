/**
 * Chạy hàng đợi việc CMO (docs/cmo/san-pham.md §4.3–4.4). Một lượt = một việc
 * W1/W2…, mỗi bước ghi vào `cmo_runs.steps` TRƯỚC và SAU khi chạy, nên Activity
 * hiện từng bước và lượt chết giữa chừng (hết lease) chạy lại được từ đầu.
 *
 * Không `server-only`: `jobs.check.ts` chạy runner với store trong bộ nhớ.
 */

import { competitorResearch } from "./competitor-research";
import { draftPost } from "./draft-post";
import { LlmError } from "./llm-error";
import { planWeek } from "./plan-week";
import { pullMetrics } from "./pull-metrics";
import { salesScan } from "./sales-scan";
import { summarizeMemory } from "./summarize-memory";
import { videoPack } from "./video-pack";
import type { CmoJobKind, CmoStore, QueuedRun, Step } from "./types";

/**
 * Việc chưa làm tiếp được (vd W5 chờ worker cắt clip): ném cái này, lượt về
 * hàng đợi và hoãn `seconds` giây — không phải hỏng, không hoàn credit.
 */
export class Deferred extends Error {
  constructor(readonly seconds: number) {
    super("deferred");
  }
}

export type JobContext = {
  store: CmoStore;
  run: QueuedRun;
  /** Chạy một bước có tên tool + nhãn; `fn` trả về nhãn kết quả (hoặc giữ nhãn cũ). */
  step<T>(tool: string, label: string, fn: () => Promise<T>, done?: (value: T) => string): Promise<T>;
};

export type JobOutput = Record<string, unknown>;
type Job = (ctx: JobContext) => Promise<JobOutput>;

export const JOBS: Record<CmoJobKind, Job> = {
  plan_week: planWeek,
  post_draft: draftPost,
  sales_scan: salesScan,
  video_pack: videoPack,
  competitor_research: competitorResearch,
  pull_metrics: pullMetrics,
  summarize_memory: summarizeMemory,
};

/** Lượt bị nhận lại bởi một worker khác (lease hết): dừng im lặng, không ghi gì nữa. */
class LeaseLost extends Error {}

export async function runOne(store: CmoStore, run: QueuedRun): Promise<{ ok: boolean; error: string | null; deferred?: boolean }> {
  const steps: Step[] = [];
  const write = async () => {
    if (!(await store.step(run, steps))) throw new LeaseLost();
  };
  const ctx: JobContext = {
    store,
    run,
    async step(tool, label, fn, done) {
      steps.push({ tool, label, status: "running" });
      const index = steps.length - 1;
      await write();
      try {
        const value = await fn();
        steps[index] = { tool, label: done ? done(value) : label, status: "done" };
        await write();
        return value;
      } catch (error) {
        // Đang chờ (Deferred) không phải hỏng: bước giữ "running" để Activity nói đúng.
        steps[index] = { tool, label, status: error instanceof Deferred ? "running" : "failed" };
        await store.step(run, steps).catch(() => false);
        throw error;
      }
    },
  };

  const job = JOBS[run.kind];
  if (!job) {
    await store.complete(run, false, null, "Unknown task.");
    return { ok: false, error: "Unknown task." };
  }
  try {
    const output = await job(ctx);
    await store.complete(run, true, output, null);
    return { ok: true, error: null };
  } catch (error) {
    if (error instanceof LeaseLost) return { ok: false, error: null };
    if (error instanceof Deferred) {
      await store.defer(run, error.seconds, steps).catch((e) => console.error("[cmo] cmo_defer_run", e));
      return { ok: true, error: null, deferred: true };
    }
    const message = error instanceof LlmError ? error.message : "Something went wrong. Try again in a minute.";
    if (!(error instanceof LlmError)) console.error(`[cmo] ${run.kind} ${run.id} thất bại`, error);
    await store.complete(run, false, null, message).catch((e) => console.error("[cmo] complete_cmo_run", e));
    return { ok: false, error: message };
  }
}

/**
 * Nhận và chạy việc cho tới khi hết hàng đợi hoặc hết ngân sách thời gian.
 * Có `runId` thì chỉ chạy đúng lượt đó (người dùng vừa bấm) — lượt khác để cron.
 */
export async function drainCmoQueue(store: CmoStore, opts: { runId?: string; budgetMs?: number } = {}): Promise<number> {
  const deadline = Date.now() + (opts.budgetMs ?? 240_000);
  let ran = 0;
  while (Date.now() < deadline) {
    const run = await store.claim(opts.runId);
    if (!run) break;
    await runOne(store, run);
    ran += 1;
    if (opts.runId) break;
  }
  return ran;
}
