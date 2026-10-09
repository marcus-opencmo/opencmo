"use client";

/**
 * Ô chọn clip trên thanh trên của editor (E0): editor là một mục của rail, nên đổi
 * clip ngay tại đây thay vì quay về trang project rồi bấm Edit. Danh sách từ
 * `GET /api/v1/editor/clips` (clip sửa gần nhất đứng đầu).
 */

import { useEffect, useRef, useState } from "react";

import type { EditorClip } from "@/app/api/v1/editor/clips/route";

export async function loadEditorClips(): Promise<EditorClip[]> {
  const response = await fetch("/api/v1/editor/clips").catch(() => null);
  if (!response?.ok) return [];
  const body = (await response.json().catch(() => null)) as { items?: EditorClip[] } | null;
  return body?.items ?? [];
}

/** New edit (F1): project trống; trả clip id để mở `/app/editor/<id>`. */
export async function createBlankEdit(aspect: string): Promise<string> {
  const response = await fetch("/api/v1/editor/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ aspect }),
  });
  const data = (await response.json().catch(() => ({}))) as { clip_id?: string; detail?: unknown };
  if (!response.ok || !data.clip_id) throw new Error(typeof data.detail === "string" ? data.detail : "Could not start a new edit. Please try again.");
  return data.clip_id;
}

export function ClipPicker({ clipId, projectId, onOpen }: { clipId: string; projectId: string; onOpen: (href: string) => void }) {
  const [clips, setClips] = useState<EditorClip[] | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadEditorClips().then(setClips);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const current = clips?.find((clip) => clip.clip_id === clipId);
  // Đổi tên bản New edit (G1-a): tên nằm ở job + clip, ô chọn đọc lại sau khi lưu.
  const [naming, setNaming] = useState<string | null>(null);
  const rename = async (name: string) => {
    const response = await fetch("/api/v1/editor/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clip_id: clipId, name }),
    });
    if (!response.ok) return;
    setNaming(null);
    setClips(await loadEditorClips());
  };
  const needle = query.trim().toLowerCase();
  const shown = (clips ?? []).filter((clip) => !needle || `${clip.project} ${clip.label}`.toLowerCase().includes(needle));
  // Nhóm theo project, giữ thứ tự (clip sửa gần nhất kéo project của nó lên đầu).
  const groups: { project: string; projectId: string; items: EditorClip[] }[] = [];
  for (const clip of shown) {
    const group = groups.find((entry) => entry.projectId === clip.project_id);
    if (group) group.items.push(clip);
    else groups.push({ project: clip.project, projectId: clip.project_id, items: [clip] });
  }

  return (
    <div className="ed2-picker" ref={root}>
      <button
        type="button"
        className="ed2-btn ed2-picker-button"
        data-testid="clip-picker"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="ed2-picker-project">{current?.project ?? "Clip"}</span>
        {/* Bản New edit: tên project chính là tên bản sửa — không lặp hai lần. */}
        {current?.kind === "blank" ? null : <span className="ed2-picker-clip">{current?.label ?? ""}</span>}
        <span aria-hidden>▾</span>
      </button>
      {open ? (
        <div className="ed2-menu ed2-picker-menu" role="listbox" aria-label="Open another clip">
          <input
            className="ed2-select ed2-picker-search"
            autoFocus
            placeholder="Search clips"
            aria-label="Search clips"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") setOpen(false);
            }}
          />
          <div className="ed2-picker-list">
            {groups.map((group) => (
              <div key={group.projectId}>
                <div className="ed2-menu-label">{group.project}</div>
                {group.items.map((clip) => (
                  <button
                    key={clip.clip_id}
                    type="button"
                    role="option"
                    aria-selected={clip.clip_id === clipId}
                    className={`ed2-menu-item${clip.clip_id === clipId ? " is-active" : ""}`}
                    data-testid="clip-picker-item"
                    onClick={() => {
                      setOpen(false);
                      if (clip.clip_id !== clipId) onOpen(`/app/editor/${clip.clip_id}`);
                    }}
                  >
                    <span className="ed2-picker-label">{clip.label}</span>
                    {clip.edited_at ? <span className="ed2-menu-key">Edited</span> : null}
                  </button>
                ))}
              </div>
            ))}
            {clips && !groups.length ? <p className="ed2-muted ed2-picker-empty">No clips match.</p> : null}
          </div>
          {naming !== null ? (
            <form
              className="ed2-picker-rename"
              onSubmit={(event) => {
                event.preventDefault();
                void rename(naming);
              }}
            >
              <input
                className="ed2-select"
                autoFocus
                aria-label="Edit name"
                data-testid="clip-picker-name"
                maxLength={120}
                value={naming}
                onChange={(event) => setNaming(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Escape") setNaming(null);
                }}
              />
              <button type="submit" className="ed2-btn" disabled={!naming.trim()}>
                Save
              </button>
            </form>
          ) : null}
          <div className="ed2-picker-foot">
            <button
              type="button"
              className="ed2-link"
              data-testid="clip-picker-new"
              onClick={() => {
                setOpen(false);
                void createBlankEdit("9:16").then((id) => onOpen(`/app/editor/${id}`), () => onOpen("/app/editor"));
              }}
            >
              New edit
            </button>
            {current?.kind === "blank" ? (
              <button type="button" className="ed2-link" data-testid="clip-picker-rename" onClick={() => setNaming(current.project)}>
                Rename
              </button>
            ) : null}
            {current && current.kind !== "blank" ? (
              <button type="button" className="ed2-link" onClick={() => onOpen(`/app/projects/${projectId}`)}>
                Open project page
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
