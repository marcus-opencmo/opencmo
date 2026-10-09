/**
 * Media cho `clip-render` trong trình duyệt (spec editor-rewrite §4, B2).
 *
 * Renderer vẽ đồng bộ và không tự tải gì; lớp này trả lời `MediaHost` bằng thứ
 * đã có sẵn và tải phần còn thiếu ở nền, rồi gọi `onChange` để canvas vẽ lại.
 *
 * Video là MỘT thẻ `<video>` cho mỗi nguồn, không phải giải mã từng khung như
 * export: preview cần mượt hơn cần đúng từng khung, và file xuất do server vẽ
 * (§7) nên preview lệch một khung không bao giờ lọt vào sản phẩm. Hai đoạn
 * cùng nguồn hiện CÙNG LÚC (chuyển cảnh giữa hai đoạn cắt của master) thì dùng
 * chung khung của thẻ — ghi ở checklist như một khác biệt của preview.
 *
 * `el.width/height` được đặt bằng cỡ thật của video: renderer đọc `width/height`
 * của thứ nó vẽ để tính cover/contain, còn thuộc tính đó của thẻ video mặc định
 * là 0. Thẻ không gắn vào DOM nên đặt vậy không đụng layout nào.
 */

import type { AssetInput, ClipDocument } from "@opencmo/clip-doc";
import { FONTS, mediaSources, parseCube, readTranscriptText, type CubeLut, type MediaHost, type MediaResult, type Transcript } from "@opencmo/clip-render";
import { BRAND_SRC_PREFIX } from "@opencmo/editor-core";

import { watchFrames } from "./frames";
import { readLocal } from "./library/store";
import { builtinLottieUrl, LottieFrames } from "./lottie";

export type EditorMedia = {
  project_id: string;
  /** Null với New edit (F1): không có video người nói, mọi media đến từ thư viện. */
  master: { url: string; width: number; height: number; duration: number; offset: number } | null;
  transcript: string | null;
};

export type ManifestRecord = {
  id?: string;
  path?: string;
  source?: string;
  type?: string;
  mimeType?: string;
  createdAt?: string;
  width?: number;
  height?: number;
  duration?: number;
  error?: string;
  state?: string;
  generation?: { key?: string };
  cloud?: { state?: string; mediaId?: string };
};

export type Manifest = { version?: number; folders?: string[]; assets?: ManifestRecord[] } | null;

const MASTER = "assets/master.mp4";
const TRANSCRIPT = "assets/transcript.json";
const EDITED = /^assets\/transcripts\/([0-9a-f]{64})\.json$/;
/** Cùng bộ trường với `_SPEC_FIELDS` của worker export: hai bên phải chọn cùng một file. */
const SPEC_FIELDS = ["aspectRatio", "duration", "seed", "voice", "scene", "resolution", "audio", "startFrame", "endFrame", "refs", "sourceVideo", "sourceStart"] as const;

/** So sâu, không phụ thuộc thứ tự khoá (`scene` là object) — như `==` của Python. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  return keysA.length === keysB.length && keysA.every((key) => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export const keyOf = (src: AssetInput): string => (typeof src === "string" ? src : JSON.stringify(src));

/**
 * Khoá thẻ media của một node `audio`. Thẻ riêng với thẻ video cùng nguồn: J/L-cut
 * tách tiếng master thành đoạn `audio` lệch giờ so với hình, và một thẻ không thể
 * vừa tua tới giây của hình vừa phát giây của tiếng (preview vẽ sai hình trong khoảng chồng).
 */
export const audioKeyOf = (src: AssetInput): string => `${keyOf(src)}#audio`;

/** Khoá thẻ theo loại node phát nó. */
export const mediaKeyOf = (src: AssetInput, kind: string): string => (kind === "audio" ? audioKeyOf(src) : keyOf(src));

/** Asset sinh bằng AI khớp khai báo `{generate}` khi mọi trường khai báo đều trùng. */
export function generationMatches(declaration: Record<string, unknown>, record: ManifestRecord): boolean {
  let key: { type?: unknown; model?: unknown; spec?: Record<string, unknown> };
  try {
    key = JSON.parse(record.generation?.key ?? "");
  } catch {
    return false;
  }
  if (!key || typeof key !== "object") return false;
  const spec = key.spec ?? {};
  if (key.type !== declaration.generate || spec.prompt !== declaration.prompt) return false;
  if ("model" in declaration && key.model !== declaration.model) return false;
  return SPEC_FIELDS.every((name) => !(name in declaration) || sameValue(spec[name], declaration[name]));
}

export function libraryRecord(manifest: Manifest, src: AssetInput): ManifestRecord | null {
  for (const record of manifest?.assets ?? []) {
    if (!record || typeof record !== "object" || record.state === "pending" || record.state === "error") continue;
    // `src` là đường dẫn thư viện (`path`), như fork viết khi chèn; `source` là
    // chỗ bytes nằm — document cũ có thể trỏ thẳng vào nó.
    if (typeof src === "string" && (record.path === src || record.source === src)) return record;
    if (typeof src === "object" && src && "generate" in src && generationMatches(src as Record<string, unknown>, record)) {
      return record;
    }
  }
  return null;
}

/** Nạp 10 họ font của phụ đề/chữ. File nằm cạnh bundle của fork tới C3 (`clip-render/fonts.ts`). */
let fontsReady: Promise<void> | null = null;
export function loadFonts(): Promise<void> {
  fontsReady ??= Promise.all(
    Object.entries(FONTS).flatMap(([family, entry]) =>
      [
        [entry.file, "normal"],
        ["italic" in entry ? entry.italic : null, "italic"],
      ]
        .filter((pair): pair is [string, string] => pair[0] !== null)
        .map(async ([file, style]) => {
          const face = new FontFace(family, `url(/fonts/${file})`, {
            weight: `${entry.weights[0]} ${entry.weights[1]}`,
            style,
          });
          document.fonts.add(await face.load());
        }),
    ),
  ).then(
    () => undefined,
    (error) => console.warn("[editor] font load failed", error),
  );
  return fontsReady;
}

type Element = {
  el: HTMLMediaElement;
  ready: boolean;
  failed: boolean;
  /** Xong (có khung, hoặc hỏng/không có nguồn) — `preload` chờ cái này. */
  settled: Promise<void>;
  settle: () => void;
  duration: number | null;
  gain: GainNode | null;
  /** Lần cuối ký lại URL cho thẻ này (ms) — chặn vòng lặp khi file hỏng thật. */
  recoveredAt: number;
};

/** Ký lại URL tối đa một lần mỗi phút cho mỗi thẻ; lỗi lần hai trong phút đó là hỏng thật. */
const RECOVER_EVERY_MS = 60_000;

export class BrowserMedia implements MediaHost {
  private manifest: Manifest = null;
  private libraryUrls: Promise<Map<string, string>> | null = null;
  private localUrls = new Map<string, string>();
  private elements = new Map<string, Element>();
  private images = new Map<string, ImageBitmap | "failed" | "loading">();
  private transcripts = new Map<string, Transcript | "failed" | "loading">();
  private luts = new Map<string, CubeLut | "failed" | "loading">();
  private audio: AudioContext | null = null;
  private lottieFrames = new LottieFrames(
    async (src) => {
      const builtin = builtinLottieUrl(src);
      if (builtin) {
        const response = await fetch(builtin).catch(() => null);
        return response?.ok ? response.text() : null;
      }
      return (await this.bytesOf(src))?.text() ?? null;
    },
    () => this.onChange(),
  );
  private refreshing: Promise<void> | null = null;
  /** Đang phát thì thẻ video tự chạy; dừng thì mỗi lượt vẽ tua thẻ về đúng giây. */
  playing = false;
  /**
   * Tăng mỗi khi biết thêm độ dài hay transcript: renderer đọc hai thứ đó lúc
   * DỰNG cây, nên canvas phải dựng lại renderer chứ không chỉ vẽ lại.
   */
  generation = 0;

  constructor(
    private clipId: string,
    private media: EditorMedia,
    private onChange: () => void,
  ) {}

  setManifest(manifest: Manifest): void {
    if (manifest === this.manifest) return;
    this.manifest = manifest;
    this.retryMissing();
  }

  /**
   * Bỏ các nguồn đã hỏng để lượt vẽ sau thử lại. Gọi khi thư viện đổi hoặc khi
   * bytes vừa được ghi vào OPFS (nhập lại một file đã có record): nguồn trước đó
   * không có bytes giờ có thể có, thay vì giữ lớp trống tới khi tải lại trang.
   */
  retryMissing(): void {
    let retry = false;
    for (const [key, value] of this.images) if (value === "failed") (this.images.delete(key), (retry = true));
    for (const [key, value] of this.luts) if (value === "failed") (this.luts.delete(key), (retry = true));
    for (const [key, value] of this.transcripts) if (value === "failed") (this.transcripts.delete(key), (retry = true));
    if (this.lottieFrames.retryFailed()) retry = true;
    for (const [key, entry] of this.elements) {
      if (!entry.failed) continue;
      entry.el.removeAttribute("src");
      this.elements.delete(key);
      retry = true;
    }
    if (retry) {
      this.generation++;
      this.onChange();
    }
  }

  // ------------------------------------------------------------ MediaHost

  image(src: AssetInput): MediaResult {
    const key = keyOf(src);
    const found = this.images.get(key);
    if (found === undefined) void this.loadImage(src);
    return found === undefined || found === "loading" ? null : found;
  }

  video(src: AssetInput, seconds: number): MediaResult {
    const entry = this.element(src, "video");
    if (entry.failed) return "failed";
    if (!entry.ready) return null;
    const el = entry.el;
    // Không tua giữa lúc phát: thẻ đang chạy theo đồng hồ của `Playback`.
    if (!this.playing && !el.seeking && Math.abs(el.currentTime - seconds) > 1 / 120) {
      el.currentTime = seconds + 0.001;
    }
    return el as HTMLVideoElement;
  }

  lottie(src: AssetInput, seconds: number, width: number, height: number, loop: boolean): MediaResult {
    return this.lottieFrames.frame(src, seconds, width, height, loop);
  }

  duration(src: AssetInput): number | null {
    return (this.elements.get(keyOf(src)) ?? this.elements.get(audioKeyOf(src)))?.duration ?? null;
  }

  lut(src: string): CubeLut | null | "failed" {
    const found = this.luts.get(src);
    if (found === undefined) void this.loadLut(src);
    return found === undefined || found === "loading" ? null : found;
  }

  transcript(src: string): Transcript | null {
    const found = this.transcripts.get(src);
    if (found === undefined) void this.loadTranscript(src);
    return found === undefined || found === "loading" || found === "failed" ? null : found;
  }

  /** Trạng thái nạp của một transcript — để timeline nói lý do phụ đề trống thay vì để khung trống. */
  transcriptStatus(src: string): "loading" | "failed" | "ready" {
    const found = this.transcripts.get(src);
    return found === "failed" ? "failed" : found === undefined || found === "loading" ? "loading" : "ready";
  }

  // ------------------------------------------------------------ nạp trước

  /** Độ dài mọi nguồn và mọi transcript — renderer cần chúng lúc dựng cây. */
  async preload(document: ClipDocument): Promise<void> {
    await Promise.all(
      mediaSources(document).map(async ({ kind, src }) => {
        if (kind === "transcript") return typeof src === "string" ? this.loadTranscript(src) : undefined;
        if (kind === "image") return this.loadImage(src);
        if (kind === "lut") return typeof src === "string" ? this.loadLut(src) : undefined;
        // Lottie nạp khi renderer xin khung đầu (không chặn dựng cây: độ dài
        // node lottie không phụ thuộc file).
        if (kind === "lottie") return undefined;
        const entry = this.element(src, kind);
        await this.whenReady(entry);
      }),
    );
  }

  /** Thẻ media của một nguồn, để `Playback` điều khiển phát và tiếng. */
  elementFor(src: AssetInput): Element | undefined {
    return this.elements.get(keyOf(src)) ?? this.elements.get(audioKeyOf(src));
  }

  entries(): IterableIterator<[string, Element]> {
    return this.elements.entries();
  }

  /** AudioContext tạo trong cú bấm Play: trình duyệt chặn tiếng trước cử chỉ đầu tiên. */
  audioContext(): AudioContext {
    this.audio ??= new AudioContext();
    for (const entry of this.elements.values()) this.route(entry);
    return this.audio;
  }

  dispose(): void {
    for (const entry of this.elements.values()) {
      entry.el.pause();
      entry.el.removeAttribute("src");
      entry.el.load();
    }
    this.elements.clear();
    for (const image of this.images.values()) if (typeof image === "object") image.close();
    this.lottieFrames.dispose();
    for (const url of this.localUrls.values()) URL.revokeObjectURL(url);
    void this.audio?.close();
  }

  // ------------------------------------------------------------ nội bộ

  private element(src: AssetInput, kind: "video" | "audio"): Element {
    const key = mediaKeyOf(src, kind);
    let entry = this.elements.get(key);
    if (entry) return entry;
    const el = document.createElement(kind);
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    if (el instanceof HTMLVideoElement) el.playsInline = true;
    el.preservesPitch = true;
    let settle = () => {};
    const settled = new Promise<void>((resolve) => (settle = resolve));
    entry = { el, ready: false, failed: false, duration: null, gain: null, settled, settle, recoveredAt: 0 };
    this.elements.set(key, entry);
    const current = entry;
    el.addEventListener("loadeddata", () => {
      if (el instanceof HTMLVideoElement) {
        el.width = el.videoWidth;
        el.height = el.videoHeight;
      }
      current.duration = Number.isFinite(el.duration) ? el.duration : null;
      current.ready = true;
      this.generation++;
      current.settle();
      this.onChange();
    });
    el.addEventListener("seeked", () => this.onChange());
    // Safari: frame mới có thể hiện SAU `seeked` — vẽ lại khi nó thật sự hiện.
    if (el instanceof HTMLVideoElement) watchFrames(el, () => this.onChange());
    el.addEventListener("error", () => {
      if (this.recover(src, current)) return;
      current.failed = true;
      current.settle();
      this.onChange();
    });
    if (this.audio) this.route(entry);
    void this.urlOf(src).then(
      (url) => {
        if (url) el.src = url;
        else {
          // Không có bytes ở đâu cả (ảnh/âm thanh chỉ nằm ở máy đã nhập nó):
          // không có sự kiện `error` nào sẽ tới, nên tự báo xong.
          current.failed = true;
          current.settle();
          this.onChange();
        }
      },
      () => {
        current.failed = true;
        current.settle();
        this.onChange();
      },
    );
    return entry;
  }

  /**
   * URL ký của master/thư viện hết hạn sau một giờ: range request kế tiếp trả
   * 403 và thẻ báo `error`. Ký lại rồi nạp lại đúng giây đang đứng, thay vì để
   * preview đen im lặng tới khi người dùng tải lại trang. True: đang thử lại.
   */
  private recover(src: AssetInput, entry: Element): boolean {
    const el = entry.el;
    if (!el.src || el.src.startsWith("blob:")) return false;
    const now = Date.now();
    if (now - entry.recoveredAt < RECOVER_EVERY_MS) return false;
    entry.recoveredAt = now;
    const at = el.currentTime;
    entry.ready = false;
    this.onChange();
    const fail = () => {
      entry.failed = true;
      entry.settle();
      this.onChange();
    };
    void this.refreshUrls()
      .then(() => this.urlOf(src))
      .then((url) => {
        if (!url) return fail();
        el.addEventListener(
          "loadedmetadata",
          () => {
            if (at > 0) el.currentTime = at;
            // Nạp lại làm thẻ dừng; đang phát thì phát tiếp theo đồng hồ của `Playback`.
            if (this.playing) void el.play().catch(() => {});
          },
          { once: true },
        );
        el.src = url;
        el.load();
      }, fail);
    return true;
  }

  /** Một lượt `?refresh=media` dùng chung cho mọi thẻ hỏng cùng lúc. */
  private refreshUrls(): Promise<void> {
    this.refreshing ??= fetch(
      `/api/v1/editor/project?clip_id=${encodeURIComponent(this.clipId)}&refresh=media`,
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`refresh media: ${response.status}`);
        const body = (await response.json()) as { media: EditorMedia };
        this.media = body.media;
        this.libraryUrls = null;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private route(entry: Element): void {
    if (!this.audio || entry.gain) return;
    const gain = this.audio.createGain();
    gain.gain.value = 0;
    this.audio.createMediaElementSource(entry.el).connect(gain).connect(this.audio.destination);
    entry.gain = gain;
  }

  private whenReady(entry: Element): Promise<void> {
    return entry.settled;
  }

  private async loadImage(src: AssetInput): Promise<void> {
    const key = keyOf(src);
    if (this.images.has(key)) return;
    this.images.set(key, "loading");
    try {
      const blob = await this.bytesOf(src);
      if (!blob) throw new Error("missing");
      this.images.set(key, await createImageBitmap(blob));
    } catch {
      this.images.set(key, "failed");
    }
    this.onChange();
  }

  /** LUT `.cube` của thư viện (E3-c): đọc chữ rồi `parseCube`; hỏng thì vẽ như không có LUT. */
  private async loadLut(src: string): Promise<void> {
    if (this.luts.has(src)) return;
    this.luts.set(src, "loading");
    try {
      const blob = await this.bytesOf(src);
      if (!blob) throw new Error("missing");
      this.luts.set(src, parseCube(await blob.text()));
    } catch {
      this.luts.set(src, "failed");
    }
    this.onChange();
  }

  /** Đọc và giải một transcript — cũng là `readTranscript` của op (panel Transcript). */
  async readTranscript(src: string): Promise<Transcript> {
    const blob = await this.bytesOf(src);
    if (!blob) throw new Error("The captions file could not be loaded.");
    // Transcript trong thư viện có thể là .srt/.vtt (CAP-10); còn lại là JSON.
    const mime = libraryRecord(this.manifest, src)?.mimeType;
    return readTranscriptText(await blob.text(), typeof mime === "string" ? mime : "application/json");
  }

  private async loadTranscript(src: string): Promise<void> {
    if (this.transcripts.has(src)) return;
    this.transcripts.set(src, "loading");
    try {
      this.transcripts.set(src, await this.readTranscript(src));
    } catch {
      this.transcripts.set(src, "failed");
    }
    this.generation++;
    this.onChange();
  }

  /** Đường dẫn trong document → URL tải được. Null: nguồn không còn ở đâu cả. */
  /**
   * Bytes của một nguồn: file trong OPFS nếu máy này có, không thì tải từ URL.
   * Không `fetch` một URL `blob:` — CSP của app không mở `connect-src blob:`,
   * và cũng chẳng cần: File đã nằm sẵn đây.
   */
  async bytesOf(src: AssetInput): Promise<Blob | null> {
    const record = libraryRecord(this.manifest, src);
    if (record && typeof record.source === "string") {
      const local = await readLocal(this.clipId, record.source);
      if (local) return local;
    }
    const url = await this.urlOf(src);
    if (!url) return null;
    const response = await fetch(url).catch(() => null);
    return response?.ok ? response.blob() : null;
  }

  async urlOf(src: AssetInput): Promise<string | null> {
    if (src === MASTER) return this.media.master?.url ?? null;
    if (src === TRANSCRIPT) return this.media.transcript;
    if (typeof src === "string") {
      const edited = EDITED.exec(src);
      if (edited) return `/api/v1/editor/transcript?clip_id=${encodeURIComponent(this.clipId)}&hash=${edited[1]}`;
      // Logo của Brand Kit: bucket `brand`, không nằm trong thư viện của clip.
      if (src.startsWith(BRAND_SRC_PREFIX)) return `/api/v1/brand-kits/logo?object=${encodeURIComponent(src.slice(BRAND_SRC_PREFIX.length))}`;
    }
    const record = libraryRecord(this.manifest, src);
    if (!record) return null;
    // Bytes trên máy này (OPFS, cùng bố cục với fork) trước — nhanh, và là chỗ
    // DUY NHẤT có ảnh/âm thanh vì bucket `media` chỉ giữ video.
    if (typeof record.source === "string") {
      // Khoá theo id (băm nội dung) + source: project cũ có hai record chung một
      // `source` (bytes bị ghi đè) thì blob URL của bản cũ không được dùng lại.
      const cacheKey = `${String(record.id)}:${record.source}`;
      const cached = this.localUrls.get(cacheKey);
      if (cached) return cached;
      const local = await readLocal(this.clipId, record.source);
      if (local) {
        const url = URL.createObjectURL(local);
        this.localUrls.set(cacheKey, url);
        return url;
      }
    }
    const mediaId = record.cloud?.mediaId;
    if (!mediaId) return null;
    const list = () =>
      fetch(`/api/v1/projects/${encodeURIComponent(this.media.project_id)}/media`)
        .then((response) => (response.ok ? (response.json() as Promise<{ id: string; url: string | null }[]>) : []))
        .then((rows) => new Map(rows.filter((row) => row.url).map((row) => [row.id, row.url as string])));
    this.libraryUrls ??= list();
    let url = (await this.libraryUrls).get(mediaId);
    // Asset lên Storage sau lượt đọc danh sách trước: đọc lại một lần.
    if (!url) {
      this.libraryUrls = list();
      url = (await this.libraryUrls).get(mediaId);
    }
    return url ?? null;
  }
}
