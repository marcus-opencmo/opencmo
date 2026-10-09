/** Chữ đưa vào prompt: document, trí nhớ, bài gần đây. Gom một chỗ để W1/W2 (và chat) nói cùng một thứ. */

import { DOCUMENTS } from "../documents";
import type { CmoStore, CompetitorInsight, Documents, ItemRow, Lesson, MemoryTopic } from "./types";

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

/** Keeps the newest lesson per topic (rows must come newest week first). */
export function latestPerTopic(rows: Lesson[]): Lesson[] {
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.topic) ? false : (seen.add(row.topic), true)));
}

/** Weekly lessons (memory tier 3): what the summary learned, read before every plan or draft. */
export function lessonsBlock(lessons: Lesson[]): string {
  if (!lessons.length) return "";
  return `<lessons>\n${lessons.map((l) => `- ${l.topic} (week of ${l.week}): ${l.body}`).join("\n")}\n</lessons>`;
}

/**
 * What a job remembers: the latest lessons for its topic and `general`, then the most important
 * unexpired notes for that topic. Without a topic (the weekly plan) it reads every topic.
 */
export async function recall(store: CmoStore, userId: string, limit: number, topic?: MemoryTopic): Promise<string> {
  const [lessons, memories] = await Promise.all([store.lessons(userId), store.memories(userId, limit, topic)]);
  const relevant = topic ? lessons.filter((l) => l.topic === topic || l.topic === "general") : lessons;
  return [lessonsBlock(relevant), memoriesBlock(memories)].filter(Boolean).join("\n\n");
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
