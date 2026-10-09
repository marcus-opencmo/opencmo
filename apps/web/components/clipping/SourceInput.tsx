"use client";

import { useRef } from "react";

import { isVimeoHost, VIMEO_UNSUPPORTED } from "@/lib/api/source";

export type SourceMode = "upload" | "link";

export function validateVideoFile(file: File, maxBytes: number): string | null {
  if (file.size <= 0) return "This file is empty.";
  if (file.size > maxBytes) {
    return `Videos must be smaller than ${Math.round(maxBytes / 1024 ** 3)} GB.`;
  }
  return null;
}

/**
 * Nhận diện link trước khi gửi. Cùng danh sách host với `resolve_source` ở
 * `packages/engine/opencmo/local_api.py` — server vẫn là chốt chặn thật.
 */
export function linkProvider(
  value: string,
):
  | { kind: "empty" | "invalid" }
  | { kind: "unsupported"; message: string }
  | { kind: "supported"; name: string } {
  const text = value.trim();
  if (!text) return { kind: "empty" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { kind: "invalid" };
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    return { kind: "invalid" };
  }
  const host = url.hostname.toLowerCase();
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
    return { kind: "supported", name: "YouTube" };
  }
  if (isVimeoHost(host)) return { kind: "unsupported", message: VIMEO_UNSUPPORTED };
  return { kind: "supported", name: "Public video" };
}

export function SourceInput({
  mode,
  file,
  url,
  busy,
  progress,
  maxBytes,
  onMode,
  onFile,
  onUrl,
  onCancelUpload,
}: {
  mode: SourceMode;
  file: File | null;
  url: string;
  busy: boolean;
  progress: number | null;
  maxBytes: number;
  onMode: (mode: SourceMode) => void;
  onFile: (file: File | null) => void;
  onUrl: (url: string) => void;
  onCancelUpload: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const provider = linkProvider(url);

  return (
    <>
      {mode === "upload" ? (
        <div
          className="video-drop"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (!busy) onFile(event.dataTransfer.files[0] || null);
          }}
        >
          <div className="film-mark" aria-hidden="true">
            ▤
          </div>
          <h2>{file ? file.name : "Start with your long-form video"}</h2>
          {file && <p>{(file.size / 1024 / 1024).toFixed(1)} MB</p>}
          <input
            ref={input}
            type="file"
            aria-label="Video file"
            hidden
            onChange={(event) => {
              onFile(event.target.files?.[0] || null);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {file ? "Choose another video" : "Choose video"}
          </button>
          <small>Any video format · up to {Math.round(maxBytes / 1024 ** 3)} GB</small>
        </div>
      ) : (
        <div className="link-entry">
          <label htmlFor="video-url">Paste a public video link</label>
          <input
            id="video-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            autoFocus
            disabled={busy}
            placeholder="https://example.com/video"
            value={url}
            aria-describedby="video-url-hint"
            onChange={(event) => onUrl(event.target.value)}
          />
          <p id="video-url-hint" className={`link-hint ${provider.kind}`}>
            {provider.kind === "supported" && `${provider.name} link`}
            {provider.kind === "empty" && "YouTube, TikTok, X, or any public video URL"}
            {provider.kind === "unsupported" && provider.message}
            {provider.kind === "invalid" && "Paste the full public link, starting with http:// or https://."}
          </p>
        </div>
      )}

      {/*
        Upload tụt xuống một dòng chữ: storage tốn tiền thật mỗi tháng, còn một
        link thì không tốn byte nào cho tới lúc worker tải đúng đoạn đã chọn.
        Nó vẫn phải ở đây — YouTube chặn IP datacenter, và đây là đường vòng.
      */}
      <p className="source-switch">
        {mode === "link" ? (
          <button type="button" disabled={busy} onClick={() => onMode("upload")}>
            Upload a video file instead
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => onMode("link")}>
            Paste a link instead
          </button>
        )}
      </p>

      {progress !== null && (
        <div className="upload-state">
          <progress max="100" value={progress} aria-label="Upload progress" />
          <span>{progress}%</span>
          <button type="button" onClick={onCancelUpload}>
            Cancel upload
          </button>
        </div>
      )}
    </>
  );
}
