/**
 * Kiểm một bài X bằng code TRƯỚC khi tốn tiền model kiểm: độ dài, từ cấm, số bịa.
 * Luật "không bịa số" (docs/cmo/san-pham.md §2): số ≥ 10 hoặc phần trăm phải có
 * trong document của người dùng.
 */

import { normalizeNumber } from "./context";

export const X_LIMIT = 280;

export function checkPost(text: string, rules: { avoid: string[]; known: Set<string> }): string[] {
  const issues: string[] = [];
  const t = text.trim();
  if (!t) return ["The post is empty."];
  if ([...t].length > X_LIMIT) issues.push(`It is ${[...t].length} characters; X allows ${X_LIMIT}.`);
  const lower = t.toLowerCase();
  for (const word of rules.avoid) {
    const w = word.toLowerCase();
    if (w.length >= 3 && lower.includes(w)) issues.push(`It uses "${word}", which your strategy says to avoid.`);
  }
  for (const raw of t.match(/\d[\d,.]*%?/g) ?? []) {
    const isPercent = raw.endsWith("%");
    const n = normalizeNumber(raw.replace(/%$/, ""));
    if (!isPercent && Number(n) < 10) continue;
    if (/^(19|20)\d\d$/.test(n)) continue;
    if (!rules.known.has(n)) issues.push(`It says ${raw}, a number that is not in your documents.`);
  }
  if ((t.match(/#\w+/g) ?? []).length > 2) issues.push("It has more than two hashtags.");
  return issues;
}
