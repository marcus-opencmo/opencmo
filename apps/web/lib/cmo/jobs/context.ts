/** Chữ đưa vào prompt: document, trí nhớ, bài gần đây. Gom một chỗ để W1/W2 (và chat) nói cùng một thứ. */

import { DOCUMENTS } from "../documents";
import { escapeAttribute, escapeForTag } from "../untrusted";
import type { CmoStore, CompetitorInsight, Documents, Goal, ItemRow, Lesson, MemoryTopic, NicheVideoInsight } from "./types";

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

/** The goal the founder approved for this week; the plan should serve it. Empty when there is none. */
export function goalBlock(goal: Goal | null): string {
  if (!goal || goal.status !== "approved") return "";
  return `<week_goal approved_by="founder">${goal.goal} (target: ${goal.target} ${goal.metric}). Plan the week so this is reachable.</week_goal>\n\n`;
}

/** Keeps the newest lesson per topic (rows must come newest week first). */
export function latestPerTopic(rows: Lesson[]): Lesson[] {
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.topic) ? false : (seen.add(row.topic), true)));
}

/**
 * Memory tier 0: rules the founder approved from their own edits. Read before anything else and stated as rules,
 * because the founder already decided them; lessons and notes are only evidence.
 */
export function correctionsBlock(rules: string[]): string {
  if (!rules.length) return "";
  return `<founder_rules approved_by="founder">\n${rules.map((r) => `- ${r}`).join("\n")}\n</founder_rules>`;
}

/** Weekly lessons (memory tier 3): what the summary learned, read before every plan or draft. */
export function lessonsBlock(lessons: Lesson[]): string {
  if (!lessons.length) return "";
  return `<lessons>\n${lessons.map((l) => `- ${l.topic} (week of ${l.week}): ${l.body}`).join("\n")}\n</lessons>`;
}

/**
 * What a job remembers: the founder's rules first (every topic: a rule from post edits still binds a reply),
 * then the latest lessons for its topic and `general`, then the most important unexpired notes for that topic.
 * Without a topic (the weekly plan) it reads every topic.
 */
export async function recall(store: CmoStore, userId: string, limit: number, topic?: MemoryTopic): Promise<string> {
  const [rules, lessons, memories] = await Promise.all([store.corrections(userId), store.lessons(userId), store.memories(userId, limit, topic)]);
  const relevant = topic ? lessons.filter((l) => l.topic === topic || l.topic === "general") : lessons;
  return [correctionsBlock(rules), lessonsBlock(relevant), memoriesBlock(memories)].filter(Boolean).join("\n\n");
}

/**
 * Điều W7 học được (hook/format có URL) — dữ liệu cho Planner và X writer, cùng luật: adapt, không chép.
 * Bản quá 21 ngày bỏ qua: hook "đang chạy" của tháng trước không còn là bằng chứng.
 */
export function insightBlock(insight: CompetitorInsight | null): string {
  if (!insight || Date.now() - new Date(insight.measured_at).getTime() > 21 * 86_400_000) return "";
  // Competitors' posts are outside text: escaped so a post cannot close the tag and speak as the founder.
  const hooks = insight.hooks.map((h) => `- ${escapeForTag(h.pattern)} (${h.lift}x, e.g. "${escapeForTag(h.example)}") ${escapeForTag(h.url)}`).join("\n");
  const ideas = insight.ideas.map((i) => `- ${escapeForTag(i.idea)} (from ${escapeForTag(i.inspired_by)})`).join("\n");
  return `<what_works_now source="competitor research ${insight.measured_at.slice(0, 10)}">\nHooks:\n${hooks}\nFormats: ${escapeForTag(insight.formats.join("; "))}\nIdeas:\n${ideas}\n</what_works_now>`;
}

/**
 * Niche video research for the video brief (P5 R2): each standout short with its hook, format, lift and URL. Outside
 * text, so it goes in its own tag as data; stale after three weeks like competitor research.
 */
export function nicheBlock(insight: NicheVideoInsight | null): string {
  if (!insight || !insight.videos.length || Date.now() - new Date(insight.measured_at).getTime() > 21 * 86_400_000) return "";
  const videos = insight.videos
    .map((v) => `- ${v.platform === "tiktok" ? "TikTok" : "YouTube"} · ${escapeForTag(v.format)} · ${v.lift}x the median · hook: "${escapeForTag(v.hook)}" · why: ${escapeForTag(v.why)} · ${v.url}`)
    .join("\n");
  return `<what_works_on_video source="niche video research ${insight.measured_at.slice(0, 10)}" topics="${escapeAttribute(insight.topics.join(", "))}">\n${videos}\nFormats: ${escapeForTag(insight.formats.join("; "))}\n</what_works_on_video>`;
}

export function postText(item: ItemRow): string {
  return item.final_text ?? (typeof item.body.text === "string" ? item.body.text : "");
}

/** Danh sách từ cấm của Strategy (`avoid`), đã chuẩn hoá. */
export function avoidList(docs: Documents): string[] {
  const avoid = docs.strategy?.avoid;
  return Array.isArray(avoid) ? avoid.filter((a): a is string => typeof a === "string" && a.trim().length > 0).map((a) => a.trim()) : [];
}

/** The product's own name(s) from the product document: "Cal.com" names the product, it is not a link. */
export function productNames(docs: Documents): string[] {
  const name = docs.product?.name;
  return typeof name === "string" && name.trim() ? [name.trim()] : [];
}

/** What the code checks hold a draft to (`CheckRules` in check-post.ts), from the founder's documents. */
export function checkRules(docs: Documents): { avoid: string[]; known: Set<string>; names: string[] } {
  return { avoid: avoidList(docs), known: knownNumbers(docs), names: productNames(docs) };
}

/** Mọi con số xuất hiện trong document — bài nháp chỉ được dùng số có ở đây. */
export function knownNumbers(docs: Documents): Set<string> {
  const text = JSON.stringify(docs);
  return new Set((text.match(/\d[\d,.]*/g) ?? []).map(normalizeNumber));
}

export function normalizeNumber(raw: string): string {
  return raw.replace(/[,.]+$/, "").replace(/,/g, "");
}
