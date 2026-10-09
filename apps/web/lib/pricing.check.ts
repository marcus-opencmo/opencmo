/**
 * Đối chiếu bảng giá TypeScript với quota thật trong Supabase local.
 *
 *     cd apps/web && npx tsx lib/pricing.check.ts
 *
 * Script cố ý chỉ nhận stack loopback để một lượt kiểm tra local không bao giờ
 * chạm database remote. `plan_quota()` chỉ cấp quyền cho service role.
 */
import assert from "node:assert/strict";

import { createClient } from "@supabase/supabase-js";

import { localSupabaseCredentials } from "./local-supabase";
import { AI_MODELS } from "@opencmo/editor-core/generate";

import { PLANS } from "./pricing";

const { url, serviceRoleKey } = localSupabaseCredentials({ cwd: process.cwd() });
const supabase = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

async function main(): Promise<void> {
  for (const plan of PLANS) {
    const { data, error } = await supabase.rpc("plan_quota", { p_plan: plan.id });
    if (error) throw new Error(`Không đọc được quota ${plan.id}: ${error.message}`);

    const row = Array.isArray(data) ? data[0] : data;
    assert.ok(row, `plan_quota(${plan.id}) không trả dữ liệu`);
    assert.deepEqual(
      {
        previewsPerDay: row.previews_per_day,
        exportsPerDay: row.exports_per_day,
      },
      {
        previewsPerDay: plan.previewsPerDay,
        exportsPerDay: plan.exportsPerDay,
      },
      `Quota ${plan.id} trong pricing.ts lệch plan_quota()`,
    );
    assert.deepEqual(
      { previews: plan.quota.previews, exports: plan.quota.exports },
      { previews: plan.previewsPerDay, exports: plan.exportsPerDay },
      `Quota cũ và quota ngày của ${plan.id} trong pricing.ts không khớp`,
    );
  }

  console.log(`Pricing quota: ${PLANS.length} gói khớp Supabase local.`);

  // Catalog sinh media (G5): DB là nguồn khi chạy, JSON là bản dự phòng + phần chỉ code cần.
  // Sau `db reset`, hai bên phải khớp — lệch là quên viết migration khi sửa JSON (hay ngược lại).
  const { data: rows, error: rowsError } = await supabase.from("ai_models").select("id, kind, provider, price, limits");
  if (rowsError || !rows) throw new Error(`Không đọc được ai_models: ${rowsError?.message}`);
  const byId = new Map(rows.map((row) => [row.id as string, row]));
  for (const model of AI_MODELS) {
    const row = byId.get(model.id);
    assert.ok(row, `${model.id} có trong ai-models.json nhưng không có trong ai_models (thiếu migration?)`);
    assert.deepEqual(
      { kind: row.kind, provider: row.provider, price: row.price, limits: row.limits },
      { kind: model.kind, provider: model.provider, price: model.price, limits: model.limits },
      `${model.id}: ai-models.json lệch ai_models`,
    );
  }
  console.log(`Catalog: ${AI_MODELS.length} model trong ai-models.json khớp ai_models.`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
