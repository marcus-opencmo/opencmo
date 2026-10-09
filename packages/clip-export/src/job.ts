/**
 * Việc xuất một clip: đủ để chạy mà không cần mạng. Worker (Python) tải mọi
 * nguồn về đĩa rồi ghi file này; exporter chỉ đọc đĩa.
 */

import { validate, type ClipDocument } from '@opencmo/clip-doc';
import { z } from 'zod';

export const JobSchema = z
  .object({
    /**
     * Document của revision cần xuất. Bắt buộc từ R3: worker luôn gửi
     * `revision.document` (C3), không còn job nào mang `index.tsx`.
     */
    document: z.unknown().refine((value) => value !== undefined, 'job needs a document'),
    /** File trên đĩa của từng nguồn ảnh/video/âm thanh, theo `src` như trong document. */
    media: z.array(z.object({ src: z.unknown(), file: z.string().min(1) }).strict()).default([]),
    /** Transcript của `<captions src>`: file JSON `[{ words: [{ text, start, end }] }]`. */
    transcripts: z.array(z.object({ src: z.string(), file: z.string().min(1) }).strict()).default([]),
    /** Thư mục chứa font của editor (`FONTS[*].file`) — `packages/clip-media/fonts`. */
    fonts: z.string().min(1),
    /**
     * Thư mục bộ Lottie có sẵn (`builtin:<tên>`) — `packages/clip-media/lottie`.
     * Bắt buộc, không suy từ `fonts`: dời một bên mà quên bên kia thì Lottie rỗng
     * mà không lỗi nào báo.
     */
    lottie: z.string().min(1),
    out: z.string().min(1),
    /** Cạnh ngắn của bản xuất, như nút 720p/1080p của editor. */
    resolution: z.union([z.literal(720), z.literal(1080)]).default(1080),
    scene: z.union([z.number().int().min(0), z.string()]).optional(),
    /** Filter ffmpeg đặt lên hình trước khi mã hoá (watermark bản free). */
    videoFilter: z.string().optional(),
    crf: z.number().int().min(0).max(51).default(18),
    /** Số đoạn vẽ song song; mặc định theo số lõi, tối đa 4 (giữ RAM < 2 GB). */
    parallel: z.number().int().min(1).max(8).optional(),
  })
  .strict();

export type Job = z.infer<typeof JobSchema>;

/**
 * Khoá so khớp `src`: chuỗi giữ nguyên; khai báo asset (`{ generate, … }`) thành
 * JSON với khoá sắp xếp, nên thứ tự khoá worker ghi không quan trọng.
 */
export function sourceKey(src: unknown): string {
  if (typeof src === 'string') return src;
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
          )
        : value;
  return JSON.stringify(canonical(src));
}

/** Document cần xuất, đã kiểm bằng CÙNG `validate()` với server. */
export const jobDocument = (job: Job): ClipDocument => validate(job.document);
