"use client";

/**
 * Thẻ "đây là video bạn vừa dán" — trước khi người dùng tốn một lần bấm.
 *
 * Dán nhầm link (một playlist, một video khác trong tab) là lỗi hay gặp nhất ở
 * bước này, và trước đây nó chỉ lộ ra sau khi job đã giữ credit. Tên video và
 * kênh đến từ `/api/v1/source-preview` (oEmbed của YouTube); không lấy được thì
 * thẻ vẫn có ảnh bìa, và không có gì chặn người dùng tạo clip.
 */

import { useEffect, useState } from "react";

import { api } from "../api";
import { youtubeId } from "./YouTubePlayer";

type Preview = { title: string; author: string | null };

export function LinkPreview({
  url,
  showThumbnail,
  duration,
  endpoint = "/source-preview",
}: {
  url: string;
  /** Panel Clips của editor gọi bản dưới `/editor/clipping` (G1-b). */
  endpoint?: string;
  /** Tắt khi đã có hình khác của cùng video ngay cạnh — hai hình là thừa. */
  showThumbnail: boolean;
  duration: number | null;
}) {
  const id = youtubeId(url);
  const [preview, setPreview] = useState<{ id: string; data: Preview | null } | null>(null);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    // Chờ người dùng dán xong: gõ tay từng ký tự thì không gọi mỗi phím một lần.
    const timer = window.setTimeout(() => {
      api<Preview>(`${endpoint}?url=${encodeURIComponent(url.trim())}`, { signal: controller.signal })
        .then((data) => setPreview({ id, data }))
        .catch(() => {
          if (!controller.signal.aborted) setPreview({ id, data: null });
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [id, url, endpoint]);

  if (!id) return null;
  const data = preview?.id === id ? preview.data : undefined;

  return (
    <div className={`link-preview ${showThumbnail ? "" : "is-compact"}`} aria-live="polite">
      {showThumbnail && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`https://i.ytimg.com/vi/${id}/mqdefault.jpg`} alt="" width={160} height={90} />
      )}
      <div className="link-preview-text">
        {data === undefined ? (
          <>
            <span className="skeleton link-preview-line" />
            <span className="skeleton link-preview-line is-short" />
          </>
        ) : (
          <>
            <strong>{data?.title ?? "YouTube video"}</strong>
            <small>
              {[data?.author, duration ? formatLength(duration) : null].filter(Boolean).join(" · ") ||
                "Ready to clip"}
            </small>
          </>
        )}
      </div>
    </div>
  );
}

export function formatLength(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
