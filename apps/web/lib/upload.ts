/**
 * Nguồn job dạng "file người dùng tự upload".
 *
 * File này CỐ Ý không import gì — cả component client lẫn server action đều
 * dùng chung nó. Đặt các hằng số này ở `storage.ts` thì không được: file đó
 * import Supabase server client, kéo theo `next/headers`, và bundle client sẽ vỡ.
 *
 * Ý chính: nguồn upload đi vào ĐÚNG cột `source_url` có sẵn, dưới dạng
 * `storage://<đường-dẫn trong bucket sources>`. Không thêm cột, không đổi payload
 * gửi sang Modal, không đụng `submit`/`sweep`. Xem UPLOAD.md quyết định 3.
 */

export const SOURCE_PREFIX = "storage://";

/**
 * Trần dung lượng phía ứng dụng.
 *
 * Trần THẬT là min(giới hạn bucket, giới hạn toàn dự án) và giới hạn toàn dự án
 * của gói Supabase Free là 50MB — nên trước khi nâng Pro, file lớn hơn 50MB sẽ
 * bị chính Supabase từ chối (HTTP 413) dù qua được kiểm tra ở đây. Đó là lý do
 * `uploadWithProgress` phải nói rõ mã lỗi ra màn hình thay vì nuốt.
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export function isSourceUpload(url: string): boolean {
  return url.startsWith(SOURCE_PREFIX);
}

/** `storage://a/b.mp4` → `a/b.mp4`. Trả chuỗi rỗng nếu không phải nguồn upload. */
export function sourceObjectPath(url: string): string {
  return isSourceUpload(url) ? url.slice(SOURCE_PREFIX.length) : "";
}

/**
 * Phần tên file an toàn để đưa vào đường dẫn storage.
 *
 * Không phải để cho đẹp: tên người dùng đặt có thể chứa `../`, dấu nháy, ký tự
 * điều khiển, hoặc dài 300 ký tự. Nhưng cũng KHÔNG vứt hẳn tên đi, vì worker
 * lấy `jobs.title` từ tên file (`steps/local.py` dùng `path.stem`) — vứt tên là
 * mọi job upload đều hiện lên với một cái tiêu đề vô nghĩa.
 *
 * `__` được dùng làm dấu ngăn với uuid ở `sourcePath()`, nên hàm này gộp mọi
 * chuỗi ký tự lạ thành MỘT dấu `-` và không bao giờ sinh ra `__`.
 */
export function slugifyFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "video";
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

/** Extension chỉ dùng làm storage key; FFprobe mới quyết định file có phải video. */
export function storageExtension(filename: string): string {
  const extension = extensionOf(filename);
  return /^[a-z0-9]{1,12}$/.test(extension) ? extension : "video";
}

/**
 * Lý do file không dùng được, hoặc null nếu ổn.
 *
 * Chạy ở CẢ hai phía: client gọi trước khi upload để người dùng biết ngay thay
 * vì chờ hết vài trăm MB rồi mới nhận lỗi; server gọi lại vì kiểm tra phía
 * client là tiện lợi, không phải là bảo mật.
 */
export function rejectReason(name: string, size: number): string | null {
  if (size <= 0) return "That file is empty.";
  if (size > MAX_UPLOAD_BYTES) {
    return `That file is ${formatBytes(size)}. The limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`;
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Nhãn hiển thị cho một `source_url`.
 *
 * Danh sách job in `job.title || job.source_url`, mà title chỉ có sau khi worker
 * probe xong. Không có hàm này thì job upload nằm ở 'queued' hiện ra một chuỗi
 * `storage://<uuid>/<uuid>.mp4` — vô nghĩa với người đọc.
 */
export function sourceLabel(url: string): string {
  return isSourceUpload(url) ? "Uploaded file" : url;
}
