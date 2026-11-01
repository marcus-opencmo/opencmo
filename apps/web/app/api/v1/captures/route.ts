import { z } from "zod";

import { withApi } from "@/lib/api/handler";
import { createCapture } from "@/lib/capture";

export const dynamic = "force-dynamic";

const body = z.object({
  url: z.string().trim().min(1, "Give the address of the page to capture.").max(2048, "That address is too long."),
});

/**
 * Capture a public page for proof B-roll → `{ capture_id, status }`. Free; the RPC refuses
 * addresses that are not public pages and caps captures at 30 a day (429), and the same page
 * within 24 h comes back from the cache.
 */
// Each capture loads someone else's page on our worker.
export const POST = withApi({ body, rateLimit: { bucket: "captures", limit: 60, windowSeconds: 3600 } }, async ({ supabase, body }) => createCapture(supabase, body.url));
