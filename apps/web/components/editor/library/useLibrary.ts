"use client";

/**
 * Nối thư viện với session: mọi thay đổi manifest đi qua `session.commit(…,
 * { manifest })` nên lưu CÙNG lượt với document. Thay đổi thư viện không phải
 * bước Undo (như fork); đổi tên asset thì `src` của element đi theo bằng op
 * `replace_src` — phần đó là một bước Undo.
 */

import { useCallback, useMemo, useRef, useState } from "react";

import {
  addAsset,
  createFolder,
  deleteFolder,
  moveAssets,
  moveFolder,
  normalizeManifest,
  orphanedMedia,
  removeAssets,
  renameAsset,
  renameFolder,
  uniqueFolderName,
  updateAsset,
  isPartial,
  type AssetRecord,
  type LibraryRecord,
  type Manifest,
  type Rename,
} from "@opencmo/clip-assets";
import type { ClipDocument } from "@opencmo/clip-doc";
import { activeScene, applyOps, walk, type OpContext } from "@opencmo/editor-core";

import type { DocumentSession } from "@/lib/editor/session";

import { deleteRemote, describe, keepLocal, nodeFor, readLocal, removeLocal, uploadable, upload } from "./store";

/** `device` = không lên Storage được (ảnh, âm thanh): khác `local` ở chỗ Retry vô ích. */
export type CloudDisplay = "uploading" | "synced" | "failed" | "local" | "device";

export type LibraryApi = {
  manifest: Manifest;
  progress: Record<string, number>;
  cloudOf: (record: LibraryRecord) => CloudDisplay | null;
  importFiles: (files: File[], folder: string) => Promise<LibraryRecord[]>;
  retry: (id: string) => void;
  rename: (id: string, name: string) => void;
  move: (ids: string[], folder: string) => void;
  remove: (ids: string[]) => void;
  createFolder: (parent: string) => string;
  renameFolder: (path: string, name: string) => void;
  moveFolder: (path: string, into: string) => void;
  deleteFolder: (path: string) => void;
  insert: (record: LibraryRecord, options: { at?: { x: number; y: number }; start: number }) => Promise<string | null>;
  /** Sửa manifest bất kỳ trên bản MỚI NHẤT (Generate ghi partial/record qua đây). */
  update: (change: (current: Manifest) => Manifest) => Promise<void>;
  /** Manifest mới nhất của session (không đợi React render lại). */
  latest: () => Manifest;
};

type Change = Manifest | { manifest: Manifest; renames: Rename[] };

export function useLibrary({
  session,
  manifestState,
  clipId,
  projectId,
  context,
  notify,
  onLocalBytes,
}: {
  session: DocumentSession;
  manifestState: unknown;
  clipId: string;
  projectId: string;
  context: () => OpContext;
  notify: (message: string) => void;
  /** Bytes vừa vào OPFS — nguồn trước đó thiếu bytes có thể vẽ được rồi. */
  onLocalBytes: () => void;
}): LibraryApi {
  const manifest = useMemo(() => normalizeManifest(manifestState), [manifestState]);
  // File của lượt upload đang chạy TRONG PHIÊN NÀY — để thử lại. Record nói
  // `uploading` mà không có ở đây nghĩa là tab tải lên đã đóng giữa chừng.
  const files = useRef(new Map<string, File>());
  const [progress, setProgress] = useState<Record<string, number>>({});

  /** Sửa manifest trên bản MỚI NHẤT (upload chạy nền về muộn). */
  const change = useCallback(
    async (update: (current: Manifest) => Change) => {
      const current = normalizeManifest(session.currentManifest);
      const result = update(current);
      const next = "renames" in result ? result.manifest : result;
      const renames = "renames" in result ? result.renames : [];
      if (next === current && !renames.length) return;
      if (renames.length) {
        const applied = await applyOps(session.current, [{ op: "replace_src", renames }], context());
        session.commit(applied.document as ClipDocument, { manifest: next });
      } else {
        session.commit(session.current, { manifest: next, history: false });
      }
    },
    [context, session],
  );

  const sync = useCallback(
    async (record: AssetRecord, file: File) => {
      files.current.set(record.id, file);
      await change((current) => updateAsset(current, record.id, { cloud: { state: "uploading" } }));
      try {
        const mediaId = await upload(projectId, file, (fraction) =>
          setProgress((all) => ({ ...all, [record.id]: fraction })),
        );
        await change((current) => updateAsset(current, record.id, { cloud: { state: "synced", mediaId } }));
        files.current.delete(record.id);
      } catch (error) {
        // Không chí mạng: bytes còn trong OPFS, dùng được trên máy này. Nhưng
        // người dùng phải biết nó chưa an toàn.
        await change((current) => updateAsset(current, record.id, { cloud: { state: "failed" } }));
        notify(`${record.path.split("/").pop()} is only on this device. ${(error as Error).message}`);
      } finally {
        setProgress((all) => {
          const rest = { ...all };
          delete rest[record.id];
          return rest;
        });
      }
    },
    [change, notify, projectId],
  );

  const importFiles = useCallback(
    async (list: File[], folder: string) => {
      const out: LibraryRecord[] = [];
      for (const file of list) {
        try {
          const described = await describe(file, folder);
          let placed: LibraryRecord = described;
          let fresh = false;
          await change((current) => {
            const added = addAsset(current, described);
            placed = added.record;
            fresh = added.manifest !== current;
            return added.manifest;
          });
          out.push(placed);
          // Cùng bytes đã có (và đã lên Storage) thì không thêm bản thứ hai.
          if (!fresh && (placed as AssetRecord).cloud?.state === "synced") continue;
          await keepLocal(clipId, placed as AssetRecord, file);
          onLocalBytes();
          if (uploadable(placed.type)) void sync(placed as AssetRecord, file);
        } catch (error) {
          notify(`Could not import ${file.name}. ${(error as Error).message}`);
        }
      }
      return out;
    },
    [change, clipId, notify, onLocalBytes, sync],
  );

  const retry = useCallback(
    (id: string) =>
      void (async () => {
        const record = manifest.assets.find((item) => item.id === id) as AssetRecord | undefined;
        if (!record || isPartial(record) || !uploadable(record.type)) return;
        const file = files.current.get(id) ?? (await readLocal(clipId, record.source));
        if (!file) return notify(`${record.path} was only saved on the device that added it.`);
        await sync(record, new File([file], record.path.split("/").pop() ?? "file", { type: record.mimeType }));
      })(),
    [clipId, manifest, notify, sync],
  );

  const forget = useCallback(
    async (removed: LibraryRecord[], after: Manifest) => {
      for (const mediaId of orphanedMedia(after, removed)) await deleteRemote(projectId, mediaId);
      for (const record of removed) if (!isPartial(record)) await removeLocal(clipId, record.source);
    },
    [clipId, projectId],
  );

  const remove = useCallback(
    (ids: string[]) =>
      void (async () => {
        let removed: LibraryRecord[] = [];
        let after: Manifest | null = null;
        await change((current) => {
          const result = removeAssets(current, ids);
          removed = result.removed;
          after = result.manifest;
          return result.manifest;
        });
        if (after) await forget(removed, after);
      })(),
    [change, forget],
  );

  const insert = useCallback(
    async (record: LibraryRecord, options: { at?: { x: number; y: number }; start: number }) => {
      const scene = activeScene(session.current) as unknown as Record<string, unknown> & { id?: string };
      const node = nodeFor(record, scene, options);
      if (!node || !scene.id) return null;
      const ids = (document: ClipDocument) => {
        const out: string[] = [];
        walk(document, ({ entity, tag }) => {
          if (entity.kind === tag && entity.id) out.push(entity.id);
        });
        return out;
      };
      const before = new Set(ids(session.current));
      // B-roll/âm thanh vào hàng cùng làn còn trống chỗ (`insert_to_row`), không mỗi cái một hàng.
      const rowed = record.type === "VIDEO" || record.type === "IMAGE" || record.type === "AUDIO";
      const op = rowed ? { op: "insert_to_row", node } : { op: "insert_node", parent_id: scene.id, node };
      const applied = await applyOps(session.current, [op], context());
      session.commit(applied.document);
      // Lớp mới có thể nằm trong một hàng (sequence) — tìm cả cây; hàng mới thì lấy clip, không lấy hàng.
      const fresh = ids(applied.document).filter((id) => !before.has(id));
      return fresh[fresh.length - 1] ?? null;
    },
    [context, session],
  );

  const cloudOf = useCallback(
    (record: LibraryRecord): CloudDisplay | null => {
      if (isPartial(record)) return null;
      const state = (record as AssetRecord).cloud?.state;
      // Ảnh/âm thanh do Generate sinh ra ĐÃ nằm trên Storage (`synced`); chỉ
      // file người dùng nhập mới kẹt trên máy.
      if (state !== "synced" && !uploadable(record.type)) return "device";
      if (!state) return "local";
      if (state === "uploading" && !files.current.has(record.id)) return "local";
      return state;
    },
    [],
  );

  return {
    manifest,
    progress,
    cloudOf,
    importFiles,
    retry,
    rename: (id, name) => void change((current) => renameAsset(current, id, name)),
    move: (ids, folder) => void change((current) => moveAssets(current, ids, folder)),
    remove,
    createFolder: (parent) => {
      const name = uniqueFolderName(manifest, parent, "New folder");
      const path = parent ? `${parent}/${name}` : name;
      void change((current) => createFolder(current, path));
      return path;
    },
    renameFolder: (path, name) => void change((current) => renameFolder(current, path, name)),
    moveFolder: (path, into) => void change((current) => moveFolder(current, path, into)),
    deleteFolder: (path) =>
      void (async () => {
        let removed: LibraryRecord[] = [];
        let after: Manifest | null = null;
        await change((current) => {
          const result = deleteFolder(current, path);
          removed = result.removed;
          after = result.manifest;
          return result.manifest;
        });
        if (after) await forget(removed, after);
      })(),
    insert,
    update: (apply) => change((current) => apply(current)),
    latest: () => normalizeManifest(session.currentManifest),
  };
}
