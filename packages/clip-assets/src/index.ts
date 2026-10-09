/**
 * `@opencmo/clip-assets` — thư viện media của một project editor (spec
 * editor-rewrite §2, B5): manifest, đường dẫn, thư mục, đổi tên/dời/xoá.
 *
 * Thuần dữ liệu, không bytes, không mạng: mỗi hàm nhận một manifest và trả một
 * manifest MỚI (không sửa đầu vào), kèm danh sách đổi tên mà document phải theo.
 * Bytes nằm trên Storage (`cloud.mediaId`); UI tải lên và gắn record ở chỗ khác.
 *
 * Luật (đọc từ hành vi thư viện của fork, checklist §4):
 * - `path` là đường dẫn THƯ VIỆN ("folder/broll.mp4") và là thứ `src` của
 *   element gọi tên; `source` là chỗ bytes nằm ("assets/broll.mp4"), không đổi
 *   khi đổi tên.
 * - Tên trùng thêm hậu tố " 2", " 3"… trước phần mở rộng; thư mục cũng vậy.
 * - Đổi tên/dời thư mục kéo theo mọi thứ bên trong; xoá thư mục xoá cả bên trong.
 * - Record "partial" (`state: pending|error`) là một lượt sinh chưa có bytes.
 */

export type AssetType = 'VIDEO' | 'IMAGE' | 'AUDIO' | 'TRANSCRIPT' | 'LOTTIE' | 'LUT' | 'SCRIPT' | 'SEQUENCE';

export type CloudState = 'uploading' | 'synced' | 'failed';

export type AssetRecord = {
  id: string;
  path: string;
  source: string;
  type: AssetType;
  mimeType: string;
  createdAt: string;
  width?: number;
  height?: number;
  duration?: number;
  generation?: { key: string; id?: string | null };
  cloud?: { state: CloudState; mediaId?: string };
  [key: string]: unknown;
};

export type PartialRecord = {
  id: string;
  path: string;
  type: AssetType;
  createdAt: string;
  generation: { key: string; id?: string | null };
  state: 'pending' | 'error';
  error?: string;
  [key: string]: unknown;
};

export type LibraryRecord = AssetRecord | PartialRecord;

export type Manifest = { version: 1; folders: string[]; assets: LibraryRecord[] };

/** Một element phải đổi `src` từ `from` sang `to` (đổi tên, dời thư mục). */
export type Rename = { from: string; to: string };

export const ASSETS_DIR = 'assets';

export const isPartial = (record: LibraryRecord): record is PartialRecord =>
  (record as PartialRecord).state === 'pending' || (record as PartialRecord).state === 'error';

// ------------------------------------------------------------------ đường dẫn

export const normalizePath = (path: string): string =>
  path.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.' && part !== '..').join('/');

/** Đoạn cuối của đường dẫn thư viện; `dirname` là phần còn lại ('' ở gốc). */
export const basename = (path: string): string => path.split('/').at(-1) ?? '';

export const dirname = (path: string): string => path.split('/').slice(0, -1).join('/');

export const joinPath = (...parts: string[]): string => normalizePath(parts.filter(Boolean).join('/'));

function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}

/** Tên file không có phần mở rộng — tên mặc định của element chèn từ asset. */
export const stemOf = (path: string): string => splitName(basename(path)).stem;

// ------------------------------------------------------------------ đọc manifest

const TYPES = new Set<AssetType>(['VIDEO', 'IMAGE', 'AUDIO', 'TRANSCRIPT', 'LOTTIE', 'LUT', 'SCRIPT', 'SEQUENCE']);

/**
 * Manifest lấy từ database thành manifest đúng dạng. Dễ tính: thiếu hay hỏng là
 * thư viện rỗng, một record hỏng bị bỏ chứ không kéo cả thư viện đi theo. Khoá
 * lạ của record được giữ (fork ghi thêm `cloud`, `stat`…).
 */
export function normalizeManifest(input: unknown): Manifest {
  const out: Manifest = { version: 1, folders: [], assets: [] };
  if (!input || typeof input !== 'object') return out;
  const raw = input as { folders?: unknown; assets?: unknown };
  if (Array.isArray(raw.folders)) {
    for (const folder of raw.folders) {
      const path = typeof folder === 'string' ? normalizePath(folder) : '';
      if (path && !out.folders.includes(path)) out.folders.push(path);
    }
  }
  if (Array.isArray(raw.assets)) {
    const seen = new Set<string>();
    for (const item of raw.assets) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const path = typeof record.path === 'string' ? normalizePath(record.path) : '';
      if (typeof record.id !== 'string' || !record.id || !path || seen.has(record.id)) continue;
      if (!TYPES.has(record.type as AssetType)) continue;
      const partial = record.state === 'pending' || record.state === 'error';
      if (partial ? !(record.generation && typeof (record.generation as { key?: unknown }).key === 'string')
        : typeof record.source !== 'string' || !record.source || typeof record.mimeType !== 'string') continue;
      seen.add(record.id);
      out.assets.push({ ...(record as LibraryRecord), path });
    }
  }
  return out;
}

/** Mọi thư mục: khai báo, và ngầm có vì một asset nằm trong đó (kể cả thư mục cha). */
export function foldersOf(manifest: Manifest): string[] {
  const all = new Set<string>();
  const add = (path: string) => {
    for (let at = path; at; at = dirname(at)) all.add(at);
  };
  manifest.folders.forEach(add);
  for (const record of manifest.assets) add(dirname(record.path));
  return [...all].sort();
}

/** Con trực tiếp của một thư mục ('' là gốc): thư mục con và asset. */
export function childrenOf(manifest: Manifest, folder: string): { folders: string[]; assets: LibraryRecord[] } {
  return {
    folders: foldersOf(manifest).filter((path) => dirname(path) === folder),
    assets: manifest.assets.filter((record) => dirname(record.path) === folder),
  };
}

/** Record mà một `src` gọi tên: theo `path`, rồi theo `source` (document cũ). */
export function recordFor(manifest: Manifest, src: string): LibraryRecord | undefined {
  return manifest.assets.find((record) => record.path === src) ?? manifest.assets.find((record) => record.source === src);
}

// ------------------------------------------------------------------ tên không trùng

/** Một `path` chưa ai dùng: `name`, rồi `name 2`, `name 3`… (trước phần mở rộng). */
export function uniquePath(manifest: Manifest, path: string, exceptId?: string): string {
  const clean = normalizePath(path);
  const taken = new Set(manifest.assets.filter((record) => record.id !== exceptId).map((record) => record.path));
  if (!taken.has(clean)) return clean;
  const { stem, ext } = splitName(basename(clean));
  for (let n = 2; ; n++) {
    const candidate = joinPath(dirname(clean), `${stem} ${n}${ext}`);
    if (!taken.has(candidate)) return candidate;
  }
}

/** Một tên thư mục chưa có dưới `parent`: `base`, `base 2`… */
export function uniqueFolderName(manifest: Manifest, parent: string, base: string): string {
  const taken = new Set(foldersOf(manifest).filter((path) => dirname(path) === parent).map(basename));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  return name;
}

// ------------------------------------------------------------------ sửa

type Result = { manifest: Manifest; renames: Rename[] };

const copy = (manifest: Manifest): Manifest => ({
  version: 1,
  folders: [...manifest.folders],
  assets: manifest.assets.map((record) => ({ ...record })),
});

/**
 * Thêm một asset (mới nhất lên đầu). Cùng `id` — cùng bytes nhập lần hai — thì
 * không thêm gì và trả record đã có. `path` được làm cho không trùng.
 */
export function addAsset(manifest: Manifest, record: LibraryRecord): { manifest: Manifest; record: LibraryRecord } {
  const existing = manifest.assets.find((item) => item.id === record.id);
  if (existing) return { manifest, record: existing };
  const next = copy(manifest);
  const placed = { ...record, path: uniquePath(next, record.path) };
  next.assets.unshift(placed);
  return { manifest: next, record: placed };
}

/** Sửa field của một record (trạng thái đồng bộ, `mediaId`…). */
export function updateAsset(manifest: Manifest, id: string, patch: Record<string, unknown>): Manifest {
  if (!manifest.assets.some((record) => record.id === id)) return manifest;
  const next = copy(manifest);
  next.assets = next.assets.map((record) => (record.id === id ? ({ ...record, ...patch } as LibraryRecord) : record));
  return next;
}

/** Đổi `path`; trả true nếu có đổi. */
function setPath(record: LibraryRecord, path: string, renames: Rename[]): boolean {
  if (record.path === path) return false;
  // Partial chưa là nguồn của element nào: không có gì để đổi theo.
  if (!isPartial(record)) renames.push({ from: record.path, to: path });
  record.path = path;
  return true;
}

/** Đổi tên một asset (giữ thư mục; tên có "/" thành "-"). */
export function renameAsset(manifest: Manifest, id: string, name: string): Result {
  const next = copy(manifest);
  const record = next.assets.find((item) => item.id === id);
  const clean = normalizePath(name).replace(/\//g, '-');
  const renames: Rename[] = [];
  if (!record || !clean) return { manifest, renames };
  const changed = setPath(record, uniquePath(next, joinPath(dirname(record.path), clean), id), renames);
  return { manifest: changed ? next : manifest, renames };
}

/** Dời asset vào một thư mục ('' là gốc). */
export function moveAssets(manifest: Manifest, ids: string[], folder: string): Result {
  const target = normalizePath(folder);
  const next = copy(manifest);
  const renames: Rename[] = [];
  let changed = false;
  for (const record of next.assets) {
    if (!ids.includes(record.id) || dirname(record.path) === target) continue;
    changed = setPath(record, uniquePath(next, joinPath(target, basename(record.path)), record.id), renames) || changed;
  }
  return { manifest: changed ? next : manifest, renames };
}

export function createFolder(manifest: Manifest, path: string): Manifest {
  const folder = normalizePath(path);
  if (!folder || foldersOf(manifest).includes(folder)) return manifest;
  const next = copy(manifest);
  next.folders.push(folder);
  next.folders.sort();
  return next;
}

function moveFolderTo(manifest: Manifest, from: string, wanted: string): Result {
  if (!from || from === wanted) return { manifest, renames: [] };
  const to = foldersOf(manifest).includes(wanted)
    ? joinPath(dirname(wanted), uniqueFolderName(manifest, dirname(wanted), basename(wanted)))
    : wanted;
  const next = copy(manifest);
  const inside = (path: string) => path === from || path.startsWith(`${from}/`);
  next.folders = [...new Set([...next.folders.filter((path) => !inside(path)), ...next.folders.filter(inside).map((path) => to + path.slice(from.length)), to])].sort();
  const renames: Rename[] = [];
  for (const record of next.assets) {
    if (record.path.startsWith(`${from}/`)) setPath(record, to + record.path.slice(from.length), renames);
  }
  return { manifest: next, renames };
}

/** Đổi tên thư mục; mọi thứ bên trong đi theo. */
export function renameFolder(manifest: Manifest, path: string, name: string): Result {
  const clean = normalizePath(name).replace(/\//g, '-');
  if (!clean) return { manifest, renames: [] };
  return moveFolderTo(manifest, path, joinPath(dirname(path), clean));
}

/** Dời thư mục vào thư mục khác; không dời được vào chính nó. */
export function moveFolder(manifest: Manifest, path: string, into: string): Result {
  const target = normalizePath(into);
  if (target === path || target.startsWith(`${path}/`)) return { manifest, renames: [] };
  return moveFolderTo(manifest, path, joinPath(target, basename(path)));
}

/** Bỏ asset khỏi thư viện; trả các record đã bỏ (để xoá bản trên Storage). */
export function removeAssets(manifest: Manifest, ids: string[]): { manifest: Manifest; removed: LibraryRecord[] } {
  const removed = manifest.assets.filter((record) => ids.includes(record.id));
  if (!removed.length) return { manifest, removed };
  const next = copy(manifest);
  next.assets = next.assets.filter((record) => !ids.includes(record.id));
  return { manifest: next, removed };
}

/** Xoá thư mục và mọi thứ trong nó. */
export function deleteFolder(manifest: Manifest, path: string): { manifest: Manifest; removed: LibraryRecord[] } {
  const inside = (item: string) => item === path || item.startsWith(`${path}/`);
  const ids = manifest.assets.filter((record) => inside(dirname(record.path))).map((record) => record.id);
  const next = copy(removeAssets(manifest, ids).manifest);
  next.folders = next.folders.filter((folder) => !inside(folder));
  return { manifest: next, removed: manifest.assets.filter((record) => ids.includes(record.id)) };
}

/**
 * Bản trên Storage nào xoá được sau khi bỏ `removed`: không asset CÒN LẠI nào
 * trỏ cùng `mediaId` (cùng bytes nhập hai lần là một asset, nhưng không giả định).
 */
export function orphanedMedia(manifest: Manifest, removed: LibraryRecord[]): string[] {
  const kept = new Set(
    manifest.assets.map((record) => (record as AssetRecord).cloud?.mediaId).filter((id): id is string => !!id),
  );
  const out = new Set<string>();
  for (const record of removed) {
    const id = (record as AssetRecord).cloud?.mediaId;
    if (id && !kept.has(id)) out.add(id);
  }
  return [...out];
}

/** `.cube` không có MIME chuẩn (trình duyệt để trống): thư viện gán MIME này theo đuôi file. */
export const LUT_MIME = 'application/x-cube';

/** Loại asset theo MIME của file người dùng chọn; null = không nhận. */
export function typeOfMime(mime: string): 'VIDEO' | 'IMAGE' | 'AUDIO' | 'TRANSCRIPT' | 'LUT' | null {
  if (mime === LUT_MIME) return 'LUT';
  if (mime === 'application/json' || mime === 'application/x-subrip' || mime === 'text/vtt') return 'TRANSCRIPT';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime.startsWith('audio/')) return 'AUDIO';
  return null;
}

/**
 * File `.json` là Lottie hay transcript: cùng MIME nên phải nhìn nội dung. Lottie
 * luôn có `v` (phiên bản), `fr` (khung/giây) và mảng `layers`; transcript thì
 * không có cả ba. Trả cỡ và độ dài để record có như ảnh/video.
 */
export function lottieInfo(text: string): { width: number; height: number; duration: number } | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const { v, fr, ip, op, w, h, layers } = json as Record<string, unknown>;
  if (typeof v !== 'string' || typeof fr !== 'number' || !(fr > 0) || !Array.isArray(layers)) return null;
  if (typeof w !== 'number' || typeof h !== 'number' || !(w > 0) || !(h > 0)) return null;
  const frames = (typeof op === 'number' ? op : 0) - (typeof ip === 'number' ? ip : 0);
  return { width: w, height: h, duration: Math.max(0, Math.round((frames / fr) * 1000) / 1000) };
}

// ------------------------------------------------------------------ danh tính

const SAMPLE = 1024 * 1024;

/**
 * Id của asset theo nội dung, CÙNG dạng với fork: sha256 của kích thước + đầu,
 * giữa, cuối file (mỗi đoạn 1 MB; file ≤ 3 MB thì cả file), cắt còn 16 ký tự
 * hex. Cùng file nhập ở editor nào cũng ra cùng id — thư viện không có hai bản.
 * Băm mẫu chứ không băm cả file: B-roll hàng GB mà nhập phải tức thì.
 */
export async function contentId(blob: Blob): Promise<string> {
  const size = blob.size;
  const parts: (string | Blob)[] = [String(size)];
  if (size <= SAMPLE * 3) parts.push(blob);
  else {
    const middle = Math.floor(size / 2 - SAMPLE / 2);
    parts.push(blob.slice(0, SAMPLE), blob.slice(middle, middle + SAMPLE), blob.slice(size - SAMPLE));
  }
  const digest = await crypto.subtle.digest('SHA-256', await new Blob(parts).arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
