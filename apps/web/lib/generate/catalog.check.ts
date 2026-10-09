/**
 * Catalog từ bảng `ai_models` (G5): DB đè giá/giới hạn của JSON, hàng tắt biến mất, đọc hỏng thì
 * giữ bản đang có.
 *
 *     cd apps/web && npx tsx lib/generate/catalog.check.ts
 */
import assert from "node:assert/strict";

import { AI_MODELS } from "@opencmo/editor-core/generate";

import type { SupabaseClient } from "@/lib/api/handler";

import { availableModel, availableModels, loadCatalog, resetCatalog } from "./models";

process.env.OPENCMO_AI_FAKE = "1";
const base = AI_MODELS.find((model) => model.id === "fake-video")!;

const client = (rows: unknown[] | null) =>
  ({ from: () => ({ select: async () => (rows ? { data: rows, error: null } : { data: null, error: { message: "down" } }) }) }) as unknown as SupabaseClient;

async function main() {
  resetCatalog();
  assert.equal(availableModel("fake-video")?.price.credits, base.price.credits, "chưa nạp: dùng JSON");

  const rows = AI_MODELS.map((model) => ({ id: model.id, name: model.name, price: model.price, limits: model.limits, enabled: true }));
  const video = rows.find((row) => row.id === "fake-video")!;
  video.price = { ...video.price, credits: 7 };
  video.limits = { ...video.limits, durations: [3, 5, 7] };
  rows.find((row) => row.id === "fake-image")!.enabled = false;
  await loadCatalog(client(rows));
  assert.equal(availableModel("fake-video")?.price.credits, 7, "giá lấy từ DB");
  assert.deepEqual(availableModel("fake-video")?.limits.durations, [3, 5, 7], "giới hạn lấy từ DB");
  assert.equal(availableModel("fake-video")?.description, base.description, "mô tả vẫn từ JSON");
  assert.equal(availableModel("fake-image"), undefined, "hàng tắt trong DB thì không dùng được");
  assert.ok(availableModels().length > 0);

  resetCatalog();
  await loadCatalog(client(null));
  assert.equal(availableModel("fake-video")?.price.credits, base.price.credits, "đọc hỏng: rơi về JSON");

  console.log("catalog: mọi kiểm tra xanh");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
