"use client";

/**
 * Upload resumable thẳng từ trình duyệt lên Supabase Storage.
 *
 * Vì sao không dùng signed upload URL như đường cũ: một lượt PUT duy nhất mất
 * cả file khi mạng rớt ở phút thứ tám của một video 2GB — và người dùng ở quán
 * cà phê thì rớt mạng là chuyện thường. TUS chia file thành khối 6MB, nhớ vị
 * trí, và nối lại từ đúng chỗ đứt.
 *
 * Ba con số dưới đây là YÊU CẦU của Supabase, không phải lựa chọn:
 *   - `chunkSize` phải ĐÚNG 6MB. Số khác bị server từ chối.
 *   - `uploadDataDuringCreation: false` — Supabase dùng giao thức TUS creation
 *     rồi PATCH, không nhận dữ liệu trong POST tạo upload.
 *   - metadata cần `bucketName` và `objectName`; `objectName` KHÔNG gồm bucket.
 */

import * as tus from "tus-js-client";

import { createClient } from "./supabase/client";

export const CHUNK_SIZE = 6 * 1024 * 1024;

export type UploadHandle = {
  promise: Promise<void>;
  abort: () => void;
};

function endpoint(): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("Uploads are not configured. Try again later.");
  return `${base.replace(/\/$/, "")}/storage/v1/upload/resumable`;
}

export function uploadResumable({
  bucket,
  objectName,
  file,
  onProgress,
}: {
  bucket: string;
  objectName: string;
  file: File;
  onProgress?: (fraction: number) => void;
}): UploadHandle {
  const supabase = createClient();
  let upload: tus.Upload | null = null;
  let aborted = false;

  const promise = new Promise<void>((resolve, reject) => {
    void (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        reject(new Error("Please sign in again."));
        return;
      }
      if (aborted) {
        reject(new Error("Upload cancelled. Nothing was submitted."));
        return;
      }

      upload = new tus.Upload(file, {
        endpoint: endpoint(),
        chunkSize: CHUNK_SIZE,
        // Nối lại sau khi đóng tab: fingerprint mặc định của thư viện gắn với
        // tên + kích thước file, đúng thứ ta cần.
        removeFingerprintOnSuccess: true,
        retryDelays: [0, 3000, 5000, 10000, 20000],
        uploadDataDuringCreation: false,
        headers: {
          "x-upsert": "false",
        },
        metadata: {
          bucketName: bucket,
          objectName,
          // Bucket chỉ nhận video/*; MIME do trình duyệt suy đoán không đáng
          // tin với container lạ. Worker FFprobe byte thật trước khi dùng.
          contentType: "video/x-upload",
          cacheControl: "3600",
        },
        /**
         * Access token sống một giờ; upload 2GB trên mạng nhà thì lâu hơn thế.
         * Chỉ đặt authorization tại đây, trước MỖI request. Nếu vừa truyền qua
         * `headers` vừa set lại ở hook này, tus-js-client nối hai giá trị thành
         * `Bearer …, Bearer …` và Storage từ chối JWS đó với 403.
         * `getSession()` tự làm mới token khi hết hạn.
         */
        onBeforeRequest: async (req) => {
          const { data } = await supabase.auth.getSession();
          if (data.session) {
            req.setHeader("authorization", `Bearer ${data.session.access_token}`);
          }
        },
        onProgress: (sent, total) => {
          if (total > 0) onProgress?.(sent / total);
        },
        onSuccess: () => resolve(),
        onError: (error) => {
          // Message của thư viện mang chi tiết HTTP; giữ lại một câu đọc được.
          console.error("[upload] TUS lỗi", error);
          reject(new Error("Upload failed. Check your connection and try again."));
        },
      });

      const previous = await upload.findPreviousUploads();
      if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    })();
  });

  return {
    promise,
    abort: () => {
      aborted = true;
      void upload?.abort(true);
    },
  };
}
