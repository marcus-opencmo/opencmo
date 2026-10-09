/**
 * Kiểm nguồn của một job trước khi nó tới database.
 *
 * Tách khỏi route để `source.check.ts` chạy được từng ca: đây là chốt chặn
 * SSRF và chốt chặn "job trỏ vào file của người khác", hai thứ không được phép
 * sai lặng lẽ.
 */

export function sourceProblem(source: string, userId: string): string | null {
  if (source.startsWith("storage://")) {
    // ĐÂY là chỗ chặn quan trọng nhất của cả tính năng (chép từ
    // `app/app/actions.ts`): chuỗi `storage://...` do client gửi lên. Không
    // kiểm chủ sở hữu thì bất kỳ ai cũng tạo được job trỏ vào file của người
    // khác, và worker — chạy bằng service role, đi vòng qua RLS — sẽ vui vẻ
    // tải nó về và cắt thành clip cho họ.
    // Đúng HAI segment: `<uid>/../../ai-do/x.mp4` cũng bắt đầu bằng uid hợp lệ.
    const segments = source.slice("storage://".length).split("/");
    if (segments.length !== 2 || segments[0] !== userId || segments[1].includes("..")) {
      return "That upload is no longer available. Please try again.";
    }
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    return "The link must start with https://";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return "Paste a public HTTP or HTTPS video link.";
  }
  if (parsed.username || parsed.password) {
    return "Paste a public HTTP or HTTPS video link without a username or password.";
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return "This link points to a private or local network. Use a public video URL.";
  }
  if (isVimeoHost(host)) return VIMEO_UNSUPPORTED;
  return null;
}

/**
 * Vimeo mã hoá luồng video bằng DRM (`drm/cbcs` trong playlist): yt-dlp đọc được
 * metadata qua player nhúng nhưng ffmpeg không giải được đoạn nào, còn trang
 * vimeo.com thì đòi đăng nhập. Chặn ở đây để không giữ credit cho một job chắc
 * chắn hỏng (UAT production 29/09).
 */
export const VIMEO_UNSUPPORTED =
  "Vimeo links can't be imported. Download the video from Vimeo and upload the file instead.";

export const isVimeoHost = (host: string) => host === "vimeo.com" || host.endsWith(".vimeo.com");
