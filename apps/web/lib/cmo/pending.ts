import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Số việc đang chờ người dùng duyệt — dòng phụ "N waiting" của Dashboard trên rail.
 *
 * Cùng điều kiện với mục "Awaiting your approval" của `loadWorkspace()`: bài X
 * `in_review`, thread Reddit `in_review`, gói video `in_review`. Bài/gói đã
 * duyệt (chờ đăng, chờ tải) không tính — đó không còn là việc phải quyết.
 *
 * Đọc dưới RLS bằng client của phiên, chỉ đếm (`head: true`), không kéo hàng.
 * Lỗi thì trả null: đây là chữ phụ trên rail, không được làm hỏng shell.
 */
export async function cmoPending(supabase: SupabaseClient): Promise<number | null> {
  const count = (table: string) => supabase.from(table).select("id", { count: "exact", head: true }).eq("status", "in_review");
  const [posts, threads, packs] = await Promise.all([
    count("content_items").eq("department", "post"),
    count("opportunities"),
    count("video_packs"),
  ]);
  if (posts.error || threads.error || packs.error) return null;
  return (posts.count ?? 0) + (threads.count ?? 0) + (packs.count ?? 0);
}
