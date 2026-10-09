/**
 * Bộ document marketing của tầng CMO (docs/cmo/san-pham.md §3.1).
 *
 * File này dùng chung client + server: schema zod (route kiểm body, generate ép
 * model ra đúng hình), nhãn tiếng Anh và mô tả field để màn sửa tự vẽ form.
 *
 * Schema KHÔNG đặt `.max()` cho chuỗi: structured output của Claude bỏ qua ràng
 * buộc độ dài, nên model vượt là `parse` hỏng cả lượt. Độ dài cắt bằng
 * `clampDocument` sau khi nhận, và DB chặn tổng 64 KB.
 */

import { z } from "zod";

export const DOCUMENT_KINDS = ["product", "strategy", "competitors", "content_strategy"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

const list = z.array(z.string());

export const ProductSchema = z.object({
  name: z.string().describe("Product or company name"),
  category: z.string().describe("Category in one or two words, e.g. 'SaaS', 'Mobile app', 'Agency'"),
  one_liner: z.string().describe("What it does, in one sentence a customer would say"),
  description: z.string().describe("Two or three sentences: what it is, who it is for, why it is different"),
  audience: z.string().describe("Who buys it"),
  problems: list.describe("Problems it solves, in the customer's words"),
  features: list.describe("Main features or capabilities, as stated on the website"),
  pricing: z.string().describe("Pricing as stated on the website, or 'Not listed on the website'"),
  x_handle: z.string().optional().describe("The product's or founder's X handle if the website links to it, else empty. Never guess."),
});

export const StrategySchema = z.object({
  icp: z.string().describe("Ideal customer profile: role, company type, situation"),
  pains: list.describe("The pains that make them look for a solution"),
  positioning: z.string().describe("One positioning statement: for whom, what category, key difference"),
  value_props: list.describe("Three to five reasons to choose this product"),
  voice: z.string().describe("How the brand should sound, in one or two sentences"),
  avoid: list.describe("Words, claims or tones to avoid"),
});

export const CompetitorsSchema = z.object({
  competitors: z
    .array(
      z.object({
        name: z.string(),
        website: z.string().describe("Homepage URL, or empty if unsure"),
        difference: z.string().describe("How this product differs from it"),
        x_handle: z.string().optional().describe("Its X handle only if you are sure, else empty"),
      }),
    )
    .describe("Up to five real, well-known alternatives. Fewer is better than guessing."),
});

export const ContentStrategySchema = z.object({
  pillars: z
    .array(z.object({ name: z.string(), why: z.string(), ideas: list.describe("Three post ideas") }))
    .describe("Three or four content pillars"),
  x: z.string().describe("How to use X (Twitter) for this product"),
  reddit: z.string().describe("Which conversations on Reddit matter and how to join them helpfully"),
  short_video: z.string().describe("What short videos to make from recordings the founder already has"),
  cadence: z.string().describe("A realistic weekly rhythm for a solo founder"),
});

export const DOCUMENT_SCHEMAS = {
  product: ProductSchema,
  strategy: StrategySchema,
  competitors: CompetitorsSchema,
  content_strategy: ContentStrategySchema,
} as const;

export type DocumentBodies = {
  product: z.infer<typeof ProductSchema>;
  strategy: z.infer<typeof StrategySchema>;
  competitors: z.infer<typeof CompetitorsSchema>;
  content_strategy: z.infer<typeof ContentStrategySchema>;
};

/** Một lượt onboarding trả về đủ bốn document trong một lần gọi model. */
export const OnboardingSchema = z.object(DOCUMENT_SCHEMAS);
export type OnboardingDrafts = z.infer<typeof OnboardingSchema>;

/** Cách vẽ form: mỗi field là chữ ngắn, đoạn dài, danh sách dòng, hoặc nhóm lặp. */
export type Field =
  | { key: string; label: string; type: "text" | "long" | "list" }
  | { key: string; label: string; type: "group"; fields: Field[]; max: number };

export const DOCUMENTS: Record<DocumentKind, { title: string; summary: string; fields: Field[] }> = {
  product: {
    title: "Product Information",
    summary: "What you sell and who it is for.",
    fields: [
      { key: "name", label: "Name", type: "text" },
      { key: "category", label: "Category", type: "text" },
      { key: "one_liner", label: "One-liner", type: "text" },
      { key: "description", label: "Description", type: "long" },
      { key: "audience", label: "Who buys it", type: "text" },
      { key: "problems", label: "Problems it solves", type: "list" },
      { key: "features", label: "Main features", type: "list" },
      { key: "pricing", label: "Pricing", type: "text" },
      { key: "x_handle", label: "Your X handle", type: "text" },
    ],
  },
  strategy: {
    title: "Marketing Strategy",
    summary: "Who you are talking to and how you sound.",
    fields: [
      { key: "icp", label: "Ideal customer", type: "long" },
      { key: "pains", label: "Their pains", type: "list" },
      { key: "positioning", label: "Positioning", type: "long" },
      { key: "value_props", label: "Why choose you", type: "list" },
      { key: "voice", label: "Brand voice", type: "long" },
      { key: "avoid", label: "Words and claims to avoid", type: "list" },
    ],
  },
  competitors: {
    title: "Competitor Analysis",
    summary: "The alternatives your customers compare you with.",
    fields: [
      {
        key: "competitors",
        label: "Competitors",
        type: "group",
        max: 8,
        fields: [
          { key: "name", label: "Name", type: "text" },
          { key: "website", label: "Website", type: "text" },
          { key: "difference", label: "How you differ", type: "long" },
          { key: "x_handle", label: "X handle", type: "text" },
        ],
      },
    ],
  },
  content_strategy: {
    title: "Content Strategy",
    summary: "What to talk about, and where.",
    fields: [
      {
        key: "pillars",
        label: "Content pillars",
        type: "group",
        max: 6,
        fields: [
          { key: "name", label: "Pillar", type: "text" },
          { key: "why", label: "Why it matters", type: "long" },
          { key: "ideas", label: "Post ideas", type: "list" },
        ],
      },
      { key: "x", label: "On X", type: "long" },
      { key: "reddit", label: "On Reddit", type: "long" },
      { key: "short_video", label: "Short videos", type: "long" },
      { key: "cadence", label: "Weekly rhythm", type: "text" },
    ],
  },
};

const LIMITS = { text: 200, long: 1500, list: 12, item: 300 };

/** Cắt mọi chuỗi và danh sách theo mô tả field — chạy trên cả bản agent lẫn bản người sửa. */
export function clampDocument(kind: DocumentKind, body: Record<string, unknown>): Record<string, unknown> {
  return clampFields(DOCUMENTS[kind].fields, body);
}

function clampFields(fields: Field[], body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = body[field.key];
    if (field.type === "group") {
      const rows = Array.isArray(value) ? value : [];
      out[field.key] = rows
        .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
        .slice(0, field.max)
        .map((row) => clampFields(field.fields, row));
    } else if (field.type === "list") {
      const items = Array.isArray(value) ? value : [];
      out[field.key] = items
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, LIMITS.item))
        .filter(Boolean)
        .slice(0, LIMITS.list);
    } else {
      out[field.key] = typeof value === "string" ? value.trim().slice(0, LIMITS[field.type]) : "";
    }
  }
  return out;
}
