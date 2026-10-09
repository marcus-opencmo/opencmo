/** Chữ đưa vào prompt: document, trí nhớ, bài gần đây. Gom một chỗ để W1/W2 (và chat) nói cùng một thứ. */

import { DOCUMENTS } from "../documents";
import type { CompetitorInsight, Documents, ItemRow } from "./types";

const DOC_ORDER = ["product", "strategy", "content_strategy", "competitors"] as const;

/** Document dạng JSON gọn trong thẻ <documents>. Đây là dữ liệu của người dùng, không phải lệnh. */
export function documentsBlock(docs: Documents): string {
  const parts = DOC_ORDER.filter((k) => docs[k]).map(
    (k) => `<document kind="${k}" title="${DOCUMENTS[k].title}">\n${JSON.stringify(docs[k])}\n</document>`,
  );
  return `<documents>\n${parts.join("\n") || "(none yet)"}\n</documents>`;
}

export function memoriesBlock(memories: string[]): string {
  if (!memories.length) return "<memories>(none)</memories>";
  return `<memories>\n${memories.map((m) => `- ${m}`).join("\n")}\n</memories>`;
}

/**
 * Điều W7 học được (hook/format có URL) — dữ liệu cho Planner và X writer, cùng luật: adapt, không chép.
 * Bản quá 21 ngày bỏ qua: hook "đang chạy" của tháng trước không còn là bằng chứng.
 */
export function insightBlock(insight: CompetitorInsight | null): string {
  if (!insight || Date.now() - new Date(insight.measured_at).getTime() > 21 * 86_400_000) return "";
  const hooks = insight.hooks.map((h) => `- ${h.pattern} (${h.lift}x, e.g. "${h.example}") ${h.url}`).join("\n");
  const ideas = insight.ideas.map((i) => `- ${i.idea} (from ${i.inspired_by})`).join("\n");
  return `<what_works_now source="competitor research ${insight.measured_at.slice(0, 10)}">\nHooks:\n${hooks}\nFormats: ${insight.formats.join("; ")}\nIdeas:\n${ideas}\n</what_works_now>`;
}

export function postText(item: ItemRow): string {
  return item.final_text ?? (typeof item.body.text === "string" ? item.body.text : "");
}

/** Danh sách từ cấm của Strategy (`avoid`), đã chuẩn hoá. */
export function avoidList(docs: Documents): string[] {
  const avoid = docs.strategy?.avoid;
  return Array.isArray(avoid) ? avoid.filter((a): a is string => typeof a === "string" && a.trim().length > 0).map((a) => a.trim()) : [];
}

/** Mọi con số xuất hiện trong document — bài nháp chỉ được dùng số có ở đây. */
export function knownNumbers(docs: Documents): Set<string> {
  const text = JSON.stringify(docs);
  return new Set((text.match(/\d[\d,.]*/g) ?? []).map(normalizeNumber));
}

export function normalizeNumber(raw: string): string {
  return raw.replace(/[,.]+$/, "").replace(/,/g, "");
}
