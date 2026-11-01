import { z } from "zod";

import { withApi } from "@/lib/api/handler";
import { runOnboarding } from "@/lib/cmo/onboard";

export const dynamic = "force-dynamic";
// Đọc vài trang web + một lần gọi model: thường 20–60 giây.
export const maxDuration = 120;

const body = z.object({ site: z.string().trim().min(3).max(300) });

export const POST = withApi({ body }, async ({ supabase, body }) => runOnboarding(supabase, body.site));
