import { NextResponse, type NextRequest } from "next/server";

import { cronAuthorized } from "@/lib/cron-auth";
import { drainCmoQueue } from "@/lib/cmo/jobs/runner";
import { supabaseStore } from "@/lib/cmo/jobs/store";
import { isoDay } from "@/lib/cmo/jobs/types";
import { dueLoops, type LoopState } from "@/lib/cmo/loops";
import { socialReaderReady } from "@/lib/cmo/social/reddit";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Lịch của CMO (docs/cmo/san-pham.md §9 bước 6). Vercel Cron gọi 00:05 UTC
 * (7:05 giờ Việt Nam) — đúng sau nửa đêm UTC để "hôm nay" của lịch (ngày UTC,
 * như `current_date`) trùng với buổi sáng của người dùng.
 *
 * Đọc trạng thái mỗi người dùng rồi hỏi bảng vòng lặp (`lib/cmo/loops.ts`, H5): kế hoạch tuần,
 * bài X tới hạn, Reddit tới hạn, nghiên cứu đối thủ Chủ nhật, số liệu bài đã đăng. Vét hàng đợi
 * trong ngân sách thời gian; phần còn lại chạy khi người dùng mở app.
 *
 * Thả việc trùng không sao: `enqueue_cmo_run_for` trả lượt đang chờ thay vì tạo mới.
 */
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request.headers.get("authorization"), "cmo")) {
    return NextResponse.json({ error: "Forbidden." }, { status: 401 });
  }
  const started = Date.now();
  const admin = createAdminClient(AbortSignal.timeout((maxDuration - 10) * 1000));
  const today = isoDay();
  const weekday = new Date().getUTCDay();

  const { data: docs, error } = await admin.from("marketing_documents_latest").select("user_id, kind, body").in("kind", ["product", "competitors"]);
  if (error) return NextResponse.json({ error: "Could not read users." }, { status: 500 });
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
      // Hết credit, chạm trần ngày: bỏ qua người này, không dừng cả lượt cron.
      if (enqueueError) console.warn("[cron] cmo: bỏ qua", run.loop, enqueueError.message);
      else queued += 1;
    }
  }

  const ran = await drainCmoQueue(supabaseStore(admin), { budgetMs: (maxDuration - 30) * 1000 - (Date.now() - started) });
  return NextResponse.json({ users: users.length, queued, ran });
}
