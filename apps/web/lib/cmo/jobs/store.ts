import "server-only";

import type { SupabaseClient as BaseClient } from "@supabase/supabase-js";

import { DOCUMENT_KINDS, type DocumentKind } from "../documents";
import type { ClipJob, CmoStore, CompetitorInsight, Documents, ItemRow, QueuedRun } from "./types";

const ITEM_COLUMNS =
  "id, run_id, department, platform, day, idea, reason, status, priority, body, final_text, external_url, decided_at, published_at, created_at";

function one<T>(data: unknown): T | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" && (row as { id?: unknown }).id ? (row as T) : null;
}

/** Store thật: client service role, gọi RPC chỉ-service kèm user id tường minh (như worker Python). */
export function supabaseStore(admin: BaseClient): CmoStore {
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await admin.rpc(name, args);
    if (error) throw new Error(`${name}: ${error.message}`);
    return data as T;
  }
  return {
    async claim(runId) {
      const row = one<QueuedRun>(await rpc("claim_cmo_run", { p_run_id: runId ?? null, p_lease_seconds: 300 }));
      return row;
    },
    step: (run, steps) => rpc<boolean>("cmo_run_step", { p_run: run.id, p_attempt: run.attempt, p_steps: steps }),
    complete: (run, ok, output, error) =>
      rpc<boolean>("complete_cmo_run", { p_run: run.id, p_attempt: run.attempt, p_ok: ok, p_output: output, p_error: error }),
    async documents(userId) {
      const { data, error } = await admin.from("marketing_documents_latest").select("kind, body").eq("user_id", userId);
      if (error) throw new Error(`documents: ${error.message}`);
      const out: Documents = {};
      for (const row of (data ?? []) as { kind: DocumentKind; body: Record<string, unknown> }[]) {
        if (DOCUMENT_KINDS.includes(row.kind)) out[row.kind] = row.body;
      }
      return out;
    },
    async memories(userId, limit) {
      const { data } = await admin.from("cmo_memories").select("body").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);
      return ((data ?? []) as { body: string }[]).map((m) => m.body);
    },
    async items(userId, filter) {
      let query = admin.from("content_items").select(ITEM_COLUMNS).eq("user_id", userId);
      if (filter.statuses) query = query.in("status", filter.statuses);
      if (filter.department) query = query.eq("department", filter.department);
      if (filter.since) query = query.gte("created_at", filter.since);
      const { data, error } = await query.order("day", { ascending: true }).order("created_at", { ascending: true }).limit(filter.limit ?? 50);
      if (error) throw new Error(`items: ${error.message}`);
      return (data ?? []) as ItemRow[];
    },
    planWeek: (userId, runId, items) => rpc<number>("cmo_plan_week", { p_user: userId, p_run: runId, p_items: items }),
    async saveDraft(userId, runId, itemId, idea, body, priority) {
      const row = one<ItemRow>(
        await rpc("cmo_save_draft", { p_user: userId, p_run: runId, p_item: itemId, p_idea: idea, p_body: body, p_priority: priority }),
      );
      if (!row) throw new Error("cmo_save_draft: không trả về hàng");
      return row;
    },
    async seenUrls(userId) {
      const { data } = await admin.from("opportunities").select("url").eq("user_id", userId).order("created_at", { ascending: false }).limit(1000);
      return new Set(((data ?? []) as { url: string }[]).map((r) => r.url));
    },
    saveOpportunities: (userId, runId, items) => rpc<number>("cmo_save_opportunities", { p_user: userId, p_run: runId, p_items: items }),
    async clipJob(userId, jobId) {
      const { data: job } = await admin
        .from("jobs")
        .select("id, status, error, created_at, title")
        .eq("id", jobId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!job) return null;
      const row = job as { status: ClipJob["status"]; error: string | null; created_at: string; title: string | null };
      if (row.status !== "done") return { status: row.status, error: row.error, createdAt: row.created_at, title: row.title, clips: [] };
      const [{ data: clips }, { data: artifact }] = await Promise.all([
        admin.from("clips").select("id, idx, hook, reason, start_seconds, end_seconds, score").eq("job_id", jobId).eq("kind", "moment").order("idx"),
        admin.from("artifacts").select("data").eq("job_id", jobId).eq("kind", "transcript").order("version", { ascending: false }).limit(1).maybeSingle(),
      ]);
      // Lời nói trong từng clip: caption viết từ cái người xem thật sự nghe.
      const segments = ((artifact?.data as { segments?: { start: number; end: number; text: string }[] } | null)?.segments ?? []);
      return {
        status: row.status,
        error: row.error,
        createdAt: row.created_at,
        title: row.title,
        clips: ((clips ?? []) as { id: string; idx: number; hook: string | null; reason: string | null; start_seconds: number; end_seconds: number; score: number | null }[]).map((clip) => ({
          id: clip.id,
          idx: clip.idx,
          hook: clip.hook ?? "",
          reason: clip.reason ?? "",
          start: Number(clip.start_seconds),
          end: Number(clip.end_seconds),
          score: clip.score === null ? null : Number(clip.score),
          text: segments
            .filter((segment) => segment.end > clip.start_seconds && segment.start < clip.end_seconds)
            .map((segment) => segment.text.trim())
            .join(" ")
            .slice(0, 4000),
        })),
      };
    },
    async saveVideoPack(userId, runId, jobId, clips, captions) {
      const row = one<{ id: string }>(await rpc("cmo_save_video_pack", { p_user: userId, p_run: runId, p_job: jobId, p_clips: clips, p_captions: captions }));
      if (!row) throw new Error("cmo_save_video_pack: không trả về hàng");
      return row.id;
    },
    defer: (run, seconds, steps) => rpc<boolean>("cmo_defer_run", { p_run: run.id, p_attempt: run.attempt, p_seconds: seconds, p_steps: steps }),
    async saveInsight(userId, runId, body) {
      await rpc("cmo_save_insight", { p_user: userId, p_run: runId, p_kind: "competitors", p_body: body });
    },
    async latestInsight(userId) {
      const { data } = await admin.from("cmo_insights").select("body").eq("user_id", userId).eq("kind", "competitors").order("created_at", { ascending: false }).limit(1).maybeSingle();
      return ((data as { body?: CompetitorInsight } | null)?.body ?? null);
    },
    saveMetrics: (userId, rows) => rpc<number>("cmo_save_metrics", { p_user: userId, p_rows: rows }),
  };
}
