/**
 * Category của blog = DẠNG bài (hướng dẫn, mẹo, playbook, kiến thức nền), không
 * phải tính năng sản phẩm: blog dạy marketing cho founder, không quảng cáo.
 * Slug nằm trong URL (`/blog/category/<slug>`); đổi slug thì thêm redirect ở
 * `CATEGORY_REDIRECTS` dưới đây.
 */
export const CATEGORIES = [
  {
    slug: "how-to",
    name: "How-to",
    description: "Step-by-step guides for one marketing task, start to finish.",
  },
  {
    slug: "tips",
    name: "Tips",
    description: "Short, practical tips you can use today.",
  },
  {
    slug: "playbooks",
    name: "Playbooks",
    description: "Repeatable plans for getting customers as a solo founder or small team.",
  },
  {
    slug: "basics",
    name: "Marketing basics",
    description: "Plain-language explanations of the ideas behind good marketing.",
  },
] as const;

/** Category cũ (đợt blog theo tính năng clipping, 01/10/2026) → category mới. */
export const CATEGORY_REDIRECTS: Record<string, string> = {
  clipping: "how-to",
  "short-form": "how-to",
  "founder-marketing": "playbooks",
  "ai-editing": "how-to",
};

export type CategorySlug = (typeof CATEGORIES)[number]["slug"];
export type Category = (typeof CATEGORIES)[number];

export function findCategory(slug: string): Category | undefined {
  return CATEGORIES.find((c) => c.slug === slug);
}
