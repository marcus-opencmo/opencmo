"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/icons";
import type { ProjectClip, TranscriptSegment } from "@/lib/clipping-types";
import { api, type ApiFn } from "./api";
import { outputBadge } from "./clip-presentation";

export function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

/**
 * Chỉ gắn `src` khi thẻ video sắp vào màn hình. Mười clip mở cùng lúc là mười
 * request Range tới worker local ngay khi vào trang, dù người dùng chưa cuộn tới.
 */
function LazyPreview({
  clip,
  aspect,
}: {
  clip: ProjectClip;
  aspect: ProjectClip["preview_aspect"];
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [clip.preview_url]);

  useEffect(() => {
    const node = ref.current;
    if (!node || visible) return;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  if (!clip.available || failed) {
    return (
      <div
        className="clip-missing"
        aria-label="Preview unavailable"
        style={{ aspectRatio: aspect?.replace(":", " / ") }}
      >
        <span>{clip.available ? "Preview couldn’t load" : "Clip temporarily unavailable"}</span>
        {clip.available && <button type="button" className="secondary-button" onClick={() => setFailed(false)}>Retry preview</button>}
      </div>
    );
  }

  return (
    <div className="clip-frame" style={{ aspectRatio: aspect?.replace(":", " / ") }}>
      <video
        ref={ref}
        controls
        playsInline
        preload="metadata"
        src={visible ? clip.preview_url : undefined}
        aria-label={`Preview clip ${clip.index + 1}`}
        onError={() => {
          if (visible) setFailed(true);
        }}
      />
      {/* Khung này là bản 640px. Không nói ra thì người dùng nhìn nó rồi kết
          luận chất lượng sản phẩm — hiểu nhầm đắt nhất của màn này. */}
      <span className="preview-tag">
        {outputBadge(
          aspect ?? "9:16",
          clip.preview_width,
          clip.preview_height,
          Boolean(clip.export_url),
        )}
      </span>
    </div>
  );
}

export function ClipResultRow({
  clip,
  href,
  selected,
  focused,
  onSelect,
  onFocus,
  onEdit,
  transcript,
  transcriptLoading = false,
  hasTranscript = false,
  apiFn = api,
}: {
  clip: ProjectClip;
  href: string;
  selected: boolean;
  focused: boolean;
  onSelect: (selected: boolean) => void;
  onFocus: () => void;
  /** Không truyền khi project chưa có transcript — không có nút dẫn vào ngõ cụt. */
  onEdit?: () => void;
  transcript?: TranscriptSegment[];
  transcriptLoading?: boolean;
  hasTranscript?: boolean;
  /** Injectable để test component. */
  apiFn?: ApiFn;
}) {
  const ref = useRef<HTMLElement>(null);
  const downloading = useRef(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // Transcript gập mặc định: hook + lý do đủ để quyết định giữ clip hay không;
  // ai cần soát từng câu thì mở ra.
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  async function downloadOriginal(event: React.MouseEvent<HTMLAnchorElement>) {
    if (!clip.id) return;
    event.preventDefault();
    if (downloading.current) return;
    downloading.current = true;
    setDownloadBusy(true);
    setDownloadError(null);
    try {
      const result = await apiFn<{ url: string }>(`/clips/${encodeURIComponent(clip.id)}/file?resolve=1`);
      if (!result.url) throw new Error("Could not prepare this download. Please try again.");
      window.location.assign(result.url);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "Could not download this clip. Please try again.");
    } finally {
      downloading.current = false;
      setDownloadBusy(false);
    }
  }

  const label = clip.moment.hook || `Clip ${clip.index + 1}`;
  const duration = clip.moment.end - clip.moment.start;

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);

  return (
    <article
      ref={ref}
      id={clip.id ? `clip-${clip.id}` : undefined}
      className={`local-clip ${focused ? "is-focused" : ""}`}
      aria-current={focused ? "true" : undefined}
    >
      <LazyPreview clip={clip} aspect={clip.preview_aspect} />
      <div className="clip-copy">
        <div className="clip-meta">
          {clip.id && clip.available && (
            <input
              type="checkbox"
              className="clip-select"
              checked={selected}
              aria-label={`Select “${label}”`}
              onChange={(event) => onSelect(event.target.checked)}
            />
          )}
          <span className="clip-time">
            {clock(clip.moment.start)} – {clock(clip.moment.end)} · {Math.round(duration)} sec
          </span>
          {clip.moment.score > 0 && (
            <span className="clip-score" title="How likely this moment is to hold attention, from 0 to 99">
              Score <b>{Math.round(clip.moment.score)}</b>
            </span>
          )}
        </div>
        <h3>
          {clip.id ? (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                onFocus();
              }}
            >
              {label}
            </a>
          ) : (
            label
          )}
        </h3>
        {clip.moment.reason && <p className="clip-why">{clip.moment.reason}</p>}
        {hasTranscript && (
          <button
            type="button"
            className="text-button clip-transcript-toggle"
            aria-expanded={transcriptOpen}
            onClick={() => setTranscriptOpen((open) => !open)}
          >
            {transcriptOpen ? "Hide transcript" : "Show transcript"}
          </button>
        )}
        {hasTranscript && transcriptOpen && (
          <section
            className="clip-transcript"
            role="region"
            aria-label={`Transcript for clip ${clip.index + 1}`}
          >
            <h4>Transcript</h4>
            {transcriptLoading ? (
              // Ba dòng giữ chỗ thay vì một câu "Loading…" lặp lại ở mọi clip.
              <div className="transcript-skeleton" aria-label="Loading transcript">
                <span className="skeleton" />
                <span className="skeleton" />
                <span className="skeleton is-short" />
              </div>
            ) : transcript?.length ? (
              <ol>
                {transcript.map((segment) => (
                  <li key={`${segment.start}-${segment.end}`}>
                    <time>{clock(Math.max(0, segment.start - clip.moment.start))}</time>
                    <span>{segment.text}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p>No transcript in this clip.</p>
            )}
          </section>
        )}
        {downloadError && <p role="alert">{downloadError} Click Download again to retry.</p>}
        {!clip.available && (
          <p className="clip-missing-note">
            This clip is currently unavailable. Refresh the project to check again.
          </p>
        )}
      </div>
      {/* Cột hành động dựng dọc theo OPUSCLIP.md §3.3. Thứ tự là tải trước, sửa
          sau; chỗ trên cùng để trống cho "Publish" của v2 nên lúc đó không phải
          xếp lại cả cột. */}
      {clip.available && (
        <div className="clip-actions">
          {/* Đã export thì bản đã chỉnh là thứ người dùng muốn tải, không phải
              bản AI dựng lần đầu. Bản gốc vẫn còn ngay bên dưới. */}
          {clip.export_url ? (
            <>
              <a className="primary-button" href={clip.export_url}>
                <Icon name="download" size={16} />
                Download edit {clip.export_revision}
              </a>
              {/* Bản gốc là lựa chọn phụ: một link chữ, không phải nút ngang hàng. */}
              <a
                className="text-button download-original"
                href={clip.download_url}
                onClick={(event) => void downloadOriginal(event)}
                aria-disabled={downloadBusy}
              >
                {downloadBusy ? "Preparing download…" : "Download original"}
              </a>
            </>
          ) : (
            <a
              className="primary-button"
              href={clip.download_url}
              onClick={(event) => void downloadOriginal(event)}
              aria-disabled={downloadBusy}
            >
              <Icon name="download" size={16} />
              {downloadBusy ? "Preparing download…" : "Download clip"}
            </a>
          )}
          {clip.id && onEdit && (
            <button type="button" className="secondary-button" onClick={onEdit}>
              <Icon name="scissors" size={16} />
              Edit clip
            </button>
          )}
        </div>
      )}
    </article>
  );
}
