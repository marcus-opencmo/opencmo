/**
 * Mỗi việc tốn bao nhiêu credit — bảng hiện trên landing.
 *
 * Không `server-only` như `pricing.ts`: đây chỉ là dữ liệu hiển thị. Phút video
 * khớp `CREDITS_PER_MINUTE`; trợ lý và cảnh 3D là mức giữ trước của mỗi lượt
 * (`lib/agent/limits.ts`). Post và Sales chưa có code trừ credit — số ở đây là
 * đề xuất, phải chốt trước khi bật thanh toán cho hai department này.
 */

import { CREDITS_PER_MINUTE } from "./credits";

export type UsageItem = { action: string; detail: string; credits: string };

export const USAGE: UsageItem[] = [
  { action: "Video minute", detail: "Each minute of your recording turned into clips", credits: `${CREDITS_PER_MINUTE}` },
  { action: "Post draft", detail: "One X post drafted from your strategy", credits: "1" },
  { action: "Conversation scan", detail: "One Reddit search, scored, with replies drafted", credits: "5" },
  { action: "Assistant request", detail: "Ask the CMO or edit a clip by asking", credits: "from 5" },
  { action: "3D scene", detail: "A motion-graphics scene for your video", credits: "from 20" },
];
