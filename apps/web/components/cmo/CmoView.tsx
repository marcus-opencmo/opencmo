"use client";

/**
 * Màn AI CMO, bước 1: nhập website → bốn document → người dùng đọc và sửa.
 *
 * Chưa có document: chỉ một ô "Your website" (mang sẵn `?site=` từ landing).
 * Có rồi: bốn thẻ, mỗi thẻ xem/sửa được; sửa là lưu version mới, bản agent viết
 * vẫn còn trong lịch sử. Form vẽ từ mô tả field trong `lib/cmo/documents.ts`.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { api, jsonBody } from "@/components/clipping/api";
import { DOCUMENT_KINDS, DOCUMENTS, type DocumentKind, type Field } from "@/lib/cmo/documents";
import type { CmoState, DocumentRow } from "@/lib/cmo/state";

type Body = Record<string, unknown>;

export function CmoView({ initial, site }: { initial: CmoState; site: string }) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rebuild, setRebuild] = useState(false);
  const hasDocs = DOCUMENT_KINDS.some((kind) => state.documents[kind]);
  const lastSite = state.lastRun?.input?.site ?? "";

  async function build(value: string) {
    setBusy(true);
    setError(null);
    try {
      await api("/cmo/onboarding", jsonBody({ site: value }));
      setState(await api<CmoState>("/cmo/documents"));
      setRebuild(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!hasDocs || rebuild) {
    return (
      <section className="settings-view cmo-view" data-testid="cmo-onboarding">
        <h1 className="page-title">{hasDocs ? "Rebuild your marketing plan" : "Meet your AI CMO"}</h1>
        <p className="cmo-lead">
          Enter your website. OpenCMO reads it and writes the four documents your marketing is built on: what you sell,
          who it is for, who you compete with and what to post. You can edit every word.
        </p>
        <SiteForm initial={site || lastSite} busy={busy} onSubmit={build} />
        {busy ? (
          <p className="cmo-progress" role="status">
            Reading your website and writing your plan. This usually takes under a minute.
          </p>
        ) : null}
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        {hasDocs ? (
          <p className="cmo-note">
            This writes new drafts of all four documents. Your current versions stay in history.{" "}
            <button type="button" className="text-button" onClick={() => setRebuild(false)} disabled={busy}>
              Cancel
            </button>
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="settings-view cmo-view" data-testid="cmo-documents">
      <div className="cmo-head">
        <div>
          <h1 className="page-title">Your marketing plan</h1>
          <p className="cmo-lead">
            {lastSite ? <>Built from <strong>{lastSite}</strong>. </> : null}
            Everything your departments write starts from these documents. Fix anything that is wrong.
          </p>
        </div>
        <button type="button" className="secondary-button" onClick={() => setRebuild(true)}>
          Rebuild from website
        </button>
      </div>

      <div className="cmo-docs">
        {DOCUMENT_KINDS.map((kind) => {
          const row = state.documents[kind];
          return row ? (
            <DocumentCard
              key={kind}
              kind={kind}
              row={row}
              onSaved={(saved) => setState((s) => ({ ...s, documents: { ...s.documents, [kind]: saved } }))}
            />
          ) : null;
        })}
        <article className="cmo-doc">
          <header className="cmo-doc-head">
            <div>
              <h2>Design Guide</h2>
              <p className="cmo-doc-summary">Colors, fonts, captions and logo for everything you publish.</p>
            </div>
          </header>
          <Link className="text-button" href="/app/brand">
            Open your brand kit
          </Link>
        </article>
      </div>
    </section>
  );
}

function SiteForm({ initial, busy, onSubmit }: { initial: string; busy: boolean; onSubmit: (site: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="cmo-site"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <label htmlFor="cmo-site">Your website</label>
      <div className="cmo-site-row">
        <input
          id="cmo-site"
          type="text"
          inputMode="url"
          autoComplete="url"
          placeholder="yourcompany.com"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={busy}
          required
        />
        <button type="submit" className="primary-button" disabled={busy || !value.trim()}>
          {busy ? "Building your plan…" : "Build my marketing plan"}
        </button>
      </div>
    </form>
  );
}

function DocumentCard({ kind, row, onSaved }: { kind: DocumentKind; row: DocumentRow; onSaved: (row: DocumentRow) => void }) {
  const doc = DOCUMENTS[kind];
  const [draft, setDraft] = useState<Body | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await api<DocumentRow>(`/cmo/documents/${kind}`, jsonBody({ body: draft }, "PUT")));
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="cmo-doc" id={kind} data-testid={`cmo-doc-${kind}`}>
      <header className="cmo-doc-head">
        <div>
          <h2>{doc.title}</h2>
          <p className="cmo-doc-summary">{doc.summary}</p>
        </div>
        <span className={`cmo-badge is-${row.created_by}`}>{row.created_by === "agent" ? "Drafted by OpenCMO" : "Edited by you"}</span>
      </header>
      {draft ? (
        <div className="cmo-form">
          <Fields fields={doc.fields} value={draft} onChange={setDraft} idPrefix={kind} />
          {error ? <p className="field-error" role="alert">{error}</p> : null}
          <div className="cmo-actions">
            <button type="button" className="primary-button" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" className="text-button" onClick={() => setDraft(null)} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <ReadFields fields={doc.fields} value={row.body} />
          <div className="cmo-actions">
            <button type="button" className="secondary-button" onClick={() => setDraft(structuredClone(row.body))}>
              Edit
            </button>
          </div>
        </>
      )}
    </article>
  );
}

function ReadFields({ fields, value }: { fields: Field[]; value: Body }) {
  return (
    <dl className="cmo-read">
      {fields.map((field) => {
        const v = value[field.key];
        if (field.type === "group") {
          const rows = Array.isArray(v) ? (v as Body[]) : [];
          return (
            <div key={field.key} className="cmo-read-row is-wide">
              <dt>{field.label}</dt>
              <dd>
                {rows.length === 0 ? (
                  <span className="cmo-empty">None yet</span>
                ) : (
                  <ul className="cmo-groups">
                    {rows.map((r, i) => (
                      <li key={i}>
                        <ReadFields fields={field.fields} value={r} />
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          );
        }
        if (field.type === "list") {
          const items = Array.isArray(v) ? (v as string[]) : [];
          return (
            <div key={field.key} className="cmo-read-row">
              <dt>{field.label}</dt>
              <dd>{items.length ? <ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul> : <span className="cmo-empty">None yet</span>}</dd>
            </div>
          );
        }
        const text = typeof v === "string" ? v : "";
        return (
          <div key={field.key} className={`cmo-read-row ${field.type === "long" ? "is-wide" : ""}`}>
            <dt>{field.label}</dt>
            <dd>{text || <span className="cmo-empty">Not set</span>}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function Fields({ fields, value, onChange, idPrefix }: { fields: Field[]; value: Body; onChange: (next: Body) => void; idPrefix: string }) {
  const set = (key: string, next: unknown) => onChange({ ...value, [key]: next });
  return (
    <div className="cmo-fields">
      {fields.map((field) => {
        const id = `${idPrefix}-${field.key}`;
        if (field.type === "group") {
          const rows = Array.isArray(value[field.key]) ? (value[field.key] as Body[]) : [];
          return (
            <fieldset key={field.key} className="cmo-group">
              <legend>{field.label}</legend>
              {rows.map((row, i) => (
                <div key={i} className="cmo-group-row">
                  <Fields fields={field.fields} value={row} idPrefix={`${id}-${i}`} onChange={(next) => set(field.key, rows.map((r, j) => (j === i ? next : r)))} />
                  <button type="button" className="text-button" onClick={() => set(field.key, rows.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </div>
              ))}
              {rows.length < field.max ? (
                <button type="button" className="text-button" onClick={() => set(field.key, [...rows, {}])}>
                  Add {field.label.toLowerCase().replace(/s$/, "")}
                </button>
              ) : null}
            </fieldset>
          );
        }
        if (field.type === "list") {
          const items = Array.isArray(value[field.key]) ? (value[field.key] as string[]) : [];
          return (
            <label key={field.key} className="cmo-field" htmlFor={id}>
              <span>{field.label} <small>One per line</small></span>
              <textarea id={id} rows={Math.max(3, items.length + 1)} value={items.join("\n")} onChange={(e) => set(field.key, e.target.value.split("\n"))} />
            </label>
          );
        }
        const text = typeof value[field.key] === "string" ? (value[field.key] as string) : "";
        return (
          <label key={field.key} className="cmo-field" htmlFor={id}>
            <span>{field.label}</span>
            {field.type === "long" ? (
              <textarea id={id} rows={3} value={text} onChange={(e) => set(field.key, e.target.value)} />
            ) : (
              <input id={id} type="text" value={text} onChange={(e) => set(field.key, e.target.value)} />
            )}
          </label>
        );
      })}
    </div>
  );
}
