/**
 * Bytes của thư viện trên máy: OPFS khi ghi được (`createWritable`), IndexedDB khi
 * không (Safari trước 26 có OPFS nhưng chỉ ghi được trong worker). Đọc và xoá thử cả
 * hai, nên file ghi bằng đường nào cũng đọc lại được sau khi trình duyệt cập nhật.
 *
 * Cùng khoá `projects/<clip>/<source>` cho cả hai đường — bố cục OPFS giữ như fork để
 * file đã nhập từ trước vẫn còn.
 */

const DB_NAME = "opencmo-library";
const STORE = "files";

/** Ghi được OPFS từ luồng chính không. */
export function canWriteOpfs(scope: { FileSystemFileHandle?: { prototype: object }; navigator?: { storage?: { getDirectory?: unknown } } }): boolean {
  return typeof scope.navigator?.storage?.getDirectory === "function" && Boolean(scope.FileSystemFileHandle && "createWritable" in scope.FileSystemFileHandle.prototype);
}

export const idbKey = (clipId: string, source: string) => `projects/${clipId}/${source.split("/").filter(Boolean).join("/")}`;

// ------------------------------------------------------------------ OPFS

async function clipDir(clipId: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const projects = await root.getDirectoryHandle("projects", { create });
    return await projects.getDirectoryHandle(clipId, { create });
  } catch {
    return null;
  }
}

async function handleAt(clipId: string, path: string, create: boolean): Promise<FileSystemFileHandle | null> {
  let dir = await clipDir(clipId, create);
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop();
  if (!dir || !name) return null;
  try {
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return await dir.getFileHandle(name, { create });
  } catch {
    return null;
  }
}

async function readOpfs(clipId: string, source: string): Promise<File | null> {
  if (typeof navigator.storage?.getDirectory !== "function") return null;
  const handle = await handleAt(clipId, source, false);
  return handle ? await handle.getFile().catch(() => null) : null;
}

async function removeOpfs(clipId: string, source: string): Promise<void> {
  if (typeof navigator.storage?.getDirectory !== "function") return;
  let dir = await clipDir(clipId, false);
  const parts = source.split("/").filter(Boolean);
  const name = parts.pop();
  if (!dir || !name) return;
  try {
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    await dir.removeEntry(name);
  } catch {
    // Không có thì là đã xoá.
  }
}

// ------------------------------------------------------------------ IndexedDB

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Lưu ArrayBuffer, không lưu Blob: WebKit ở phiên tạm (chế độ riêng tư, Playwright)
 * từ chối Blob trong IndexedDB ("Error preparing Blob/File data") — CI compat bắt được.
 */
type Stored = { bytes: ArrayBuffer; name: string; type: string };

// ------------------------------------------------------------------ chung

export async function readLocal(clipId: string, source: string): Promise<File | null> {
  const opfs = await readOpfs(clipId, source);
  // File rỗng là dấu vết của một lượt ghi hỏng: coi như không có.
  if (opfs && opfs.size > 0) return opfs;
  const stored = await idb<Stored>("readonly", (store) => store.get(idbKey(clipId, source))).catch(() => null);
  if (!stored || !stored.bytes || stored.bytes.byteLength === 0) return null;
  return new File([stored.bytes], stored.name, { type: stored.type });
}

export async function writeLocal(clipId: string, source: string, file: Blob): Promise<void> {
  const name = source.split("/").pop() ?? "file";
  if (canWriteOpfs(globalThis as never)) {
    try {
      const handle = await handleAt(clipId, source, true);
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(file);
        await writable.close();
        return;
      }
    } catch (error) {
      // Có API nhưng không cho ghi (phiên riêng tư, hết hạn mức): thử IndexedDB.
      console.warn("[library] OPFS write failed, using IndexedDB", error);
    }
  }
  const bytes = await file.arrayBuffer();
  const saved = await idb("readwrite", (store) => store.put({ bytes, name, type: file.type } satisfies Stored, idbKey(clipId, source))).catch((error) => {
    console.warn("[library] IndexedDB write failed", error);
    return null;
  });
  if (saved === null) throw new Error("This browser cannot keep files for the editor.");
}

export async function removeLocal(clipId: string, source: string): Promise<void> {
  await removeOpfs(clipId, source);
  await idb("readwrite", (store) => store.delete(idbKey(clipId, source))).catch(() => null);
}
