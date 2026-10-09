import { NextResponse, type NextRequest } from "next/server";

import { bearerMatches } from "@/lib/cron-auth";
import { BUCKETS, SOURCES_BUCKET, type Bucket } from "@/lib/storage";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  sweepOrphanPages,
  type CleanupQueueEntry,
} from "@/lib/cleanup";

/** Supabase Storage nhận tối đa 1000 key một lần; 100 giữ mỗi lượt đủ ngắn. */
const REMOVE_BATCH = 100;

/** Số đường dẫn xin mỗi lượt gọi. */
const QUEUE_BATCH = 200;

/** Dừng khi còn dưới ngần này: `maxDuration` là 60 giây và phải kịp trả lời. */
const RESERVE_MS = 10_000;

export const maxDuration = 60;

/**
 * Dọn dữ liệu hết hạn. Vercel Cron gọi mỗi ngày (xem vercel.json).
 *
 * Thứ tự là cả thiết kế, không phải thói quen:
 *
 *   1. `expired_object_paths()` tombstone project hết hạn và GHI đường dẫn của
 *      nó xuống `storage_deletions` trong cùng một transaction. Từ giây đó
 *      project biến mất khỏi mọi truy vấn của người dùng, nên không ai ký được
 *      URL mới hay enqueue render mới trong lúc file đang bị xoá.
 *   2. Xoá file theo lô, xác nhận từng lô đã xoá xong.
 *   3. `purge_expired_jobs()` chỉ xoá hàng của project mà hàng đợi đã rỗng.
 *
 * Lỗi giữa chừng ở bước 2 không mất dấu gì cả: hàng đợi còn nguyên, lượt cron
 * sau chạy tiếp từ đúng chỗ đó.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;

  // Đóng khi THIẾU secret, không phải chỉ khi sai secret. Route này chạy bằng
  // service role và XOÁ dữ liệu, mà `.env.example` để `CRON_SECRET=` rỗng —
  // nên "chưa đặt thì cho qua" nghĩa là quên điền một dòng env là endpoint xoá
  // nằm công khai trên production. Bỏ trống chỉ được chấp nhận lúc chạy local.
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      console.error("[cron] thiếu CRON_SECRET — từ chối để không mở endpoint xoá");
      return NextResponse.json({ error: "Forbidden." }, { status: 401 });
    }
    console.warn("[cron] không có CRON_SECRET — chỉ chấp nhận vì đang chạy local");
  } else if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 401 });
  }

  const deadline = Date.now() + maxDuration * 1000 - RESERVE_MS;
  const supabase = createAdminClient(AbortSignal.timeout(maxDuration * 1000 - RESERVE_MS));
  const { data: startedAt, error: startError } = await supabase.rpc("cleanup_started_at");
  if (startError) return NextResponse.json({ error: "Cleanup failed." }, { status: 500 });

  // Tài khoản chưa từng trả tiền quá 30 ngày (migration 20261108090000): RPC đưa file của họ vào
  // hàng đợi, ở đây xoá user — cascade xoá hàng DB; vòng dưới xoá file ngay lượt này.
  const accounts = await purgeUnpaidAccounts(supabase);

  let removed = 0;
  let failed = 0;
  let queueFailed = false;
  while (!queueFailed && Date.now() < deadline) {
    const { data: rows, error } = await supabase.rpc("expired_object_paths", {
      p_limit: QUEUE_BATCH,
      p_started_at: startedAt,
    });
    if (error) {
      console.error("[cron] không đọc được hàng đợi xoá", error.code);
      return NextResponse.json({ error: "Cleanup failed." }, { status: 500 });
    }
    const queue = (rows ?? []) as CleanupQueueEntry[];
    if (!queue.length) break;

    const byBucket = new Map<Bucket, { id: number; path: string }[]>();
    for (const row of queue) {
      // Bucket tới từ `check` của bảng, nhưng lọc lại ở đây để một migration
      // tương lai thêm bucket mới không lặng lẽ gọi `storage.from(undefined)`.
      if (!BUCKETS.includes(row.bucket as Bucket)) continue;
      const bucket = row.bucket as Bucket;
      const list = byBucket.get(bucket) ?? [];
      list.push({ id: row.id, path: row.path });
      byBucket.set(bucket, list);
    }

    for (const [bucket, entries] of byBucket) {
      for (let i = 0; i < entries.length; i += REMOVE_BATCH) {
        if (Date.now() >= deadline || queueFailed) break;
        const batch = entries.slice(i, i + REMOVE_BATCH);
        const ids = batch.map((entry) => entry.id);
        const { error: removeError } = await supabase.storage
          .from(bucket)
          .remove(batch.map((entry) => entry.path));
        if (removeError) {
          // Giữ hàng lại và đẩy xuống cuối hàng đợi: một object hỏng không được
          // chặn mọi object sau nó ở mọi lượt cron.
          console.error("[cron] xoá file thất bại", bucket, removeError.message);
          const { error: deferError } = await supabase.rpc("defer_object_deletions", { p_ids: ids });
          if (deferError) queueFailed = true;
          failed += batch.length;
          continue;
        }
        const { error: confirmError } = await supabase.rpc("confirm_object_deletions", {
          p_ids: ids,
        });
        if (confirmError) {
          // File đã xoá nhưng hàng đợi chưa xác nhận: lượt sau gọi remove lần
          // nữa trên đường dẫn không còn tồn tại, Storage trả OK. Giữ thừa một
          // vòng an toàn hơn là xoá hàng đợi trước khi biết file đã đi.
          console.error("[cron] không xác nhận được lô đã xoá", confirmError.code);
          queueFailed = true;
          break;
        }
        removed += batch.length;
      }
    }
  }

  const { data: purged, error: purgeError } = await supabase.rpc("purge_expired_jobs", {
    p_job_ids: null,
  });
  if (purgeError) console.error("[cron] xoá hàng project thất bại", purgeError.code);

  const { error: limitsError } = await supabase.rpc("purge_stale_rate_limits");
  if (limitsError) console.error("[cron] dọn rate_limits thất bại", limitsError.code);

  const orphans =
    (await sweepOrphans(supabase, SOURCES_BUCKET, deadline)) + (await sweepOrphans(supabase, "media", deadline));

  console.log(
    `[cron] xoá ${removed} object (${failed} hoãn), ${purged ?? 0} project, ${orphans} file mồ côi, ${accounts} tài khoản free hết hạn`,
  );
  return NextResponse.json({ files: removed, deferred: failed, jobs: purged ?? 0, orphans, accounts });
}

/** Mỗi lượt tối đa ngần này tài khoản: deleteUser là một request Auth cho mỗi người. */
const ACCOUNT_BATCH = 50;

async function purgeUnpaidAccounts(supabase: ReturnType<typeof createAdminClient>): Promise<number> {
  const { data, error } = await supabase.rpc("purge_unpaid_accounts", { p_limit: ACCOUNT_BATCH });
  if (error) {
    console.error("[cron] không chọn được tài khoản free hết hạn", error.code);
    return 0;
  }
  let deleted = 0;
  for (const id of (data ?? []) as string[]) {
    // Lỗi một người không chặn người khác; lượt sau chọn lại họ (file đã nằm sẵn trong hàng đợi).
    const { error: deleteError } = await supabase.auth.admin.deleteUser(id);
    if (deleteError) console.error("[cron] xoá tài khoản thất bại", id, deleteError.message);
    else deleted++;
  }
  return deleted;
}

/**
 * Xoá file trong bucket không còn hàng nào trong database cần tới.
 *
 * Vì sao vẫn cần dù đã có hàng đợi: file được upload TRƯỚC khi có hàng nào trỏ
 * tới nó. Mọi lượt upload bỏ ngang (đóng tab, hết credit, mất mạng lúc bấm nút)
 * để lại một file vài trăm MB mà database chưa bao giờ biết tới — không có
 * bước này thì không đường nào tìm ra chúng.
 *
 * DB áp grace sáu giờ khi đọc metadata và lưu cursor theo tên. Kiểm lại tham
 * chiếu cho từng lô ngay trước xoá; không truyền tập giữ lại qua PostgREST.
 */
async function sweepOrphans(
  supabase: ReturnType<typeof createAdminClient>,
  bucket: Bucket,
  deadline: number,
): Promise<number> {
  try {
    return await sweepOrphanPages({
      deadline,
      scan: async () => {
        const { data, error } = await supabase.rpc("orphan_scan_page", { p_bucket: bucket, p_limit: REMOVE_BATCH });
        if (error) throw error;
        return (data ?? []).map((row: { path: string }) => row.path);
      },
      safe: async (paths) => {
        const { data, error } = await supabase.rpc("orphan_safe_paths", { p_bucket: bucket, p_paths: paths });
        if (error) throw error;
        return (data ?? []).map((row: { path: string }) => row.path);
      },
      remove: async (paths) => {
        const { error } = await supabase.storage.from(bucket).remove(paths);
        if (error) console.error("[cron] xoá file mồ côi thất bại", bucket, error.message);
        return !error;
      },
    });
  } catch (error) {
    console.error("[cron] quét file mồ côi thất bại", bucket, error instanceof Error ? error.message : error);
    return 0;
  }
}
