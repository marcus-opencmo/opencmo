/**
 * Thư viện media trong trình duyệt (spec editor-rewrite B5): bytes, đo, tải lên.
 *
 * Manifest (dữ liệu) là của `@opencmo/clip-assets` và đi trong session cùng
 * document; ở đây là phần CHẠM RA NGOÀI:
 *
 * - **OPFS** (hoặc IndexedDB khi trình duyệt không ghi được OPFS — `./local.ts`),
 *   cùng bố cục với fork (`projects/<clip>/<source>`), cùng origin. Đây là bộ
 *   nhớ đệm: trình duyệt có thể dọn nó.
 * - **Storage**: B-roll đi `POST /uploads` → TUS → `POST /projects/[id]/media`,
 *   đường sẵn có của app. Kết quả ghi lên record (`cloud`), nên máy khác tải
 *   được bytes về qua `mediaId`. Video và ảnh lên Storage; âm thanh chỉ sống trên
 *   máy đã nhập nó (`uploadable`).
 */

import {
  ASSETS_DIR,
  contentId,
  joinPath,
  lottieInfo,
  LUT_MIME,
  stemOf,
  typeOfMime,
  type AssetRecord,
  type AssetType,
  type LibraryRecord,
} from "@opencmo/clip-assets";
import { parseCube, readTranscriptText, subtitleMime } from "@opencmo/clip-render";

import { uploadResumable } from "@/lib/upload-tus";

import { readLocal, removeLocal, writeLocal } from "./local";

// ------------------------------------------------------------------ bytes trên máy

export { readLocal, removeLocal };

// ------------------------------------------------------------------ đo file

async function probe(file: File, type: AssetType, mime: string): Promise<Partial<AssetRecord>> {
  if (type === "LOTTIE") {
    const info = lottieInfo(await file.text());
    if (!info) throw new Error(`${file.name} is not a Lottie animation.`);
    return info;
  }
  if (type === "LUT") {
    // Đọc thử ngay lúc nhập (E3-c): LUT hỏng bị từ chối ở đây, không thành màu sai lúc export.
    const cube = parseCube(await file.text());
    return { width: cube.size, height: cube.size };
  }
  if (type === "TRANSCRIPT") {
    // Đọc thử ngay lúc nhập: file hỏng bị từ chối ở đây chứ không thành một lớp
    // phụ đề trống trên canvas.
    const transcript = readTranscriptText(await file.text(), mime);
    const end = Math.max(0, ...transcript.flatMap((segment) => segment.words.map((word) => word.end)));
    if (!end) throw new Error(`${file.name} has no captions.`);
    return { duration: Math.round(end * 1000) / 1000 };
  }
  if (type === "IMAGE") {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }
  const url = URL.createObjectURL(file);
  try {
    const el = document.createElement(type === "VIDEO" ? "video" : "audio");
    el.preload = "metadata";
    el.src = url;
    await new Promise<void>((resolve, reject) => {
      el.addEventListener("loadedmetadata", () => resolve(), { once: true });
      el.addEventListener("error", () => reject(new Error(`${file.name} could not be read.`)), { once: true });
    });
    const duration = Number.isFinite(el.duration) ? Math.round(el.duration * 1000) / 1000 : undefined;
    if (el instanceof HTMLVideoElement) return { width: el.videoWidth, height: el.videoHeight, duration };
    return { duration };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Record cho một file người dùng thả vào: id theo nội dung, `path` trong thư
 * mục đang mở, bytes ở `assets/<path>`. Chưa thêm vào manifest — người gọi
 * làm (và `addAsset` sửa `path` cho khỏi trùng).
 */
export async function describe(file: File, folder: string): Promise<AssetRecord> {
  const mime = /\.cube$/i.test(file.name) ? LUT_MIME : (subtitleMime(file.name, file.type) ?? file.type);
  let type: AssetType | null = typeOfMime(mime);
  if (!type) throw new Error(`${file.name} is not a video, image, audio, caption, Lottie or .cube LUT file.`);
  // `.json` là transcript HOẶC Lottie — cùng MIME, phân biệt bằng nội dung.
  if (mime === "application/json" && lottieInfo(await file.text())) type = "LOTTIE";
  const path = joinPath(folder, file.name.replace(/\//g, "-"));
  return {
    id: await contentId(file),
    path,
    source: joinPath(ASSETS_DIR, path),
    type,
    mimeType: mime,
    createdAt: new Date().toISOString(),
    ...(await probe(file, type, mime)),
    ...(uploadable(type) ? { cloud: { state: "uploading" as const } } : {}),
  };
}

/**
 * Video, ảnh, LUT `.cube` và Lottie `.json` lên Storage (`probe_media` nhận ảnh từ P2-b, LUT từ
 * E3-c, Lottie từ G4 — export trên server cần đọc chúng; Lottie trước đó chỉ nằm ở máy nên Export
 * báo "only saved on the device"). Ảnh làm
 * frame đầu/cuối hay tham chiếu cho Generate phải có bản trên server. Âm thanh vẫn chỉ
 * ở máy — probe từ chối, tải lên chỉ để nhận `rejected`.
 */
export const uploadable = (type: string) => type === "VIDEO" || type === "IMAGE" || type === "LUT" || type === "LOTTIE";

/** Ghi bytes vào OPFS theo `source` của record (sau khi `path` đã chốt). */
export const keepLocal = (clipId: string, record: AssetRecord, file: File) => writeLocal(clipId, record.source, file);

// ------------------------------------------------------------------ Storage

type Reservation = { bucket: string; objectName: string };

async function json<T>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => null)) as ({ detail?: unknown } & T) | null;
  if (!response.ok) throw new Error(typeof body?.detail === "string" ? body.detail : fallback);
  return body as T;
}

/**
 * Đẩy bytes lên bucket `media` và đăng ký chúng với project. Trả `mediaId`.
 * `onProgress` nhận 0–1.
 */
export async function upload(projectId: string, file: File, onProgress?: (fraction: number) => void): Promise<string> {
  const reservation = await json<Reservation>(
    await fetch("/api/v1/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: file.name, size: file.size, kind: "media", project_id: projectId }),
    }),
    "Could not start the upload.",
  );
  await uploadResumable({ bucket: reservation.bucket, objectName: reservation.objectName, file, onProgress }).promise;
  const registered = await json<{ id: string }>(
    await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/media`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectName: reservation.objectName, name: file.name, request_id: crypto.randomUUID() }),
    }),
    "Could not save this file to the project.",
  );
  return registered.id;
}

/** Xoá bản trên Storage; 404 là đã không còn — đúng điều muốn. */
export async function deleteRemote(projectId: string, mediaId: string): Promise<void> {
  const response = await fetch(
    `/api/v1/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}`,
    { method: "DELETE" },
  ).catch(() => null);
  if (response && !response.ok && response.status !== 404) {
    console.warn("[library] could not delete the stored copy", mediaId, response.status);
  }
}

// ------------------------------------------------------------------ chèn vào clip


export { nodeFor } from "@/lib/editor/asset-node";
