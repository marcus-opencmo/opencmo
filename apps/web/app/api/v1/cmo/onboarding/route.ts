import { z } from "zod";

import { withApi } from "@/lib/api/handler";
import { runOnboarding } from "@/lib/cmo/onboard";

export const dynamic = "force-dynamic";
// Đọc vài trang web + một lần gọi model: thường 20–60 giây.
export const maxDuration = 120;

const body = z.object({ site: z.string().trim().min(3).max(300) });

// Each onboarding reads a website and runs the model; SQL allows 5 a day, this stops a loop before any of that work.
export const POST = withApi({ body, rateLimit: { bucket: "onboarding", limit: 20, windowSeconds: 3600 } }, async ({ supabase, body }) => runOnboarding(supabase, body.site));
