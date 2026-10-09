/**
 * Hành động của màn AI CMO, dùng chung cho các cột. Thẻ/mục mẫu (`demo-…`, `k…`)
 * chỉ đổi trong trình duyệt; thẻ thật gọi API (mọi luật nằm trong RPC).
 */

import type { BriefView, GoalView, InboxCard } from "@/lib/cmo/workspace";

import type { DocView } from "./DocumentSheet";

export type CardAct =
  | { type: "approve"; text?: string }
  | { type: "skip"; reason?: string }
  | { type: "posted"; url?: string }
  | { type: "replied" }
  | { type: "dismiss"; reason?: string };

export type RunKind = "plan_week" | "post_draft" | "sales_scan";

export type GoalAct = { action: "approve"; target?: number } | { action: "reject" };

export type BriefAct = { action: "approve" } | { action: "skip"; reason?: string };

export type CalendarAct = { action: "edit"; idea: string; day: string } | { action: "remove" };

export type Actions = {
  card(card: InboxCard, act: CardAct): Promise<boolean>;
  /** Approve (optionally with a new target) or reject a weekly goal the CMO proposed. */
  goal(goal: GoalView, act: GoalAct): Promise<boolean>;
  /** Approve a video brief (opens the project with it in the assistant) or skip it. */
  brief(brief: BriefView, act: BriefAct): Promise<boolean>;
  run(kind: RunKind): Promise<void>;
  calendar(id: string, act: CalendarAct): Promise<boolean>;
  toast(message: string): void;
  /** Đọc lại workspace (sau khi một việc bắt đầu ngoài `run`, ví dụ gói video). */
  refresh(): Promise<void>;
  /** Mở một tài liệu trong sheet trên dashboard (`?doc=`), không chuyển trang. */
  openDoc(view: DocView): void;
};

export const isSample = (id: string) => id.startsWith("demo-") || /^k\d+$/.test(id);

/** Link soạn sẵn bài trên X: người dùng bấm Post trên tài khoản của chính họ (đăng hỗ trợ, W3). */
export function xIntent(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}
