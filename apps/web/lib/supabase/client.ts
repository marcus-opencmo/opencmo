import { createBrowserClient } from "@supabase/ssr";

/** Client phía trình duyệt. Chỉ dùng anon key — mọi quyền do RLS quyết định. */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
