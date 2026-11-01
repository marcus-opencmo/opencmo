import { NextResponse } from "next/server";

import { notFound, withApi } from "@/lib/api/handler";
import { captureUrls, readCapture } from "@/lib/capture";

export const dynamic = "force-dynamic";

/**
 * The screenshot of a ready capture → 303 to a signed URL (`?resolve=1` → `{ url }`). The editor
 * opens `capture:<id>` image sources through here, like `brand:` logos: the id comes from a
 * document, so it is read under the caller's RLS and another user's capture is a 404.
 */
export const GET = withApi({}, async ({ request, supabase, params }) => {
  const row = await readCapture(supabase, String(params.id ?? ""));
  const urls = row ? await captureUrls(row) : null;
  if (!urls) throw notFound("This capture is not ready.");
  return new URL(request.url).searchParams.get("resolve") === "1" ? { url: urls.image_url } : NextResponse.redirect(urls.image_url, 303);
});
