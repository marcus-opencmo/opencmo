/**
 * Nguyên liệu media của một project editor, và URL đã ký để trình duyệt lấy nó.
 *
 * Một chỗ duy nhất biết "nguồn video của editor nằm ở đâu", vì hôm nay câu trả
 * lời đó sắp đổi: Phase 2 dùng bản PROXY 540p mà `prepare_editor()` đã upload
 * (`media_manifest.proxies[clipId]`, bucket `sources`), Phase 3.1 thêm
 * `master.mp4` cắt theo clip ở độ phân giải nguồn
 * (`media_manifest.masters[clipId]`, bucket `renders`).
 *
 * Hàm dưới đọc `masters` trước và rơi về `proxies`. Nghĩa là ngày Phase 3 chạy,
 * clip MỚI dùng master còn clip CŨ vẫn mở được bằng proxy — không có mốc nào mà
 * một nửa thư viện của người dùng ngừng mở ra được.
 *
 * Signed URL KHÔNG BAO GIỜ nằm trong `src` của JSX. Chúng hết hạn sau một giờ,
 * và `id` của một asset trong thư viện DS là hash nội dung — một URL ký lại sẽ
 * thành một asset KHÁC. URL sống ở đây và trong `ProjectFS`; `src` trong JSX
 * luôn là một đường dẫn thư viện (`assets/master.mp4`).
 */

import { signedObjectUrl, type Bucket } from "@/lib/storage";
import type { ClipContext } from "@/lib/api/clips";

import type { EditorFocus } from "@/lib/editor/generate-project";

export type MasterEntry = {
  bucket: string;
  object: string;
  /**
   * Transcript ở hình dạng native của DS, cùng gốc 0 với `object`. Chỉ master
   * mới có: proxy ra đời trước khi engine ghi file này, và job không có lời
   * nói thì cũng không có nó.
   */
  transcript?: string | null;
  width?: number;
  height?: number;
  duration?: number;
  /** Mốc của giây 0 trong file, theo thời gian VIDEO GỐC. */
  offset?: number;
  /**
   * Dãy tâm khung động worker tính sẵn (R4, `steps/reframe.py::editor_focus`).
   * Job trước R4 không có: bộ sinh project giữ khung tĩnh.
   */
  focus?: EditorFocus;
};

type ManifestWithMasters = {
  proxies?: Record<string, MasterEntry>;
  masters?: Record<string, MasterEntry>;
};

export class NoEditorSourceError extends Error {}

/**
 * Nguồn video cho editor, kèm kích thước thật.
 *
 * `width`/`height` bắt buộc phải có số: bộ sinh TSX đặt khung crop theo tỉ lệ
 * nguồn, và đoán sai tỉ lệ nghĩa là người nói bị cắt mất nửa người — hỏng im
 * lặng, đúng loại lỗi tệ nhất của dự án này. Job cũ thiếu `width` trong manifest
 * thì suy ra theo 16:9, vẫn tốt hơn chia cho không.
 */
export function editorSource(context: ClipContext, clipId: string): {
  entry: MasterEntry;
  bucket: Bucket;
  width: number;
  height: number;
  duration: number;
  offset: number;
} {
  const manifest = (context.job.media_manifest ?? {}) as ManifestWithMasters;
  const entry = manifest.masters?.[clipId] ?? manifest.proxies?.[clipId];

  if (!entry?.object) {
    throw new NoEditorSourceError(
      "This clip has no editable source yet. Process the video again to edit it.",
    );
  }

  const height = entry.height ?? 540;
  return {
    entry,
    bucket: entry.bucket as Bucket,
    width: entry.width ?? Math.round((height * 16) / 9),
    height,
    duration: entry.duration ?? 0,
    offset: entry.offset ?? 0,
  };
}

/** URL đã ký cho nguồn video. TTL mặc định của `signedObjectUrl` là một giờ. */
export async function signedSourceUrl(source: {
  bucket: Bucket;
  entry: MasterEntry;
}): Promise<string> {
  return signedObjectUrl(source.bucket, source.entry.object);
}

/**
 * URL đã ký cho transcript của master, hoặc `null` khi master không mang nó.
 *
 * `null` KHÔNG có nghĩa là clip không có phụ đề: job cũ hơn Phase 3 dựng
 * transcript từ artifact qua `GET /api/v1/editor/transcript`. Người gọi rơi về
 * route đó, và chỉ khi cả hai đều trống mới thật sự là không có phụ đề.
 */
export async function signedTranscriptUrl(source: {
  bucket: Bucket;
  entry: MasterEntry;
}): Promise<string | null> {
  if (!source.entry.transcript) return null;
  return signedObjectUrl(source.bucket, source.entry.transcript);
}
