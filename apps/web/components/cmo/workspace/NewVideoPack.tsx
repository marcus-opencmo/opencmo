"use client";

/**
 * "New video pack" của Video Agent (W5). Upload là đường chính; dán link thì
 * phải tick "Is this your YouTube video?" — xác nhận đi cùng job trong
 * `create_video_pack` (luật sản phẩm 3). Không có ô sinh video từ prompt.
 */

import { useEffect, useRef, useState } from "react";

import { ApiError, api, jsonBody } from "@/components/clipping/api";
import { linkProvider, SourceInput, type SourceMode, validateVideoFile } from "@/components/clipping/SourceInput";
import { Icon } from "@/components/icons";
import { MAX_UPLOAD_BYTES } from "@/lib/upload";
import { uploadResumable, type UploadHandle } from "@/lib/upload-tus";

type Granted = { bucket: string; objectName: string; source: string | null };

type Props = { open: boolean; onClose: () => void; onStarted: () => void };

export function NewVideoPack({ open, onClose, onStarted }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const upload = useRef<UploadHandle | null>(null);
  const [mode, setMode] = useState<SourceMode>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [mine, setMine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const provider = linkProvider(url);
  const youtube = provider.kind === "supported" && provider.name === "YouTube";
  const ready = mode === "upload" ? Boolean(file) : provider.kind === "supported" && mine;

  function close() {
    if (busy) return;
    setError(null);
    onClose();
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const source = mode === "upload" && file ? await sendFile(file) : url.trim();
      await api("/cmo/video-packs", jsonBody({ source, confirmed: mode === "link" ? mine : false }));
      setFile(null);
      setUrl("");
      setMine(false);
      setProgress(null);
      onStarted();
    } catch (failure) {
      setProgress(null);
      setError(failure instanceof ApiError || failure instanceof Error ? failure.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="cmo-modal" aria-labelledby="cmo-pack-title" onClose={close} onCancel={(e) => busy && e.preventDefault()}>
      <form className="cmo-modal-inner" onSubmit={submit} data-testid="cmo-new-pack">
        <header className="cmo-modal-head">
          <h2 id="cmo-pack-title">New video pack</h2>
          <button type="button" className="cmo-icon-btn" onClick={close} aria-label="Close" disabled={busy}>
            <Icon name="x" size={18} />
          </button>
        </header>
        <p className="cmo-why">
          Give your CMO one of your own long videos. You get up to 5 vertical clips with captions burned in, plus a caption
          for TikTok, Reels, Shorts, Facebook and Threads. You review them, download them, and post them yourself.
        </p>

        <SourceInput
          mode={mode}
          file={file}
          url={url}
          busy={busy}
          progress={progress}
          maxBytes={MAX_UPLOAD_BYTES}
          onMode={(next) => {
            setMode(next);
            setError(null);
          }}
          onFile={(next) => {
            const problem = next ? validateVideoFile(next, MAX_UPLOAD_BYTES) : null;
            setError(problem);
            setFile(problem ? null : next);
          }}
          onUrl={(next) => {
            setUrl(next);
            setMine(false);
          }}
          onCancelUpload={() => upload.current?.abort()}
        />

        {mode === "link" ? (
          <label className="cmo-own">
            <input type="checkbox" checked={mine} disabled={busy} onChange={(e) => setMine(e.target.checked)} />
            <span>
              <b>{youtube ? "Is this your YouTube video?" : "Is this your video?"}</b> Yes, I made it or I own the rights to it.
              <small>OpenCMO only makes clips from your own videos. We keep this confirmation with the job.</small>
            </span>
          </label>
        ) : null}

        {error ? <p className="field-error" role="alert">{error}</p> : null}

        <div className="cmo-card-actions">
          <button type="submit" className="primary-button" disabled={busy || !ready}>
            {busy ? (progress !== null && progress < 100 ? "Uploading…" : "Starting…") : "Make my clips"}
          </button>
          <button type="button" className="text-button" onClick={close} disabled={busy}>Cancel</button>
        </div>
        <p className="cmo-muted">Uses credits for the clips plus 1 credit for the captions. Takes a few minutes.</p>
      </form>
    </dialog>
  );
}
