/**
 * Luật settings của một revision, bản TypeScript.
 *
 * Bản gốc là `packages/contracts/revision-settings.schema.json`; bản Python là
 * `packages/engine/opencmo/editing/models.py::parse_settings`. Ba file đó phải
 * nói cùng một điều, và `settings-schema.check.ts` chạy cùng bộ fixture qua cả
 * hai bản cài đặt để chứng minh điều đó — không phải bằng niềm tin.
 *
 * Message lỗi là TIẾNG ANH và TRÙNG TỪNG CHỮ với `SettingsError` phía Python:
 * người dùng thấy cùng một câu dù lỗi bị bắt ở route handler hay ở worker.
 */
import { z } from "zod";

import schema from "../../../packages/contracts/revision-settings.schema.json";

/**
 * Đọc từ chính file schema thay vì gõ lại số 3 ở đây.
 *
 * Hash bọc số này vào payload, nên hai phía lệch phiên bản là hai phía ra hai
 * hash khác nhau cho cùng một settings — và việc khử trùng preview/export im
 * lặng mất tác dụng. Python đọc đúng khoá này trong `test_settings_contract.py`.
 */
export const RENDER_PROFILE_VERSION = schema["x-render-profile"] as number;

export const ASPECTS = ["9:16", "1:1", "16:9"] as const;
export const LAYOUTS = ["fill", "fit", "manual"] as const;
/**
 * Layout chọn lúc TẠO job. "auto" cố ý KHÔNG có trong `LAYOUTS`: nó nghĩa là
 * "cắt nếu dò được mặt, đệm nếu không", và câu đó chỉ trả lời được sau khi bám
 * mặt chạy — worker giải nó thành fill/fit trước khi ghi revision đầu tiên.
 */
export const JOB_LAYOUTS = ["auto", "fill", "fit"] as const;
/**
 * Khoá đã bỏ nhưng còn nằm trong settings gốc đã lưu (`clips.settings`): nhận rồi bỏ qua. Đọc từ
 * `x-legacy-keys` của schema, cùng danh sách với `LEGACY_KEYS` phía Python.
 */
const LEGACY_KEYS: ReadonlySet<string> = new Set(schema["x-legacy-keys"] as string[]);
const withoutLegacy = (input: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(input).filter(([key]) => !LEGACY_KEYS.has(key)));
export const FONTS = ["DejaVu Sans", "DejaVu Serif", "DejaVu Sans Mono"] as const;

const MIN_CLIP_SECONDS = 1;
const MAX_CLIP_SECONDS = 180;
// Nới cho sai số làm tròn của ffprobe/LLM ở mốc cuối video.
const END_SLACK = 0.001;

/** Web dùng uuid của `media_assets`; bản local dùng tên file trong workspace. */
const ASSET_ID =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+)$/;

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

// Kiểu ghi TRÊN biến, không chỉ trên hàm: TypeScript chỉ dùng `never` để thu
// hẹp kiểu sau lời gọi khi const có chú thích kiểu tường minh. Thiếu nó thì mọi
// `if (typeof x !== "boolean") fail(...)` bên dưới không thu hẹp được gì.
const fail: (message: string) => never = (message) => {
  throw new SettingsError(message);
};

/** `true` là `number` trong nhiều ngôn ngữ, nhưng không phải một mốc thời gian. */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Ký tự điều khiển phá cú pháp file .ass và không có nghĩa trên màn hình. */
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f]");

// ------------------------------------------------------------------- zod
//
// zod bắt hình dạng (khoá lạ, kiểu sai). Luật phụ thuộc giá trị khác nằm ở
// `parseSettings` bên dưới, y như phía Python — cả JSON Schema lẫn zod đều
// không diễn tả được "cut phải nằm trong khoảng nguồn của clip".

const textStyle = z
  .object({
    font: z.enum(FONTS),
    size: z.number(),
    color: z.string(),
    bold: z.boolean(),
    x: z.number(),
    y: z.number(),
  })
  .strict();

const textEdit = z
  .object({ start: z.number(), end: z.number(), text: z.string() })
  .strict();

const cut = z.object({ start: z.number(), end: z.number() }).strict();

const broll = z
  .object({
    asset_id: z.string(),
    at: z.number(),
    start: z.number(),
    end: z.number(),
  })
  .strict();

/** Style BẮT BUỘC — xem ghi chú ở `$defs.textLayer` của contract. */
const textLayer = z
  .object({
    text: z.string(),
    start: z.number(),
    end: z.number(),
    style: textStyle,
  })
  .strict();

export const revisionSettingsSchema = z
  .object({
    source_start: z.number(),
    source_end: z.number(),
    aspect: z.enum(ASPECTS).optional(),
    layout: z.enum(LAYOUTS).optional(),
    focus_x: z.number().nullable().optional(),
    captions: z.boolean().optional(),
    caption_preset: z.unknown().optional(),
    headline: z.string().optional(),
    texts: z.array(textLayer).optional(),
    text_edits: z.array(textEdit).optional(),
    cuts: z.array(cut).optional(),
    broll: z.array(broll).optional(),
    caption_style: textStyle.optional(),
    headline_style: textStyle.optional(),
  })
  .strict();

export type TextStyle = z.infer<typeof textStyle>;
export type TextEdit = z.infer<typeof textEdit>;
export type VideoCut = z.infer<typeof cut>;
export type TextLayer = z.infer<typeof textLayer>;
export type BRoll = z.infer<typeof broll>;

export type RevisionSettings = {
  source_start: number;
  source_end: number;
  aspect: (typeof ASPECTS)[number];
  layout: (typeof LAYOUTS)[number];
  focus_x: number | null;
  captions: boolean;
  headline: string;
  texts?: TextLayer[];
  text_edits: TextEdit[];
  cuts?: VideoCut[];
  broll?: BRoll[];
  caption_style?: TextStyle;
  headline_style?: TextStyle;
};

const KEYS: ReadonlySet<string> = new Set([
  "source_start",
  "source_end",
  "aspect",
  "layout",
  "focus_x",
  "captions",
  "headline",
  "texts",
  "text_edits",
  "cuts",
  "broll",
  "caption_style",
  "headline_style",
]);

function parseTextStyle(raw: unknown): TextStyle {
  const shaped =
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    ["font", "size", "color", "bold", "x", "y"].every((key) => key in raw) &&
    Object.keys(raw).length === 6;
  if (!shaped) fail("Text style needs font, size, color, bold and position.");

  const loose = raw as Record<string, unknown>;
  if (!(FONTS as readonly unknown[]).includes(loose.font)) fail("Choose a supported font.");
  if (!isFiniteNumber(loose.size) || !(loose.size >= 24 && loose.size <= 160)) {
    fail("Font size must be between 24 and 160.");
  }
  if (
    typeof loose.bold !== "boolean" ||
    typeof loose.color !== "string" ||
    !/^#[0-9a-fA-F]{6}$/.test(loose.color)
  ) {
    fail("Choose a valid text color and weight.");
  }
  for (const key of ["x", "y"] as const) {
    const value = loose[key];
    if (!isFiniteNumber(value) || !(value >= 0.08 && value <= 0.92)) {
      fail("Keep text inside the canvas safe area.");
    }
  }
  return textStyle.parse(raw);
}

/**
 * Kiểm và chuẩn hoá settings do client gửi.
 *
 * Khoá lạ bị TỪ CHỐI chứ không bỏ qua: không có đường nào để client lén đưa một
 * đường dẫn file hay URL vào revision.
 */
export function parseSettings(raw: unknown, sourceDuration: number): RevisionSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("Clip settings must be an object.");
  }
  const input = withoutLegacy(raw as Record<string, unknown>);

  const unknown = Object.keys(input)
    .filter((key) => !KEYS.has(key))
    .sort();
  if (unknown.length > 0) {
    fail(`Unknown clip setting: ${String(unknown[0]).slice(0, 40)}.`);
  }

  const time = (value: unknown): number => {
    if (!isFiniteNumber(value)) fail("Clip times must be finite numbers.");
    return value as number;
  };

  const start = time(input.source_start);
  const end = time(input.source_end);
  if (!(start >= 0 && start < end && end <= sourceDuration + END_SLACK)) {
    fail("Clip start and end must be inside the source video.");
  }
  if (!(end - start >= MIN_CLIP_SECONDS && end - start <= MAX_CLIP_SECONDS)) {
    fail("Clips must be between 1 and 180 seconds long.");
  }

  const aspect = input.aspect === undefined ? "9:16" : input.aspect;
  if (!(ASPECTS as readonly unknown[]).includes(aspect)) fail("Unsupported aspect ratio.");
  const layout = input.layout === undefined ? "fill" : input.layout;
  if (!(LAYOUTS as readonly unknown[]).includes(layout)) fail("Unsupported frame layout.");

  const focusRaw = input.focus_x === undefined ? null : input.focus_x;
  if (focusRaw !== null && !(isFiniteNumber(focusRaw) && focusRaw >= 0 && focusRaw <= 1)) {
    fail("The focus point must be inside the frame.");
  }
  const focus = focusRaw as number | null;
  if (layout === "manual" && focus === null) fail("Pick a focus point for manual framing.");

  const captions = input.captions === undefined ? true : input.captions;
  if (typeof captions !== "boolean") fail("Captions must be on or off.");


  const headlineRaw = input.headline === undefined ? "" : input.headline;
  if (typeof headlineRaw !== "string" || headlineRaw.length > 120) {
    fail("Keep the headline under 120 characters.");
  }
  const headline = headlineRaw as string;
  if (CONTROL.test(headline)) fail("Text cannot contain control characters.");

  const editsRaw = input.text_edits === undefined ? [] : input.text_edits;
  if (!Array.isArray(editsRaw) || editsRaw.length > 2000) fail("Too many caption edits.");
  const edits: TextEdit[] = [];
  for (const item of editsRaw as unknown[]) {
    const shaped =
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      ["start", "end", "text"].every((key) => key in item) &&
      Object.keys(item).length === 3;
    if (!shaped) fail("Each caption edit needs a start, an end and text.");
    const loose = item as Record<string, unknown>;
    const editStart = time(loose.start);
    const editEnd = time(loose.end);
    if (!(editStart >= 0 && editStart < editEnd && editEnd <= sourceDuration + END_SLACK)) {
      fail("Each caption edit must be inside the source video.");
    }
    if (typeof loose.text !== "string" || loose.text.length > 500) {
      fail("Keep each caption edit under 500 characters.");
    }
    const text = loose.text as string;
    if (CONTROL.test(text)) fail("Text cannot contain control characters.");
    edits.push({ start: editStart, end: editEnd, text });
  }
  // Thứ tự ổn định: hai revision chỉ khác thứ tự edit phải có cùng một hash.
  edits.sort((a, b) => a.start - b.start || a.end - b.end);

  const cutsRaw = input.cuts === undefined ? [] : input.cuts;
  if (!Array.isArray(cutsRaw) || cutsRaw.length > 40) fail("Use at most 40 video sections.");
  const cuts: VideoCut[] = [];
  for (const item of cutsRaw as unknown[]) {
    const shaped =
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      ["start", "end"].every((key) => key in item) &&
      Object.keys(item).length === 2;
    if (!shaped) fail("Each section needs a start and end.");
    const section = item as { start: unknown; end: unknown };
    const cutStart = time(section.start);
    const cutEnd = time(section.end);
    if (!(start <= cutStart && cutStart < cutEnd && cutEnd <= end)) {
      fail("Sections must stay inside the clip source range.");
    }
    if (cutEnd - cutStart < 0.1) {
      fail("Each section must last at least 0.1 seconds.");
    }
    cuts.push({ start: cutStart, end: cutEnd });
  }

  const duration =
    cuts.length > 0 ? cuts.reduce((total, c) => total + (c.end - c.start), 0) : end - start;
  if (!(duration >= 1 && duration <= 180)) {
    fail("The timeline must be between 1 and 180 seconds long.");
  }

  // Lớp chữ. Phải đứng SAU `duration` vì mốc của chúng tính trên timeline.
  const textsRaw = input.texts === undefined ? [] : input.texts;
  if (!Array.isArray(textsRaw) || textsRaw.length > 10) fail("Use at most 10 text layers.");
  if (textsRaw.length > 0 && headline) {
    fail("Use either a headline or text layers, not both.");
  }
  const texts: TextLayer[] = [];
  for (const item of textsRaw as unknown[]) {
    const shaped =
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      ["text", "start", "end", "style"].every((key) => key in item) &&
      Object.keys(item).length === 4;
    if (!shaped) fail("Invalid text layer.");
    const loose = item as Record<string, unknown>;
    if (typeof loose.text !== "string" || loose.text.length > 120) {
      fail("Keep each text under 120 characters.");
    }
    const body = (loose.text as string).trim();
    if (CONTROL.test(loose.text as string)) fail("Text cannot contain control characters.");
    if (!body) fail("A text layer cannot be empty.");
    const layerStart = time(loose.start);
    const layerEnd = time(loose.end);
    if (
      !(layerStart >= 0 && layerStart < layerEnd) ||
      layerEnd - layerStart < 0.1 ||
      layerEnd > duration + 0.001
    ) {
      fail("Text must stay inside the timeline.");
    }
    texts.push({
      text: body,
      start: layerStart,
      end: layerEnd,
      style: parseTextStyle(loose.style) as TextStyle,
    });
  }

  const brollRaw = input.broll === undefined ? [] : input.broll;
  if (!Array.isArray(brollRaw) || brollRaw.length > 20) fail("Use at most 20 B-roll sections.");
  const layers: BRoll[] = [];
  for (const item of brollRaw as unknown[]) {
    const shaped =
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      ["asset_id", "at", "start", "end"].every((key) => key in item) &&
      Object.keys(item).length === 4;
    if (!shaped) fail("Invalid B-roll section.");
    const loose = item as Record<string, unknown>;
    if (typeof loose.asset_id !== "string" || !ASSET_ID.test(loose.asset_id)) {
      fail("Invalid media ID.");
    }
    const layerStart = time(loose.start);
    const layerEnd = time(loose.end);
    const at = time(loose.at);
    const length = layerEnd - layerStart;
    if (
      !(layerStart >= 0 && layerStart < layerEnd) ||
      length < 0.1 ||
      !(at >= 0 && at + length <= duration + 0.001)
    ) {
      fail("B-roll must stay inside the timeline.");
    }
    layers.push({ asset_id: loose.asset_id as string, at, start: layerStart, end: layerEnd });
  }

  const settings: RevisionSettings = {
    source_start: start,
    source_end: end,
    aspect: aspect as RevisionSettings["aspect"],
    layout: layout as RevisionSettings["layout"],
    focus_x: focus,
    captions,
    headline,
    text_edits: edits,
  };
  // Khoá rỗng bị BỎ HẲN, không lưu `[]`: phía Python `to_dict()` cũng bỏ, và hai
  // bên phải ra cùng một object thì mới ra cùng một hash.
  // KHÔNG sort `texts`: thứ tự là thứ tự vẽ.
  if (texts.length > 0) settings.texts = texts;
  if (cuts.length > 0) settings.cuts = cuts;
  if (layers.length > 0) settings.broll = layers;
  if (input.caption_style !== undefined) {
    settings.caption_style = parseTextStyle(input.caption_style);
  }
  if (input.headline_style !== undefined) {
    settings.headline_style = parseTextStyle(input.headline_style);
  }
  return settings;
}

// ------------------------------------------------------------------ hash

/**
 * Một số theo đúng `Number::toString` của ECMAScript.
 *
 * Ở TypeScript đây chính là `String(value)` — đó là định nghĩa. Hàm vẫn có tên
 * riêng để khớp với phía Python, nơi cùng việc này dài 20 dòng vì `repr()` in
 * `2.0` thay vì `2` và đổi sang ký hiệu mũ ở một ngưỡng khác.
 */
function jsNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new SettingsError("Clip settings contain a value that cannot be saved.");
  }
  return Object.is(value, -0) ? "0" : String(value);
}

/**
 * JSON chuẩn hoá theo RFC 8785 (JCS) — đầu vào của hàm băm.
 *
 * `JSON.stringify` KHÔNG dùng được: nó giữ thứ tự khoá theo lúc chèn, nên hai
 * object cùng nội dung mà khác thứ tự ra hai chuỗi khác nhau. Sắp khoá bằng so
 * sánh `<` của JavaScript là so theo đơn vị mã UTF-16, đúng thứ tự JCS yêu cầu.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return jsNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new SettingsError("Clip settings contain a value that cannot be saved.");
}

/**
 * Vân tay nội dung của một revision.
 *
 * Dùng để khử trùng preview và export: cùng hash nghĩa là cùng một file sẽ ra,
 * nên không render lại. Vì thế nó PHẢI trùng từng ký tự với bản Python —
 * fixture ở `tests/contracts/settings/hash/` ghim từng cặp.
 */
export async function settingsHash(settings: unknown): Promise<string> {
  const payload = canonicalJson({
    render_profile: RENDER_PROFILE_VERSION,
    settings,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
