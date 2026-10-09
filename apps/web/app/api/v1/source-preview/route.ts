import { ApiError, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

/** Cùng danh sách host YouTube với `linkProvider` ở `SourceInput.tsx`. */
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);

type Preview = { title: string; author: string | null; thumbnail: string | null };

/**
 * Tên video và kênh cho thẻ xem trước ở màn New clips.
 *
 * Chỉ YouTube, và chỉ gọi đúng endpoint oEmbed của YouTube với link người dùng
 * dán: route này KHÔNG được thành một proxy fetch URL tuỳ ý (SSRF). Không đụng
 * database, không tốn credit — hỏng thì màn tạo chỉ mất dòng tên, vẫn tạo được.
 */
export const GET = withApi({}, async ({ request }) => {
  const raw = request.nextUrl.searchParams.get("url") ?? "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, "Paste a full YouTube link.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ApiError(400, "Paste a full YouTube link.");
  }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new ApiError(400, "Previews are only available for YouTube links.");
  }

  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.searchParams.set("url", url.toString());
  endpoint.searchParams.set("format", "json");

  let response: Response;
  try {
    response = await fetch(endpoint, { signal: AbortSignal.timeout(4000), cache: "no-store" });
  } catch {
    throw new ApiError(502, "Could not reach YouTube. You can still create clips.");
  }
  if (!response.ok) {
    // 401/404 của oEmbed: video riêng tư, bị chặn nhúng hoặc không tồn tại.
    throw new ApiError(404, "This video isn't public, or it doesn't exist.");
  }
  const data = (await response.json().catch(() => null)) as {
    title?: unknown;
    author_name?: unknown;
    thumbnail_url?: unknown;
  } | null;
  if (!data || typeof data.title !== "string") {
    throw new ApiError(502, "Could not read this video's details.");
  }

  const preview: Preview = {
    title: data.title.slice(0, 300),
    author: typeof data.author_name === "string" ? data.author_name.slice(0, 200) : null,
    thumbnail: typeof data.thumbnail_url === "string" ? data.thumbnail_url : null,
  };
  return preview;
});
