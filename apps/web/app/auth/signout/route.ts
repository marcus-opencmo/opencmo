import { NextResponse } from "next/server";

import { createServerClient } from "@/lib/supabase/server";

export async function POST() {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
  // Location tương đối: `request.nextUrl.origin` không đọc header `Host` và trả
  // về `localhost` khi chạy sau proxy — xem `app/auth/callback/route.ts`.
  // 303: đổi POST thành GET khi chuyển hướng, không thì trình duyệt POST lại.
  return new NextResponse(null, { status: 303, headers: { location: "/" } });
}
