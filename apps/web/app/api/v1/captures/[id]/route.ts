import { notFound, withApi } from "@/lib/api/handler";
import { captureUrls, readCapture } from "@/lib/capture";

export const dynamic = "force-dynamic";

/**
 * One capture of the caller (RLS) → `{ status, error?, image_url?, boxes_url?, ... }`. The links
 * are signed with the caller's session and exist only once the capture is ready.
 */
export const GET = withApi({}, async ({ supabase, params }) => {
  const row = await readCapture(supabase, String(params.id ?? ""));
  if (!row) throw notFound("There is no capture with that id.");
  const urls = await captureUrls(row);
  return {
    id: row.id,
    url: row.url,
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.width && row.height ? { width: row.width, height: row.height } : {}),
    ...(urls ?? {}),
    created_at: row.created_at,
  };
});
