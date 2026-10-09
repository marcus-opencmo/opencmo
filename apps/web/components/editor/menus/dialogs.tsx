"use client";

/**
 * Hộp thoại của menu dự án: hai cái OpenCMO thêm vào fork (checklist MNU-08)
 * và bảng tra phím của Help (MNU-09, cuối file):
 *
 * - Version history: quay về bản gốc (như bộ sinh tạo ra), một bản đã export,
 *   hay một checkpoint. Bản hiện tại được chụp thành checkpoint TRƯỚC, nên luôn
 *   quay lại được. Khôi phục một revision là một lượt sửa bình thường (Undo
 *   được); về bản gốc đi qua `project/reset` (khoá lạc quan) rồi nhận bản mới.
 * - Apply caption style to all clips: preset + màu phụ đề của clip này sang mọi
 *   clip khác của project, bằng op `set_caption_style` chạy trên server, mỗi
 *   clip một checkpoint trước khi đổi.
 */

import { useEffect, useState } from "react";

import type { ClipDocument } from "@opencmo/clip-doc";
import { activeScene, readCaptionStyle, timelinesOf, type BrandKit } from "@opencmo/editor-core";

import { api, jsonBody } from "@/components/clipping/api";
import type { DocumentSession } from "@/lib/editor/session";

import { SHORTCUT_GROUPS, shortcutLabels } from "../shortcuts";

type RevisionRow = { id: string; number: number; kind: "export" | "agent" | "manual"; label: string | null; created_at: string };
type History = { original: boolean; revisions: RevisionRow[] };
type Project = { document: ClipDocument; version: number; document_hash?: string | null; manifest?: unknown };

// Bản export biến thể khung (C4) mang nhãn khung ("4:5"): hiện ra để biết bản nào là bản nào.
const revisionName = (revision: RevisionRow) =>
  revision.kind === "export" ? `Export ${revision.number}${revision.label ? ` · ${revision.label}` : ""}` : (revision.label ?? "Checkpoint");
const formatDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Chụp bản đang lưu thành checkpoint; đẩy bài đang dở lên trước. */
async function checkpoint(session: DocumentSession, clipId: string, label: string): Promise<void> {
  await session.flush();
  const { project } = await api<{ project: Project }>(
    "/editor/ops",
    jsonBody({ clip_id: clipId, expected_version: session.getState().version, ops: [], checkpoint: { kind: "manual", label } }),
  );
  if (project?.version !== undefined && project.version !== session.getState().version) {
    session.adopt(project.document, project.version, project.document_hash ?? null, project.manifest);
  }
}

function Dialog({ title, description, testid, onClose, children }: { title: string; description: string; testid: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="ed2-dialog-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="ed2-dialog" role="dialog" aria-label={title} data-testid={testid}>
        <header className="ed2-row">
          <h2 className="ed2-dialog-title">{title}</h2>
          <span className="ed2-grow" />
          <button type="button" className="ed2-icon" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <p className="ed2-muted">{description}</p>
        {children}
      </div>
    </div>
  );
}

export function HistoryDialog({
  session,
  clipId,
  onClose,
  notify,
  run,
}: {
  session: DocumentSession;
  clipId: string;
  onClose: () => void;
  notify: (message: string) => void;
  /** Đường op của editor: mở bản cũ thành timeline mới (E2-a) là một lượt sửa thường. */
  run: (ops: unknown[]) => Promise<unknown>;
}) {
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api<History>(`/editor/revisions?clip_id=${encodeURIComponent(clipId)}`).then(setHistory, (err: Error) => setError(err.message));
  }, [clipId]);

  const restoreOriginal = async () => {
    setBusy("original");
    try {
      await checkpoint(session, clipId, "Before restoring the original");
      const next = await api<Project>("/editor/project/reset", jsonBody({ clip_id: clipId, expected_version: session.getState().version }));
      session.adopt(next.document, next.version, next.document_hash ?? null, next.manifest);
      notify("Restored the original version.");
      onClose();
    } catch (err) {
      setError(`Could not restore the original. ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const restore = async (revision: RevisionRow) => {
    setBusy(revision.id);
    try {
      await checkpoint(session, clipId, `Before restoring ${revisionName(revision)}`);
      const { document } = await api<{ document: ClipDocument }>(
        `/editor/revisions?clip_id=${encodeURIComponent(clipId)}&id=${encodeURIComponent(revision.id)}`,
      );
      session.commit(document);
      notify(`Restored ${revisionName(revision)}.`);
      onClose();
    } catch (err) {
      setError(`Could not restore that version. ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  // Bản cũ thành một timeline mới cạnh bản đang sửa — so hai bản mà không ghi đè gì.
  const openAsTimeline = async (revision: RevisionRow) => {
    setBusy(revision.id);
    try {
      const { document } = await api<{ document: ClipDocument }>(
        `/editor/revisions?clip_id=${encodeURIComponent(clipId)}&id=${encodeURIComponent(revision.id)}`,
      );
      const scene = structuredClone(activeScene(document)) as unknown as Record<string, unknown>;
      const current = timelinesOf(session.current);
      scene.name = revisionName(revision).slice(0, 60);
      scene.x = Math.max(...current.map((item) => (item.x ?? 0) + item.width)) + 200;
      scene.y = 0;
      await run([{ op: "insert_scene", node: scene }]);
      notify(`Opened ${revisionName(revision)} as a new timeline.`);
      onClose();
    } catch (err) {
      setError(`Could not open that version. ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      title="Version history"
      testid="version-history"
      onClose={onClose}
      description="Go back to the clip as it was first generated, to a version you exported, or to a checkpoint. Your current version is saved as a checkpoint first, so you can always come back to it."
    >
      {error ? <p className="ed2-error ed2-wrap-text">{error}</p> : null}
      {!history && !error ? <p className="ed2-muted">Loading…</p> : null}
      {history ? (
        <ul className="ed2-dialog-list">
          {history.original ? (
            <li className="ed2-row">
              <span>Original (as generated)</span>
              <span className="ed2-grow" />
              <button type="button" className="ed2-btn" disabled={busy !== null} data-testid="restore-original" onClick={() => void restoreOriginal()}>
                {busy === "original" ? "Restoring…" : "Restore"}
              </button>
            </li>
          ) : null}
          {history.revisions.map((revision) => (
            <li key={revision.id} className="ed2-row">
              <span>
                {revisionName(revision)} <span className="ed2-muted">{formatDate(revision.created_at)}</span>
              </span>
              <span className="ed2-grow" />
              <button type="button" className="ed2-link" disabled={busy !== null} data-testid="open-as-timeline" onClick={() => void openAsTimeline(revision)}>
                Open as new timeline
              </button>
              <button type="button" className="ed2-btn" disabled={busy !== null} onClick={() => void restore(revision)}>
                {busy === revision.id ? "Working…" : "Restore"}
              </button>
            </li>
          ))}
          {!history.original && !history.revisions.length ? (
            <li className="ed2-muted">No earlier versions yet. Exports and checkpoints are saved here.</li>
          ) : null}
        </ul>
      ) : null}
    </Dialog>
  );
}

type ProjectDetail = { clips: { id: string; idx?: number; hook?: string | null }[] };

export function ApplyStyleDialog({
  document,
  clipId,
  projectId,
  onClose,
  notify,
}: {
  document: ClipDocument;
  clipId: string;
  projectId: string;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState<{ id: string; label: string; reason: string }[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (only?: string[]) => {
    if (running) return;
    setRunning(true);
    setFailed([]);
    setError(null);
    try {
      const style = readCaptionStyle(document);
      if (!style) throw new Error("This clip has no captions to copy the style from.");
      const detail = await api<ProjectDetail>(`/projects/${encodeURIComponent(projectId)}`);
      const targets = detail.clips
        .map((clip, index) => ({ id: clip.id, label: clip.hook?.trim() || `Clip ${(clip.idx ?? index) + 1}` }))
        .filter((clip) => clip.id !== clipId && (!only || only.includes(clip.id)));
      setProgress({ done: 0, total: targets.length });
      const errors: typeof failed = [];
      for (const target of targets) {
        try {
          // GET tạo project cho clip chưa từng mở, bằng đúng bộ sinh của lần mở đầu.
          const { version } = await api<{ version: number }>(`/editor/project?clip_id=${encodeURIComponent(target.id)}`);
          // Mang đủ kiểu chữ (font, độ đậm, màu chữ) — null xoá đè ở clip đích để khớp clip nguồn.
          const change = {
            op: "set_caption_style",
            preset: style.preset,
            colors: style.colors,
            color: style.color ?? null,
            font: style.fontFamily ?? null,
            weight: style.fontWeight ?? null,
          };
          const before = { kind: "manual", label: "Before applying caption style" };
          await api("/editor/ops", jsonBody({ clip_id: target.id, expected_version: version, ops: [change], checkpoint: before }));
        } catch (err) {
          errors.push({ ...target, reason: (err as Error).message });
        }
        setProgress((state) => state && { ...state, done: state.done + 1 });
      }
      setFailed(errors);
      if (!errors.length) {
        notify(targets.length ? `Caption style applied to ${targets.length} ${targets.length === 1 ? "clip" : "clips"}.` : "No other clips in this project.");
        onClose();
      }
    } catch (err) {
      setError(`Could not apply the caption style. ${(err as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog
      title="Apply caption style to all clips"
      testid="apply-style"
      onClose={() => !running && onClose()}
      description="Every other clip in this project gets this clip's caption preset and colors. Their words, timing and layout stay as they are."
    >
      {progress ? (
        <p className="ed2-muted" aria-live="polite" data-testid="apply-style-progress">
          {progress.done} of {progress.total} clips
        </p>
      ) : null}
      {error ? <p className="ed2-error ed2-wrap-text">{error}</p> : null}
      {failed.length ? (
        <div>
          <p className="ed2-error">These clips were not updated:</p>
          <ul className="ed2-dialog-list ed2-muted">
            {failed.map((item) => (
              <li key={item.id}>
                {item.label} — {item.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <footer className="ed2-row">
        <span className="ed2-grow" />
        <button type="button" className="ed2-btn" disabled={running} onClick={onClose}>
          Cancel
        </button>
        {failed.length ? (
          <button type="button" className="ed2-btn ed2-primary" disabled={running} onClick={() => void apply(failed.map((item) => item.id))}>
            Retry failed
          </button>
        ) : (
          <button type="button" className="ed2-btn ed2-primary" disabled={running} data-testid="apply-style-run" onClick={() => void apply()}>
            {running ? "Applying…" : "Apply"}
          </button>
        )}
      </footer>
    </Dialog>
  );
}

/** Help › Keyboard shortcuts: bảng tra, chỉ đọc. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" description="Shortcuts work when no text field is focused." testid="shortcuts-dialog" onClose={onClose}>
      <div className="ed2-shortcuts">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title}>
            <h3 className="ed2-shortcut-group">{group.title}</h3>
            <dl>
              {group.actions.map(([action, title]) => (
                <div key={action} className="ed2-shortcut-row">
                  <dt>{title}</dt>
                  <dd>
                    {shortcutLabels(action).map((label) => (
                      <kbd key={label}>{label}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

type KitRow = { id: string; name: string; kit: BrandKit; is_default: boolean };

/**
 * Menu dự án › Apply brand kit (spec brand-kit BK4): áp một kit lên clip này
 * (op `apply_brand` qua đường ghi của editor — Undo được), hoặc lên mọi clip của
 * project (cùng vòng lặp với Apply caption style, mỗi clip một checkpoint).
 */
export function ApplyBrandDialog({
  clipId,
  projectId,
  onApply,
  onClose,
  notify,
}: {
  clipId: string;
  projectId: string;
  onApply: (ops: unknown[]) => Promise<unknown>;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [kits, setKits] = useState<KitRow[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [frame, setFrame] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ kits: KitRow[] }>("/brand-kits")
      .then(({ kits: list }) => {
        setKits(list);
        setChosen((list.find((row) => row.is_default) ?? list[0])?.id ?? null);
      })
      .catch(() => setError("Could not load your brand kits."));
  }, []);

  const kit = kits?.find((row) => row.id === chosen)?.kit ?? null;
  const op = () => ({ op: "apply_brand", kit, frame });

  const applyAll = async () => {
    if (!kit || running) return;
    setRunning(true);
    setError(null);
    try {
      await onApply([op()]);
      const detail = await api<ProjectDetail>(`/projects/${encodeURIComponent(projectId)}`);
      const others = detail.clips.filter((clip) => clip.id !== clipId);
      setProgress({ done: 0, total: others.length });
      let failed = 0;
      for (const target of others) {
        try {
          const { version } = await api<{ version: number }>(`/editor/project?clip_id=${encodeURIComponent(target.id)}`);
          await api("/editor/ops", jsonBody({ clip_id: target.id, expected_version: version, ops: [op()], checkpoint: { kind: "manual", label: "Before applying brand kit" } }));
        } catch {
          failed++;
        }
        setProgress((state) => state && { ...state, done: state.done + 1 });
      }
      if (failed) setError(`${failed} ${failed === 1 ? "clip was" : "clips were"} not updated. Open them and try again.`);
      else {
        notify(`Brand kit applied to ${others.length + 1} ${others.length ? "clips" : "clip"}.`);
        onClose();
      }
    } catch (err) {
      setError(`Could not apply the brand kit. ${(err as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog
      title="Apply brand kit"
      testid="apply-brand"
      onClose={() => !running && onClose()}
      description="Restyle captions, headings, visuals and the logo with your brand kit. Words and timing stay as they are."
    >
      {!kits && !error ? <p className="ed2-muted">Loading your brand kits…</p> : null}
      {kits && !kits.length ? (
        <p className="ed2-muted">
          You have no brand kit yet. Create one on the <a href="/app/brand">Brand kit</a> page.
        </p>
      ) : null}
      {kits?.length ? (
        <>
          <select className="ed2-select" value={chosen ?? ""} data-testid="apply-brand-kit" onChange={(event) => setChosen(event.target.value)}>
            {kits.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
                {row.is_default ? " (default)" : ""}
              </option>
            ))}
          </select>
          <label className="ed2-check">
            <input type="checkbox" checked={frame} onChange={(event) => setFrame(event.target.checked)} />
            Also change the frame to {kit?.layout.aspect ?? "the kit's"} ratio
          </label>
        </>
      ) : null}
      {progress ? (
        <p className="ed2-muted" aria-live="polite">
          {progress.done} of {progress.total} other clips
        </p>
      ) : null}
      {error ? <p className="ed2-error ed2-wrap-text">{error}</p> : null}
      <footer className="ed2-row">
        <span className="ed2-grow" />
        <button type="button" className="ed2-btn" disabled={running} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="ed2-btn" disabled={running || !kit} data-testid="apply-brand-all" onClick={() => void applyAll()}>
          {/* Clip này trước (Undo được), rồi từng clip còn lại, mỗi clip một checkpoint. */}
          All clips
        </button>
        <button
          type="button"
          className="ed2-btn ed2-primary"
          disabled={running || !kit}
          data-testid="apply-brand-run"
          onClick={() =>
            void (async () => {
              setRunning(true);
              try {
                await onApply([op()]);
                notify("Brand kit applied.");
                onClose();
              } finally {
                setRunning(false);
              }
            })()
          }
        >
          This clip
        </button>
      </footer>
    </Dialog>
  );
}
