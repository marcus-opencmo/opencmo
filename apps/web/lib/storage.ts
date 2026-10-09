/**
 * Lớp bọc storage — Supabase Storage.
 *
 * QUY TẮC: phần còn lại của ứng dụng KHÔNG BAO GIỜ gọi thẳng SDK storage.
 * Mọi thứ đi qua các hàm dưới đây. Ngoại lệ duy nhất là cron dọn rác — nó chạy
 * bằng service role, không có phiên đăng nhập nào để các hàm này dựa vào.
 *
 * Vì sao Supabase Storage chứ không phải Cloudflare R2:
 *   Trên gói Pro, Supabase cho 100GB lưu trữ và 250GB egress mỗi tháng — với
 *   ~200MB egress mỗi job, đó là khoảng 1.250 job/tháng nằm trong gói. Đủ rộng
 *   cho giai đoạn này.
 *
 *   Đổi lại được hai thứ đáng giá hơn khoản tiết kiệm egress: một nhà cung cấp
 *   duy nhất cho auth + DB + storage, và Row Level Security áp dụng LUÔN cho
 *   file — "chỉ chủ sở hữu đọc được clip của mình" là một policy SQL
 *   (xem 20260907162807_init.sql), không phải logic phân quyền ta tự viết và tự sai được.
 *
 *   Xem COSTS.md §5. Nếu sau này hóa đơn egress vượt mức, đổi sang R2 là thay
 *   nội dung file này — đó là lý do nó tồn tại.
 */

import { createServerClient } from "./supabase/server";

/**
 * Bốn bucket của sản phẩm. `sources` giữ cả file nguồn người dùng upload, cache
 * section của worker và proxy cho editor; `renders` giữ preview/export/ZIP.
 */
export const BUCKETS = ["clips", "sources", "renders", "media", "exports", "brand"] as const;
export type Bucket = (typeof BUCKETS)[number];

/**
 * Bucket RIÊNG cho file người dùng upload lên.
 *
 * Không dùng chung `clips` vì vòng đời ngược nhau: clip sống 7 ngày để người
 * dùng tải về, file nguồn bị xoá NGAY khi job kết thúc (`modal_app.py`, nhánh
 * `finally`). Một bucket riêng cho không thứ mà dùng chung sẽ phải tự viết:
 * phân biệt hai loại file bằng đường dẫn.
 */
export const SOURCES_BUCKET = "sources";

// ------------------------------------------------- signed URL cho mọi bucket

/** TTL phát video. Đủ dài cho một buổi chỉnh sửa, đủ ngắn để link rò rỉ hết hạn. */
const PLAY_TTL = 3600;
/** TTL link tải: bấm xong là dùng ngay. */
const DOWNLOAD_TTL = 300;

/**
 * Ký một object bất kỳ trong bốn bucket.
 *
 * `path` PHẢI tới từ một hàng trong database (manifest của worker, storage_path
 * của asset), không bao giờ từ query string. Ký thẳng đường dẫn client gửi lên
 * là biến lớp này thành một cửa đọc mọi file — RLS của Storage vẫn chặn, nhưng
 * ta không được dựa vào một lớp duy nhất cho một thứ dễ kiểm tới vậy.
 *
 * `download` là tên file để Supabase trả `Content-Disposition: attachment`.
 * Thiếu nó thì trình duyệt mở mp4 ra phát tại chỗ thay vì tải về.
 */
export async function signedObjectUrl(
  bucket: Bucket,
  path: string,
  options: { ttl?: number; download?: string } = {},
): Promise<string> {
  if (!path || path.includes("..")) {
    throw new Error(`Could not sign a link (${bucket}).`);
  }
  // Nhánh duy nhất của `sources` mà trình duyệt được xem là proxy cho editor:
  // file nguồn gốc và cache section là dữ liệu thô, không phát cho client.
  if (bucket === "sources" && !path.includes("/proxy/")) {
    throw new Error("Could not sign a link (sources).");
  }

  const supabase = await createServerClient();
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, options.ttl ?? (options.download ? DOWNLOAD_TTL : PLAY_TTL),
      options.download ? { download: options.download } : undefined);
  if (error || !data) {
    throw new Error(`Could not sign a download link (${path}): ${error?.message}`);
  }
  return data.signedUrl;
}
