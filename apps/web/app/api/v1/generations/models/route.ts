import { withApi } from "@/lib/api/handler";
import { availableModels, loadCatalog } from "@/lib/generate/models";

export const dynamic = "force-dynamic";

/**
 * Model sinh media dùng được ngay bây giờ, kèm giá và giới hạn — panel
 * Generate tính giá trước khi bấm bằng đúng bảng này (`priceOf`). Danh sách
 * rỗng nghĩa là máy chủ chưa bật provider nào; panel nói thẳng như vậy.
 */
export const GET = withApi({}, async ({ supabase }) => {
  await loadCatalog(supabase);
  return { models: availableModels().map(({ id, kind, name, description, price, limits }) => ({
    id,
    kind,
    name,
    description,
    price,
    limits,
  })) };
});
