/**
 * Các vòng lặp của CMO (H5, theo skill marketing-loops của marketingskills): MỖI vòng khai báo
 * nhịp, điều kiện chạy, việc thả vào hàng đợi và input. Cron (`/api/cron/cmo`) chỉ đọc trạng thái
 * rồi hỏi bảng này — thêm/bớt vòng là sửa một chỗ, có check thuần (không DB).
 *
 * Luật chung (marketing-loops): tự soạn được, tự ĐĂNG thì không — mọi kết quả thành thẻ chờ duyệt.
 * Idempotent ở tầng DB: `cmo_enqueue` trả lượt đang chờ thay vì tạo mới, và chặn theo trần ngày.
 * Vòng tốn credit chỉ chạy khi người dùng đã đặt ý định (mục trên lịch), trừ W7 mỗi tuần.
 */

import type { CmoJobKind } from "./jobs/types";

export type LoopState = {
  /** 0 = Chủ nhật … 6 = thứ Bảy (UTC). */
  weekday: number;
  /** Mục X/Reddit tới hạn hôm nay (đầu tiên mỗi loại). */
  duePost: { idea: string } | null;
  dueSales: { idea: string } | null;
  /** Đã có handle X của đối thủ trong Competitor Analysis. */
  competitorHandles: number;
  /** Bài đã đăng trong 14 ngày (để đo số). */
  publishedRecently: number;
  /** Server có khoá ScrapeCreators (hoặc bản giả). */
  socialReader: boolean;
};

export type LoopRun = { loop: string; kind: CmoJobKind; input: Record<string, unknown> };

type Loop = { name: string; cadence: string; when: (s: LoopState) => boolean; run: (s: LoopState) => LoopRun };

export const LOOPS: Loop[] = [
  {
    name: "weekly-plan",
    cadence: "Monday",
    when: (s) => s.weekday === 1,
    run: () => ({ loop: "weekly-plan", kind: "plan_week", input: { source: "schedule" } }),
  },
  {
    name: "daily-x-draft",
    cadence: "daily, when an X item is due (and every Monday)",
    when: (s) => Boolean(s.duePost) || s.weekday === 1,
    run: () => ({ loop: "daily-x-draft", kind: "post_draft", input: { source: "schedule" } }),
  },
  {
    name: "reddit-listening",
    cadence: "daily, only when a Reddit item is due (5 credits)",
    when: (s) => s.socialReader && Boolean(s.dueSales),
    run: (s) => ({ loop: "reddit-listening", kind: "sales_scan", input: { source: "schedule", brief: s.dueSales!.idea } }),
  },
  {
    name: "competitor-research",
    cadence: "Sunday, when competitors have X handles (2 credits)",
    when: (s) => s.socialReader && s.weekday === 0 && s.competitorHandles > 0,
    run: () => ({ loop: "competitor-research", kind: "competitor_research", input: { source: "schedule" } }),
  },
  {
    name: "post-metrics",
    cadence: "daily, when something was published in the last 14 days (free)",
    when: (s) => s.socialReader && s.publishedRecently > 0,
    run: () => ({ loop: "post-metrics", kind: "pull_metrics", input: { source: "schedule" } }),
  },
];

/** Việc cần thả hôm nay cho một người dùng, theo thứ tự trong bảng. */
export function dueLoops(state: LoopState): LoopRun[] {
  return LOOPS.filter((loop) => loop.when(state)).map((loop) => loop.run(state));
}
