"use client";

/**
 * Marketing plan NGAY TRONG dashboard: bấm một tài liệu ở cột Brief là sheet
 * trượt từ phải đè lên 4 cột, không chuyển trang (trước đây là `/app/cmo`).
 * URL mang `?doc=` để Back/forward và link chia sẻ mở đúng tài liệu.
 *
 * Đọc dàn trang như tài liệu; Edit lưu thành version mới (bản agent viết vẫn
 * trong lịch sử) và cập nhật workspace tại chỗ. Copy/Download ra markdown.
 */

import { useEffect, useRef, useState } from "react";

import { api, jsonBody } from "@/components/clipping/api";
import { Icon } from "@/components/icons";
import { DOCUMENT_KINDS, DOCUMENTS, type DocumentKind } from "@/lib/cmo/documents";
import type { DocumentRow } from "@/lib/cmo/state";
import type { Workspace } from "@/lib/cmo/workspace";

import { DocumentForm, DocumentRead, documentMarkdown, type Body } from "../DocumentFields";
import type { Actions } from "./actions";
import { CalendarRow } from "./SidePanels";

export type DocView = DocumentKind | "calendar";
export const DOC_VIEWS: DocView[] = [...DOCUMENT_KINDS, "calendar"];
export const isDocView = (value: string | null): value is DocView => !!value && (DOC_VIEWS as string[]).includes(value);

/** Việc nào đọc tài liệu nào — dòng "Used by" ở cột Brief và đầu sheet. */
export const USED_BY: Record<DocView, string[]> = {
  product: ["X Agent", "Reddit Agent", "Video Agent"],
  strategy: ["X Agent", "Weekly plan"],
  competitors: ["Reddit Agent", "Weekly plan"],
  content_strategy: ["X Agent", "Video Agent", "Weekly plan"],
  calendar: ["X Agent", "Reddit Agent"],
};

const titleOf = (view: DocView) => (view === "calendar" ? "Content calendar" : DOCUMENTS[view].title);

type Props = {
  view: DocView | null;
  ws: Workspace;
  actions: Actions;
  onOpen: (view: DocView) => void;
  onClose: () => void;
  onSaved: (kind: DocumentKind, row: DocumentRow) => void;
};

export function DocumentSheet({ view, ws, actions, onOpen, onClose, onSaved }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (view && !dialog.open) dialog.showModal();
    if (!view && dialog.open) dialog.close();
  }, [view]);

  // ↑/↓ (ngoài ô nhập): sang tài liệu trước/sau — đọc lướt cả bộ plan không cần chuột.
  useEffect(() => {
    if (!view) return;
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const index = DOC_VIEWS.indexOf(view);
      const next = DOC_VIEWS[(index + (event.key === "ArrowDown" ? 1 : DOC_VIEWS.length - 1)) % DOC_VIEWS.length]!;
      event.preventDefault();
      onOpen(next);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [view, onOpen]);

  return (
    <dialog
      ref={ref}
      className={`cmo-sheet${wide ? " is-wide" : ""}`}
      aria-labelledby="cmo-sheet-title"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      data-testid="cmo-doc-sheet"
    >
      {view ? (
        view === "calendar" ? (
          <CalendarSheet ws={ws} actions={actions} wide={wide} onWide={() => setWide(!wide)} onClose={onClose} />
        ) : (
          <DocSheetBody key={view} kind={view} ws={ws} actions={actions} wide={wide} onWide={() => setWide(!wide)} onClose={onClose} onSaved={onSaved} />
        )
      ) : null}
    </dialog>
  );
}

function SheetHead({ title, children, wide, onWide, onClose }: { title: string; children?: React.ReactNode; wide: boolean; onWide: () => void; onClose: () => void }) {
  return (
    <header className="cmo-sheet-head">
      <span className="cmo-sheet-mark" aria-hidden="true"><Icon name="file-text" size={16} /></span>
      <h2 id="cmo-sheet-title">{title}</h2>
      <div className="cmo-sheet-tools">
        {children}
        <button type="button" className="cmo-icon-btn" onClick={onWide} aria-label={wide ? "Narrow view" : "Expand"} title={wide ? "Narrow view" : "Expand"}>
          <Icon name={wide ? "minimize-2" : "maximize-2"} size={16} />
        </button>
        <button type="button" className="cmo-icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="x" size={17} />
        </button>
      </div>
    </header>
  );
}

function DocSheetBody({
  kind,
  ws,
  actions,
  wide,
  onWide,
  onClose,
  onSaved,
}: {
  kind: DocumentKind;
  ws: Workspace;
  actions: Actions;
  wide: boolean;
  onWide: () => void;
  onClose: () => void;
  onSaved: (kind: DocumentKind, row: DocumentRow) => void;
}) {
  const doc = DOCUMENTS[kind];
  const row = ws.documents[kind];
  const [draft, setDraft] = useState<Body | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(kind, await api<DocumentRow>(`/cmo/documents/${kind}`, jsonBody({ body: draft }, "PUT")));
      setDraft(null);
      actions.toast(`${doc.title} saved. Your agents use it from now on.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function copy() {
    if (!row) return;
    try {
      await navigator.clipboard.writeText(documentMarkdown(kind, row.body));
      actions.toast("Copied as Markdown");
    } catch {
      actions.toast("Could not copy. Select the text and copy it");
    }
  }

  function download() {
    if (!row) return;
    const url = URL.createObjectURL(new Blob([documentMarkdown(kind, row.body)], { type: "text/markdown" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${kind.replace(/_/g, "-")}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="cmo-sheet-inner">
      <SheetHead title={doc.title} wide={wide} onWide={onWide} onClose={onClose}>
        {row && !draft ? (
          <>
            <button type="button" className="cmo-icon-btn" onClick={copy} aria-label="Copy as Markdown" title="Copy as Markdown">
              <Icon name="copy" size={16} />
            </button>
            <button type="button" className="cmo-icon-btn" onClick={() => setDraft(structuredClone(row.body))} aria-label="Edit" title="Edit">
              <Icon name="pencil" size={16} />
            </button>
            <button type="button" className="cmo-icon-btn" onClick={download} aria-label="Download Markdown" title="Download Markdown">
              <Icon name="download" size={16} />
            </button>
          </>
        ) : null}
      </SheetHead>
      <div className="cmo-sheet-body">
        <p className="cmo-sheet-meta">
          {doc.summary} <span>Used by {USED_BY[kind].join(" · ")}</span>
          {row ? <span>{row.createdBy === "agent" ? "Drafted by OpenCMO" : "Edited by you"} · version {row.version}</span> : null}
        </p>
        {!row ? (
          <p className="cmo-muted">This document is written when you build your marketing plan.</p>
        ) : draft ? (
          <div className="cmo-form">
            <DocumentForm fields={doc.fields} value={draft} onChange={setDraft} idPrefix={`sheet-${kind}`} />
            {error ? <p className="field-error" role="alert">{error}</p> : null}
            <div className="cmo-card-actions cmo-sheet-save">
              <button type="button" className="primary-button" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
              <button type="button" className="text-button" onClick={() => setDraft(null)} disabled={saving}>Cancel</button>
            </div>
          </div>
        ) : (
          <DocumentRead fields={doc.fields} value={row.body} />
        )}
        {!draft ? (
          rebuilding ? (
            <Rebuild onDone={() => setRebuilding(false)} actions={actions} />
          ) : (
            <p className="cmo-sheet-foot">
              Something off across the whole plan?{" "}
              <button type="button" className="text-button" onClick={() => setRebuilding(true)}>Rebuild from your website</button>
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}

/** Viết lại cả bốn tài liệu từ website (W0). Bản hiện tại vẫn trong lịch sử. */
function Rebuild({ onDone, actions }: { onDone: () => void; actions: Actions }) {
  const [site, setSite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="cmo-site cmo-sheet-rebuild"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!site.trim()) return;
        setBusy(true);
        setError(null);
        try {
          await api("/cmo/onboarding", jsonBody({ site: site.trim() }));
          await actions.refresh();
          actions.toast("Your marketing plan was rebuilt. The previous versions are in history.");
          onDone();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor="cmo-rebuild-site">Your website</label>
      <div className="cmo-site-row">
        <input id="cmo-rebuild-site" type="text" inputMode="url" placeholder="yourcompany.com" value={site} onChange={(e) => setSite(e.target.value)} disabled={busy} required />
        <button type="submit" className="primary-button" disabled={busy || !site.trim()}>{busy ? "Rebuilding…" : "Rebuild plan"}</button>
        <button type="button" className="text-button" onClick={onDone} disabled={busy}>Cancel</button>
      </div>
      {busy ? <p className="cmo-muted" role="status">Reading your website and rewriting all four documents. This usually takes under a minute.</p> : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </form>
  );
}

function CalendarSheet({ ws, actions, wide, onWide, onClose }: { ws: Workspace; actions: Actions; wide: boolean; onWide: () => void; onClose: () => void }) {
  const [planning, setPlanning] = useState(false);
  const busy = ws.log.some((l) => l.job === "W1" && (l.status === "queued" || l.status === "running"));
  return (
    <div className="cmo-sheet-inner">
      <SheetHead title={titleOf("calendar")} wide={wide} onWide={onWide} onClose={onClose} />
      <div className="cmo-sheet-body">
        <p className="cmo-sheet-meta">
          The next two weeks, one idea per day, each with a reason. <span>Used by {USED_BY.calendar.join(" · ")}</span>
        </p>
        {ws.calendar.length ? (
          <ol className="cmo-calendar is-sheet">
            {ws.calendar.map((item) => <CalendarRow key={item.id} item={item} actions={actions} />)}
          </ol>
        ) : (
          <p className="cmo-muted">Nothing planned yet.</p>
        )}
        <div className="cmo-card-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={planning || busy}
            onClick={async () => {
              setPlanning(true);
              await actions.run("plan_week");
              setPlanning(false);
            }}
          >
            {busy ? "Planning…" : ws.calendar.length ? "Replan this week" : "Plan my week"}
          </button>
        </div>
      </div>
    </div>
  );
}
