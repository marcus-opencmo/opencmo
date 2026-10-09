"use client";

/**
 * Tab Clips của editor (G1-c, Marcus 04/10): cắt clip từ video dài là MỘT TÍNH NĂNG của
 * editor, không còn trang `/app/video` riêng. Mỗi clip vẫn là một bản sửa riêng — nút Open
 * mở nó ở `/app/editor/<clip>`.
 *
 * Upload là đường chính. Dán link nằm sau "Use a link instead" và phải tick "Is this your
 * video?" (luật 3; `create_clip_job` là chốt thật). Không có "Don't clip": link + tải nguyên
 * video là đúng hình một content downloader — API vẫn nhận `mode: "full"` cho upload.
 *
 * File không đi qua Next.js: xin chỗ ghi (`/uploads`), đẩy TUS thẳng lên Storage, rồi mới tạo
 * job — tạo job trước là để worker nhặt một job trỏ vào file chưa tồn tại.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { ClippingJob } from "@/app/api/v1/editor/clipping/route";
import { api, jsonBody } from "@/components/clipping/api";
import { stageLabel } from "@/components/clipping/ProcessingView";
import { linkProvider, validateVideoFile } from "@/components/clipping/SourceInput";
import { useLive } from "@/components/clipping/useLive";
import { LinkPreview } from "@/components/clipping/web/LinkPreview";
import { useShellAccount } from "@/components/clipping/web/WebShell";
import { youtubeId } from "@/components/clipping/web/YouTubePlayer";
import { CLIP_COUNTS, CLIP_LENGTH_OPTIONS } from "@/lib/clip-options";
import type { AspectRatio, ClipLength } from "@/lib/clipping-types";
import { CREDITS_PER_MINUTE, JOB_HOLD_CREDITS } from "@/lib/credits";
import { MAX_UPLOAD_BYTES } from "@/lib/upload";
import { uploadResumable, type UploadHandle } from "@/lib/upload-tus";

type Granted = { bucket: string; objectName: string; source: string | null };
// Chỉ bật/tắt (R4): kiểu phụ đề chọn trong editor, bằng đúng bộ preset của editor.
type Captions = "on" | "off";

/** Điền sẵn từ link cũ (`/app/video?url=…`, nút "Try again with longer clips"). */
export type ClipsPrefill = { url?: string; count?: number; length?: ClipLength };

const ASPECTS: AspectRatio[] = ["9:16", "1:1", "16:9"];
const CAPTIONS: { value: Captions; label: string }[] = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];
const TERMINAL = new Set(["done", "failed", "cancelled"]);

// Chỉ nhớ "gu" (số clip, độ dài, phụ đề). Khung lấy theo bản đang mở mỗi lần.
const PREFS_KEY = "opencmo.clips.v1";
function readPrefs(): { count?: number; length?: ClipLength; captions?: Captions } {
  try {
    const data = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}") as Record<string, unknown>;
    return {
      count: CLIP_COUNTS.includes(Number(data.count)) ? Number(data.count) : undefined,
      length: CLIP_LENGTH_OPTIONS.find((option) => option.value === data.length)?.value,
      // Bản lưu cũ ghi tên kiểu ("bold"…): mọi giá trị khác "off" là đang bật.
      captions: data.captions === undefined ? undefined : data.captions === "off" ? "off" : "on",
    };
  } catch {
    return {};
  }
}

/** Độ dài file đọc từ metadata ở trình duyệt — chỉ để báo giá trước khi bấm. */
function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => done(null);
    video.src = url;
  });
}

export function aspectOf(width: number, height: number): AspectRatio {
  const ratio = width / height;
  return ratio > 1.3 ? "16:9" : ratio > 0.8 ? "1:1" : "9:16";
}

export function ClipsPanel({
  frame,
  prefill,
  onOpen,
}: {
  frame: AspectRatio;
  prefill?: ClipsPrefill | null;
  onOpen: (clipId: string) => void;
}) {
  const { credits, userId, refreshAccount } = useShellAccount();
  const [linkMode, setLinkMode] = useState(Boolean(prefill?.url));
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [url, setUrl] = useState(prefill?.url ?? "");
  const [mine, setMine] = useState(false);
  const [count, setCount] = useState(prefill?.count ?? 3);
  const [length, setLength] = useState<ClipLength>(prefill?.length ?? "auto");
  const [aspect, setAspect] = useState<AspectRatio>(frame);
  const [captions, setCaptions] = useState<Captions>("on");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ClippingJob[] | null>(null);
  const upload = useRef<UploadHandle | null>(null);
  const uploaded = useRef<{ file: File; source: string } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const prefsLoaded = useRef(false);

  useLayoutEffect(() => {
    const prefs = readPrefs();
    if (prefill?.count === undefined && prefs.count) setCount(prefs.count);
    if (prefill?.length === undefined && prefs.length) setLength(prefs.length);
    if (prefs.captions) setCaptions(prefs.captions);
    prefsLoaded.current = true;
    // Một lần khi mount; giá trị điền sẵn đã nằm trong state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!prefsLoaded.current) return;
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({ count, length, captions }));
    } catch {
      // Storage bị chặn: lần sau về mặc định.
    }
  }, [count, length, captions]);
  // Khung của bản đang mở tới sau lần vẽ đầu (renderer dựng xong) và đổi theo FrameBar.
  useEffect(() => setAspect(frame), [frame]);
  // "Try again with longer clips" điền lại khi panel đang mở.
  useEffect(() => {
    if (!prefill) return;
    if (prefill.url !== undefined) {
      setLinkMode(true);
      setUrl(prefill.url);
      setMine(false);
    }
    if (prefill.count) setCount(prefill.count);
    if (prefill.length) setLength(prefill.length);
  }, [prefill]);

  const load = useCallback(async () => {
    try {
      const { items } = await api<{ items: ClippingJob[] }>("/editor/clipping");
      setJobs(items);
    } catch {
      setJobs((current) => current ?? []);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const running = (jobs ?? []).some((job) => !TERMINAL.has(job.status));
  useLive("jobs", userId && `user_id=eq.${userId}`, () => void load(), Boolean(userId), running, "editor-clips");

  function pickFile(next: File | null) {
    if (busy) return;
    setError(null);
    uploaded.current = null;
    setDuration(null);
    const problem = next ? validateVideoFile(next, MAX_UPLOAD_BYTES) : null;
    if (problem) setError(problem);
    setFile(problem ? null : next);
    if (next && !problem) void probeDuration(next).then(setDuration);
  }

  async function sendFile(video: File): Promise<string> {
    const granted = await api<Granted>("/uploads", jsonBody({ name: video.name, size: video.size, kind: "source" }));
    setProgress(0);
    const handle = uploadResumable({
      bucket: granted.bucket,
      objectName: granted.objectName,
      file: video,
      onProgress: (fraction) => setProgress(Math.round(fraction * 100)),
    });
    upload.current = handle;
    await handle.promise;
    upload.current = null;
    if (!granted.source) throw new Error("Upload failed. Please try again.");
    return granted.source;
  }

  const provider = linkProvider(url);
  const ready = linkMode ? provider.kind === "supported" && mine : Boolean(file);
  const needsPlan = credits !== null && credits < JOB_HOLD_CREDITS;
  const estimate = !linkMode && duration ? Math.max(1, Math.ceil(duration / 60)) * CREDITS_PER_MINUTE : null;
  const short = estimate !== null && credits !== null && estimate > credits;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      let source = url.trim();
      if (!linkMode) {
        source = uploaded.current?.file === file ? uploaded.current.source : await sendFile(file!);
        uploaded.current = { file: file!, source };
      } else if (provider.kind !== "supported") {
        throw new Error(provider.kind === "unsupported" ? provider.message : "Paste a public video link, or upload the file instead.");
      }
      setProgress(null);
      await api("/editor/clipping", jsonBody({
        source,
        clips: count,
        clip_length: length,
        aspect,
        layout: "auto",
        captions: captions === "on",
        ownership_confirmed: linkMode ? mine : false,
      }));
      uploaded.current = null;
      setFile(null);
      setDuration(null);
      setUrl("");
      setMine(false);
      refreshAccount();
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not start. Please try again.");
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }

  function retryLonger(job: ClippingJob) {
    setLength("long");
    setCount(job.clips_requested);
    if (/^https?:\/\//i.test(job.source_name)) {
      setLinkMode(true);
      setUrl(job.source_name);
      setMine(false);
    } else {
      setLinkMode(false);
      setError("Choose the video file again to retry with longer clips.");
    }
  }

  return (
    <div className="ed2-clips" data-testid="clips-panel">
      <form className="ed2-clips-form" onSubmit={submit} noValidate>
        <h3>Make clips from a long video</h3>
        <p className="ed2-clips-hint">Each clip opens as its own edit.</p>
        {linkMode ? (
          <div className="ed2-clips-link">
            <label htmlFor="clips-url">Video link</label>
            <input
              id="clips-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://"
              value={url}
              disabled={busy}
              data-testid="clips-url"
              onChange={(event) => {
                setUrl(event.target.value);
                setMine(false);
              }}
              onKeyDown={(event) => event.stopPropagation()}
            />
            {provider.kind === "unsupported" ? <small className="ed2-clips-error">{provider.message}</small> : null}
            <LinkPreview url={url} showThumbnail duration={null} endpoint="/editor/clipping/preview" />
            <label className="ed2-clips-own">
              <input type="checkbox" checked={mine} disabled={busy} data-testid="clips-own" onChange={(event) => setMine(event.target.checked)} />
              <span>
                <b>{youtubeId(url) ? "Is this your YouTube video?" : "Is this your video?"}</b> Yes, I made it or I own the rights to it.
                <small>OpenCMO only makes clips from your own videos. We keep this confirmation with the job.</small>
              </span>
            </label>
            <button type="button" className="ed2-clips-switch" disabled={busy} onClick={() => setLinkMode(false)}>
              Upload a file instead
            </button>
          </div>
        ) : (
          <div
            className="ed2-clips-drop"
            onDragOver={(event) => {
              if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault();
            }}
            onDrop={(event) => {
              if (!event.dataTransfer.files.length) return;
              event.preventDefault();
              event.stopPropagation();
              pickFile(event.dataTransfer.files[0] ?? null);
            }}
          >
            <strong>{file ? file.name : "Drop your video here"}</strong>
            {file ? <small>{(file.size / 1024 / 1024).toFixed(1)} MB</small> : <small>Any video format · up to 2 GB</small>}
            <input
              ref={picker}
              type="file"
              accept="video/*"
              aria-label="Video file"
              data-testid="clips-file"
              hidden
              onChange={(event) => {
                pickFile(event.target.files?.[0] ?? null);
                event.target.value = "";
              }}
            />
            <button type="button" className="ed2-btn" disabled={busy} onClick={() => picker.current?.click()}>
              {file ? "Choose another video" : "Choose video"}
            </button>
            {progress !== null ? (
              <div className="ed2-clips-progress">
                <progress max={100} value={progress} aria-label="Upload progress" />
                <button type="button" className="ed2-clips-switch" onClick={() => upload.current?.abort()}>Cancel</button>
              </div>
            ) : null}
            <button type="button" className="ed2-clips-switch" disabled={busy} onClick={() => setLinkMode(true)} data-testid="clips-use-link">
              Use a link instead
            </button>
          </div>
        )}

        <div className="ed2-clips-row">
          <label>
            <span>Clips to find</span>
            <select value={count} disabled={busy} onChange={(event) => setCount(Number(event.target.value))}>
              {CLIP_COUNTS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>
            <span>Clip length</span>
            <select value={length} disabled={busy} onChange={(event) => setLength(event.target.value as ClipLength)}>
              {CLIP_LENGTH_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>
        <fieldset className="ed2-clips-seg" role="radiogroup" aria-label="Aspect ratio">
          <legend>Frame</legend>
          {ASPECTS.map((value) => (
            <label key={value} className={aspect === value ? "is-on" : ""}>
              <input type="radio" name="clips-aspect" value={value} checked={aspect === value} disabled={busy} onChange={() => setAspect(value)} />
              {value}
            </label>
          ))}
        </fieldset>
        <fieldset className="ed2-clips-seg" role="radiogroup" aria-label="Captions">
          <legend>Captions</legend>
          {CAPTIONS.map((option) => (
            <label key={option.value} className={captions === option.value ? "is-on" : ""}>
              <input type="radio" name="clips-captions" value={option.value} checked={captions === option.value} disabled={busy} onChange={() => setCaptions(option.value)} />
              {option.label}
            </label>
          ))}
        </fieldset>

        {error ? <p className="ed2-clips-error" role="alert">{error}</p> : null}
        {needsPlan ? (
          <a className="ed2-btn ed2-primary" href="/app/billing">Choose a plan to start</a>
        ) : (
          <button type="submit" className="ed2-btn ed2-primary" disabled={busy || !ready} data-testid="clips-submit">
            {progress !== null ? `Uploading ${progress}%` : busy ? "Starting…" : "Make clips"}
          </button>
        )}
        <p className={`ed2-clips-hint ${short ? "is-short" : ""}`}>
          {estimate !== null ? `About ${estimate} ${estimate === 1 ? "credit" : "credits"}` : `${CREDITS_PER_MINUTE} credit per minute of video`}
          {credits !== null ? ` · ${credits} left` : ""}
          {short ? <> · <a href="/app/billing">Top up</a></> : null}
        </p>
      </form>

      <section className="ed2-clips-jobs" aria-label="Your clip jobs">
        {jobs === null ? <p className="ed2-clips-hint">Loading…</p> : null}
        {jobs?.length === 0 ? <p className="ed2-clips-hint">Clips you make appear here.</p> : null}
        {jobs?.map((job) => (
          <article key={job.id} className="ed2-clips-job" data-testid="clips-job" data-job={job.id} data-status={job.status}>
            <header>
              <strong title={job.title ?? job.source_name}>{job.title ?? job.source_name}</strong>
              <a href={`/app/projects/${job.id}`} data-testid="clips-project">Project</a>
            </header>
            {!TERMINAL.has(job.status) ? (
              <small>
                {stageLabel(job)}
                {job.clips_found.length ? ` · ${job.clips_found.length}/${job.clips_requested}` : ""}
              </small>
            ) : null}
            {job.status === "failed" || job.status === "cancelled" ? <small className="ed2-clips-error">{job.error ?? stageLabel(job)}</small> : null}
            {job.status === "done" && job.clips_found.length === 0 && job.settings.mode !== "full" ? (
              <div className="ed2-clips-none">
                <small>No usable moments found. Longer clips usually work.</small>
                <button type="button" className="ed2-clips-switch" onClick={() => retryLonger(job)}>Try again with longer clips</button>
              </div>
            ) : null}
            {job.clips_found.length ? (
              <ul>
                {job.clips_found.map((clip) => (
                  <li key={clip.id}>
                    {clip.thumbnail_url ? (
                      <video src={`${clip.thumbnail_url}#t=0.1`} muted preload="metadata" aria-hidden="true" />
                    ) : (
                      <span className="ed2-clips-thumb" aria-hidden="true" />
                    )}
                    <span className="ed2-clips-hook">
                      {clip.hook ?? `Clip ${clip.idx + 1}`}
                    </span>
                    {/* Bản sửa của clip dựng từ master + transcript mà worker ghi lúc job XONG:
                        mở sớm hơn là "This clip has no editable source yet". */}
                    {job.status === "done" ? (
                      <button type="button" className="ed2-btn" data-testid="clips-open" onClick={() => onOpen(clip.id)}>
                        Open
                      </button>
                    ) : (
                      <small>Preparing…</small>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </article>
        ))}
      </section>
    </div>
  );
}
