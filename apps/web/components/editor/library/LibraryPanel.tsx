"use client";

/**
 * Tab Media (checklist LIB-01…04): thư mục, nhập file (chọn hoặc kéo thả),
 * đổi tên, xoá, kéo asset ra canvas/timeline, nhãn đồng bộ + Retry, và mục
 * đang sinh (partial).
 */

import { useRef, useState } from "react";

import { basename, childrenOf, dirname, isPartial, type AssetRecord, type LibraryRecord } from "@opencmo/clip-assets";

import type { LibraryApi } from "./useLibrary";

/** Kiểu dữ liệu kéo thả của một asset trong thư viện — canvas và timeline đọc nó. */
export const ASSET_DRAG = "application/x-opencmo-asset";
const FOLDER_DRAG = "application/x-opencmo-folder";

const TYPE_ICON: Record<string, string> = { VIDEO: "▶", IMAGE: "▣", AUDIO: "♪", TRANSCRIPT: "≡", LOTTIE: "✦", LUT: "◐" };

function seconds(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const total = Math.round(value);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function LibraryPanel({ library, onInsert }: { library: LibraryApi; onInsert: (record: LibraryRecord) => void }) {
  const [folder, setFolder] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const { folders, assets } = childrenOf(library.manifest, folder);

  const dropOn = (target: string) => (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setOver(null);
    const ids = event.dataTransfer.getData(ASSET_DRAG).split(",").filter(Boolean);
    const moving = event.dataTransfer.getData(FOLDER_DRAG);
    if (ids.length) library.move(ids, target);
    else if (moving) library.moveFolder(moving, target);
    else if (event.dataTransfer.files.length) void library.importFiles([...event.dataTransfer.files], target);
  };

  const rename = (commit: (name: string) => void, current: string) => (
    <input
      className="ed2-rename"
      autoFocus
      defaultValue={current}
      aria-label="New name"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        if (event.key === "Escape") setRenaming(null);
      }}
      onBlur={(event) => {
        setRenaming(null);
        const name = event.target.value.trim();
        if (name && name !== current) commit(name);
      }}
    />
  );

  return (
    <section
      className="ed2-lib"
      data-testid="library"
      onDragOver={(event) => event.preventDefault()}
      onDrop={dropOn(folder)}
    >
      <header className="ed2-lib-head">
        <span>Media</span>
        <span className="ed2-grow" />
        <button type="button" className="ed2-icon" aria-label="New folder" title="New folder" data-testid="new-folder" onClick={() => setRenaming(library.createFolder(folder))}>
          ⊞
        </button>
        <button type="button" className="ed2-btn" data-testid="import-media" onClick={() => picker.current?.click()}>
          Import
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept="video/*,image/*,audio/*,.srt,.vtt,.json,.cube"
          data-testid="import-input"
          onChange={(event) => {
            const chosen = [...(event.target.files ?? [])];
            event.target.value = "";
            if (chosen.length) void library.importFiles(chosen, folder);
          }}
        />
      </header>

      {folder ? (
        <nav className="ed2-lib-crumbs">
          <button
            type="button"
            className={over === "\u0000root" ? "ed2-link is-over" : "ed2-link"}
            onClick={() => setFolder("")}
            onDragOver={(event) => {
              event.preventDefault();
              setOver("\u0000root");
            }}
            onDragLeave={() => setOver(null)}
            onDrop={dropOn("")}
          >
            Media
          </button>
          {folder.split("/").map((part, index, parts) => {
            const path = parts.slice(0, index + 1).join("/");
            return (
              <span key={path}>
                {" / "}
                <button type="button" className="ed2-link" onClick={() => setFolder(path)}>
                  {part}
                </button>
              </span>
            );
          })}
        </nav>
      ) : null}

      <div className="ed2-lib-list">
        {folders.map((path) => (
          <div
            key={path}
            className={over === path ? "ed2-lib-item is-folder is-over" : "ed2-lib-item is-folder"}
            data-testid={`folder-${basename(path)}`}
            draggable
            onDragStart={(event) => event.dataTransfer.setData(FOLDER_DRAG, path)}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(path);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={dropOn(path)}
            onDoubleClick={() => setFolder(path)}
          >
            <span className="ed2-lib-icon">▸</span>
            {renaming === path ? (
              rename((name) => library.renameFolder(path, name), basename(path))
            ) : (
              <button type="button" className="ed2-lib-name" onClick={() => setFolder(path)}>
                {basename(path)}
              </button>
            )}
            <button type="button" className="ed2-toggle" aria-label="Rename folder" onClick={() => setRenaming(path)}>
              ✎
            </button>
            <button
              type="button"
              className="ed2-toggle"
              aria-label="Delete folder"
              data-testid={`delete-folder-${basename(path)}`}
              onClick={() => window.confirm(`Delete "${basename(path)}" and everything in it?`) && library.deleteFolder(path)}
            >
              ×
            </button>
          </div>
        ))}

        {assets.map((record) => {
          const partial = isPartial(record);
          const cloud = library.cloudOf(record);
          const progress = library.progress[record.id];
          return (
            <div
              key={record.id}
              className="ed2-lib-item"
              data-testid={`asset-${basename(record.path)}`}
              draggable={!partial}
              onDragStart={(event) => {
                event.dataTransfer.setData(ASSET_DRAG, record.id);
                event.dataTransfer.effectAllowed = "copyMove";
              }}
              onDoubleClick={() => !partial && onInsert(record)}
              title={partial ? undefined : "Drag onto the canvas or timeline, or double-click to add at the playhead"}
            >
              <span className="ed2-lib-icon">{TYPE_ICON[record.type] ?? "•"}</span>
              <div className="ed2-lib-body">
                {renaming === record.id ? (
                  rename((name) => library.rename(record.id, name), basename(record.path))
                ) : (
                  <span className="ed2-lib-name" onDoubleClick={(event) => (event.stopPropagation(), setRenaming(record.id))}>
                    {basename(record.path)}
                  </span>
                )}
                <span className="ed2-lib-meta">
                  {partial ? (
                    record.state === "pending" ? (
                      <span data-testid="partial-pending">Generating…</span>
                    ) : (
                      <span className="ed2-error" title={String(record.error ?? "")}>
                        {String(record.error ?? "Generation failed")}
                      </span>
                    )
                  ) : (
                    <>
                      <span>{seconds((record as AssetRecord).duration)}</span>
                      {cloud === "uploading" ? (
                        <span data-testid="sync-uploading">Uploading{progress !== undefined ? ` ${Math.round(progress * 100)}%` : "…"}</span>
                      ) : null}
                      {cloud === "failed" || cloud === "local" ? (
                        <>
                          <span className="ed2-warn" data-testid="sync-local">
                            This device only
                          </span>
                          <button type="button" className="ed2-link" data-testid="sync-retry" onClick={() => library.retry(record.id)}>
                            Retry
                          </button>
                        </>
                      ) : null}
                      {cloud === "device" ? (
                        <span
                          className="ed2-warn"
                          data-testid="sync-device"
                          title="Audio files stay on this device for now, so Export can't include them yet."
                        >
                          This device only
                        </span>
                      ) : null}
                    </>
                  )}
                </span>
              </div>
              {!partial ? (
                <button type="button" className="ed2-toggle" aria-label="Rename" onClick={() => setRenaming(record.id)}>
                  ✎
                </button>
              ) : null}
              <button
                type="button"
                className="ed2-toggle"
                aria-label={partial ? "Remove" : "Delete"}
                data-testid={`delete-asset-${basename(record.path)}`}
                onClick={() => library.remove([record.id])}
              >
                ×
              </button>
            </div>
          );
        })}

        {!folders.length && !assets.length ? (
          <p className="ed2-muted ed2-lib-empty">
            {folder ? "This folder is empty." : "Drop videos, images, audio or captions (.srt, .vtt) here, or use Import."}
          </p>
        ) : null}
      </div>
      {folder ? (
        <button type="button" className="ed2-link ed2-lib-up" onClick={() => setFolder(dirname(folder))}>
          ← Up
        </button>
      ) : null}
    </section>
  );
}
