/**
 * Gợi ý sửa tài liệu ở cột Context ("Add a category", "Sharpen your one-liner"…).
 *
 * Tính thật từ document, không gọi model: chip phải đúng cả trên production,
 * nơi không có dữ liệu mẫu. Thứ tự là độ ảnh hưởng tới bài agent viết —
 * thiếu khách hàng lý tưởng làm hỏng mọi bản nháp, thiếu category chỉ làm nhãn trống.
 */

import type { DocumentKind } from "./documents";
import type { Suggestion, Workspace } from "./workspace";

type Docs = Workspace["documents"];

const text = (docs: Docs, kind: DocumentKind, key: string): string => {
  const value = docs[kind]?.body[key];
  return typeof value === "string" ? value.trim() : "";
};
const count = (docs: Docs, kind: DocumentKind, key: string): number => {
  const value = docs[kind]?.body[key];
  return Array.isArray(value) ? value.length : 0;
};
const vague = (value: string) => value === "" || /^not (stated|listed)/i.test(value);

export function suggestFixes(docs: Docs, max = 3): Suggestion[] {
  const out: Suggestion[] = [];
  const add = (label: string, kind: DocumentKind) => out.push({ label, href: `/app?doc=${kind}` });

  if (docs.strategy && text(docs, "strategy", "icp").length < 40) add("Describe your ideal customer", "strategy");
  if (docs.product && vague(text(docs, "product", "audience"))) add("Add who buys it", "product");
  if (docs.strategy && count(docs, "strategy", "pains") < 2) add("List your customers' pains", "strategy");
  if (docs.product && text(docs, "product", "one_liner").length < 25) add("Sharpen your one-liner", "product");
  if (docs.competitors && count(docs, "competitors", "competitors") === 0) add("Add competitors", "competitors");
  if (docs.strategy && text(docs, "strategy", "voice").length < 20) add("Describe your brand voice", "strategy");
  if (docs.product && text(docs, "product", "category") === "") add("Add a category", "product");
  if (docs.product && vague(text(docs, "product", "pricing"))) add("Add your pricing", "product");
  return out.slice(0, max);
}
