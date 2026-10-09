import type { User } from "@supabase/supabase-js";

import { cmoPending } from "@/lib/cmo/pending";
import type { createServerClient } from "@/lib/supabase/server";

type ServerClient = Awaited<ReturnType<typeof createServerClient>>;

export type ShellAccount = {
  credits: number | null;
  plan: string | null;
  email: string | null;
  /** Khoá lọc Realtime cho job đang chạy của chính người này. */
  userId: string | null;
  /** Việc CMO đang chờ duyệt — dòng phụ "N waiting" của Dashboard trên rail. */
  pending: number | null;
};

/**
 * Ba thứ rail và top bar cần: số dư, gói, email.
 *
 * Đọc ở server để chúng có mặt ngay trong HTML đầu tiên — số credit là thứ
 * người dùng liếc vào trước khi bấm "Get clips", và một ô trống nhấp nháy ở đó
 * nói sai chuyện: "hết credit rồi?". Gói quyết định banner "You are on the Free
 * plan" có hiện hay không, nên cũng không được đến muộn.
 *
 * Nhận sẵn `supabase` và `user`: hàm này giờ chỉ được gọi từ `layout.tsx`, nơi
 * auth gate vừa lấy user xong. Tự gọi `getUser()` lần nữa là một vòng nữa tới
 * Auth cho một thứ đang nằm ngay trên tay.
 */
export async function shellAccount(
  supabase: ServerClient,
  user: User,
): Promise<ShellAccount> {
  const [{ data: balance }, { data: profile }, pending] = await Promise.all([
    supabase.rpc("credit_balance", { p_user_id: user.id }),
    supabase.from("profiles").select("plan").eq("id", user.id).maybeSingle<{ plan: string }>(),
    cmoPending(supabase),
  ]);

  return {
    credits: typeof balance === "number" ? balance : null,
    plan: profile?.plan ?? "free",
    email: user.email ?? null,
    userId: user.id,
    pending,
  };
}
