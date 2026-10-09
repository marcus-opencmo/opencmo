/**
 * Tool của Assistant, phạm vi một clip (spec AI Studio §6.5, spec agent-editor §4).
 *
 * Tool đọc chạy trên `AgentWorkspace`; mọi tool ghi là op của
 * `@opencmo/editor-core` qua `workspace.apply` — cùng đường với nút bấm và
 * route ops, cùng CAS, cùng checkpoint. Không có tool ghi document thô.
 *
 * Schema tool sinh từ schema op (`AGENT_OP_INPUTS`), bỏ trường `op`. Ràng buộc
 * số (min/max, độ dài, regex) bị gỡ khỏi bản gửi API — strict tool use không
 * nhận hết chúng — nhưng vẫn được zod kiểm lại ở đây trước khi chạy, vì eager
 * input streaming nghĩa là API KHÔNG kiểm input nữa.
 *
 * Mô tả tool bằng tiếng Anh: model đọc, người dùng không thấy.
 */

import { z } from "zod";

import { MAX_CODE_CHARS, THEMES } from "@opencmo/clip-three";
import type { ClipDocument } from "@opencmo/clip-doc";
import { findIcons } from "@opencmo/clip-icons";
import {
  AGENT_OP_INPUTS,
  MASTER_SRC,
  OP_INPUTS,
  OpError,
  byId,
  checkDocument,
  describeOp,
  diffDocuments,
  findLotties,
  findSilences,
  isRemoved,
  loadCaptions,
  quoteRange,
  readMarkers,
  searchSpoken,
  summarizeProject,
  cutPoints,
  walk,
  type CheckReport,
  type Op,
  type Transcript,
} from "@opencmo/editor-core";

import { ApiError } from "@/lib/api/errors";
import { nodeFor } from "@/lib/editor/asset-node";

import { GUIDE_NAMES, readGuide } from "./guides";
import type { AgentWorkspace } from "./workspace";

/** Một tool ở dạng trung lập: provider nào cũng dựng tool definition của mình từ đây. */
export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema đã gỡ ràng buộc mà strict/function calling không nhận. */
  schema: Record<string, unknown>;
  /** Object khoá tự do (props của update_element) không hợp với strict. */
  strict: boolean;
  /** Chạy ở trình duyệt: lượt tạm dừng chờ editor trả kết quả. */
  browser?: boolean;
  /** Cần người duyệt trước khi chạy: lượt tạm dừng chờ Approve/Cancel. */
  approval?: boolean;
  /** Hỏi người dùng: lượt tạm dừng chờ câu trả lời. */
  input?: boolean;
};

/** Từ khoá JSON Schema giữ lại khi gửi API. Còn lại (min/max, pattern…) zod kiểm. */
const KEEP = new Set(["type", "properties", "required", "items", "enum", "const", "anyOf", "description", "additionalProperties"]);

/** Gỡ ràng buộc strict không nhận; trả `open: true` khi có object khoá tự do (record). */
export function sanitize(schema: unknown): { schema: unknown; open: boolean } {
  if (Array.isArray(schema)) {
    let open = false;
    const out = schema.map((item) => {
      const next = sanitize(item);
      open ||= next.open;
      return next.schema;
    });
    return { schema: out, open };
  }
  if (!schema || typeof schema !== "object") return { schema, open: false };
  let open = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!KEEP.has(key)) continue;
    if (key === "properties") {
      const props: Record<string, unknown> = {};
      for (const [name, prop] of Object.entries(value as Record<string, unknown>)) {
        const next = sanitize(prop);
        open ||= next.open;
        props[name] = next.schema;
      }
      out.properties = props;
    } else if (key === "additionalProperties" && typeof value === "object") {
      open = true;
      out.additionalProperties = sanitize(value).schema;
    } else {
      const next = sanitize(value);
      open ||= next.open;
      out[key] = next.schema;
    }
  }
  if (out.type === "object" && out.additionalProperties === undefined) out.additionalProperties = false;
  return { schema: out, open };
}

const jsonSchema = (input: z.ZodType) => sanitize(z.toJSONSchema(input, { io: "input", unrepresentable: "any" }));

export function spec(name: string, description: string, input: z.ZodType, extra: Partial<ToolSpec> = {}): ToolSpec {
  const { schema, open } = jsonSchema(input);
  return { name, description, schema: schema as Record<string, unknown>, strict: !open, ...extra };
}

// ------------------------------------------------------------------ đầu vào

export const documentInput = z.object({
  node_id: z.string().max(64).optional().describe("Only this element and what is inside it. Omit for the whole project."),
});
export const silencesInput = z.object({
  min_gap: z.number().min(0.1).max(10).optional().describe("Shortest pause to report, seconds. Default 0.5."),
  keep: z.number().min(0).max(2).optional().describe("Pause to leave in when cutting, seconds, split between both sides. Default 0.2."),
});
export const guideInput = z.object({ name: z.enum(GUIDE_NAMES) });
export const searchInput = z.object({
  query: z.string().trim().min(1).max(120).describe('Words the speaker says, e.g. "late invoices". Case, accents and punctuation are ignored; the last word may be a prefix.'),
  limit: z.number().int().min(1).max(40).optional(),
});
export const iconsInput = z.object({ query: z.string().trim().min(1).max(80).describe('Words for what the icon shows, e.g. "bow arrow", "money", "running person".'), limit: z.number().int().min(1).max(40).optional() });
export const lottiesInput = z.object({ query: z.string().trim().min(1).max(80).describe('What should move or react, e.g. "celebrate", "idea", "laughing", "money", "person running".'), limit: z.number().int().min(1).max(40).optional() });
export const planInput = z.object({
  items: z
    .array(z.object({ text: z.string().trim().min(1).max(200), status: z.enum(["pending", "active", "done"]) }))
    .min(1)
    .max(20),
});
export const askInput = z.object({
  question: z.string().trim().min(1).max(500),
  options: z.array(z.string().trim().min(1).max(120)).max(6).optional().describe("Suggested answers. The user can also type their own."),
  multi: z.boolean().optional().describe("Allow picking several options."),
});
export const insertAssetInput = z.object({
  path: z.string().min(1).max(500).describe("Library path from list_library, e.g. assets/broll.mp4."),
  start: z.number().min(0).max(86_400).optional().describe("Seconds on the clip timeline where it appears. Omit when you give quote."),
  end: z.number().min(0).max(86_400).optional().describe("Seconds on the clip timeline where it disappears. Omit to play to its natural end."),
  quote: z.string().trim().min(2).max(300).optional().describe("The words from <clip_context> this media illustrates; it appears when they are spoken."),
  fit: z
    .enum(["cover", "contain", "native"])
    .optional()
    .describe("cover fills the whole frame (default for B-roll), contain shows all of it, native keeps its own size centered."),
  volume: z.number().min(-60).max(12).optional().describe("dB for video/audio. -60 is nearly silent; omit to keep its sound."),
});

/** Tool trình duyệt: editor vẽ bằng clip-render và trả ảnh/số liệu. */
export const captureInput = z
  .object({
    times: z.array(z.number().finite().min(0).max(3600)).min(1).max(12).optional().describe("Seconds on the clip timeline."),
    start: z.number().min(0).max(3600).optional(),
    end: z.number().min(0).max(3600).optional(),
    count: z.number().int().min(1).max(12).optional().describe("Evenly spaced frames between start and end (default: the whole clip)."),
    separate: z.boolean().optional().describe("Return up to 4 full-size images instead of one contact sheet."),
    grid: z.boolean().optional().describe("Draw thin 0.25/0.5/0.75 guide lines (default true). Turn off to judge the clean picture."),
  })
  .refine((input) => input.times || input.count || input.start !== undefined, "Give times, or a count (with optional start/end).");
export const waveformInput = z.object({
  path: z.string().max(500).optional().describe("Library path. Omit for the clip's own video (source seconds)."),
  start: z.number().min(0).max(86_400).optional(),
  end: z.number().min(0).max(86_400).optional(),
  threshold_db: z.number().min(-80).max(-10).optional().describe("Quieter than this is silence. Default -35."),
  min_silence: z.number().min(0.1).max(10).optional().describe("Shortest silence to report, seconds. Default 0.4."),
});
export const grabInput = z
  .object({
    path: z.string().min(1).max(500).describe("Library path of a video or image."),
    times: z.array(z.number().min(0).max(86_400)).min(1).max(12).optional().describe("Seconds in the file."),
    count: z.number().int().min(1).max(12).optional().describe("Evenly spaced frames across the file."),
  })
  .refine((input) => input.times || input.count, "Give times or a count.");

/** preview_3d (spec code-scenes): chạy code cảnh trong sandbox của editor, trả 4 ảnh + báo cáo bố cục. */
export const preview3dInput = z.object({
  code: z
    .string()
    .min(1)
    .max(MAX_CODE_CHARS)
    .describe("The BODY of function (THREE, stage, kit) { … } ending with `return (t) => { … }` (read_guide \"3d\")."),
  duration: z.number().min(3).max(10).describe("Seconds the animation lasts on the clip."),
  aspect_ratio: z.enum(["9:16", "4:5", "1:1", "16:9"]).describe("Shape of the area it fills: full screen = clip_context.frame; 1:1 or 4:5 for the panel of a split."),
  theme: z.enum(THEMES).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
});

export const saveFrameInput = z.object({
  time: z.number().finite().min(0).max(3600).describe("Second on the clip timeline (as in capture)."),
  name: z.string().trim().min(1).max(60).optional().describe('File name without extension, e.g. "before-cut".'),
});

export const inspectColorInput = z.object({
  time: z.number().finite().min(0).max(3600).optional().describe("Second on the clip timeline (as in capture). Default: the playhead."),
  element_id: z.string().min(1).max(64).optional().describe("Measure only inside this layer's box (it must be visible at that time)."),
});

export const BROWSER_INPUTS: Record<string, z.ZodType> = {
  capture: captureInput,
  save_frame: saveFrameInput,
  media_waveform: waveformInput,
  media_grab: grabInput,
  preview_3d: preview3dInput,
  inspect_color: inspectColorInput,
};

// ------------------------------------------------------------------ mô tả

const READ_TOOLS: ToolSpec[] = [
  spec(
    "get_project_state",
    "Read a short summary of the clip: frame size, duration after cuts, caption style, cuts, and every element with its id, tag, timing and label.",
    z.object({}),
  ),
  spec(
    "get_document",
    "Read the full project tree as JSON: every element with all its properties, keyframe tracks, paints, effects, animations and masks. Use it before editing properties you have not seen. Times are seconds; x/y are the top-left in the parent's space.",
    documentInput,
  ),
  spec(
    "get_transcript",
    "Read the clip's transcript as caption lines of words with stable ids, source-time seconds, and whether each word is already cut from the video.",
    z.object({}),
  ),
  spec(
    "search_transcript",
    "Find where the speaker says something: each hit has the matching words' ids (for remove_words), SOURCE seconds (for remove_ranges), CLIP seconds after cuts (null when that part is already cut), and the whole caption line for context. Cheaper than reading the whole transcript when you know what to look for.",
    searchInput,
  ),
  spec(
    "find_filler_words",
    "List likely filler words (um, uh, erm, ...) and immediately repeated words, with ids. Suggestions only: check the context in get_transcript before removing.",
    z.object({}),
  ),
  spec(
    "find_silences",
    "List pauses between spoken words (source seconds), with the words on each side and a suggested range to pass to remove_ranges that leaves a natural gap.",
    silencesInput,
  ),
  spec(
    "list_library",
    "List the media in this project's library (path, type, duration, size) that you can place with insert_asset, including the clip's own video.",
    z.object({}),
  ),
  spec(
    "check",
    "Lint the clip for problems a viewer would see: empty (black) stretches, elements that never show or sit outside the frame, zero-length or fully transparent elements, missing media, text over the captions. Run it after edits; fix every error before you finish.",
    z.object({}),
  ),
  spec(
    "find_icons",
    "Search the icon library (about 1,800 line icons: people, arrows, money, time, tech, sport, emotions…) by meaning. Returns names to pass to add_icon.",
    iconsInput,
  ),
  spec(
    "find_lotties",
    "Search the built-in animations by meaning: moving stick people and motion effects (walk, run, cheer, bow-shot, rocket-launch, lightbulb-on, clock-tick, confetti…) and about 140 animated emoji (emoji/fire, emoji/joy, emoji/thinking, emoji/rocket, emoji/money-mouth…). Returns names to pass to add_lottie.",
    lottiesInput,
  ),
  spec(
    "read_guide",
    `Read an editing guide. Available: ${GUIDE_NAMES.join(", ")}. Read "workflow" before a multi-step edit and "document" before writing properties, keyframes, effects or animations.`,
    guideInput,
  ),
];

const TALK_TOOLS: ToolSpec[] = [
  spec(
    "update_plan",
    "Show the user your plan for a multi-step edit as a checklist, and update it as you go (mark the step you are on as active, finished ones as done). It changes nothing in the clip.",
    planInput,
  ),
  spec(
    "ask_user",
    "Ask the user one short question when the request is ambiguous or a change would remove a lot of the clip. The turn pauses until they answer. Do not ask about things you can find out with tools.",
    askInput,
    { input: true },
  ),
];

const BROWSER_TOOLS: ToolSpec[] = [
  spec(
    "capture",
    "Look at the clip: render frames at clip-timeline seconds exactly as the export will, returned as one contact sheet with a timecode on each cell (or separate images), with thin cyan guides at 0.25/0.5/0.75 of the frame. The result also lists, per frame, the visible layers top-first with their id and 0-1 box [x0, y0, x1, y1], so you can name exactly what you see. Use it after changing the frame, cutting, adding text or media, and before you finish, to check framing, legibility and overlaps.",
    captureInput,
    { browser: true },
  ),
  spec(
    "media_waveform",
    "Listen for loudness: coarse levels (dB) and the silent stretches of the clip's own video (default: its window, in SOURCE seconds as in get_transcript, ready for remove_ranges) or of a library file (seconds in that file). Use it to find pauses the transcript does not show (breaths, noise, music).",
    waveformInput,
    { browser: true },
  ),
  spec(
    "preview_3d",
    "Run 3D scene code you wrote and look at it: 4 frames (near the start, middle, near the end, final state) plus a layout report per frame (objects or labels cut off or outside the frame, how much of the frame the scene fills). Errors come back with the phase (compile/build/frame) and the JS message. Fix and preview again until there are no errors and no layout issues, then add it with add_3d_scene. Free.",
    preview3dInput,
    { browser: true },
  ),
  spec(
    "save_frame",
    "Save one frame of the clip (as the export draws it, WITHOUT captions or text) to the library folder Frames, uploaded so generate_media can use it as start_image or end_image: an AI transition between two shots (the frame before and after a cut), or a video that continues from a moment of the clip. Returns its library path and the picture. Free.",
    saveFrameInput,
    { browser: true },
  ),
  spec(
    "media_grab",
    "Look inside a library video or image before using it: frames at the given seconds of the file, as one contact sheet. Use it to choose which part of a B-roll clip fits.",
    grabInput,
    { browser: true },
  ),
  spec(
    "inspect_color",
    "Measure the color of one frame as the export draws it (captions and text left out): black/white point, median luma, share of crushed and blown pixels, average RGB (a color cast shows as one channel above the others), saturation and a 16-bin luma histogram. Use it before grading to see what to fix and after apply_color to check the result is not crushed, blown or tinted. element_id measures a single layer (e.g. one B-roll shot). Free.",
    inspectColorInput,
    { browser: true },
  ),
];

/** Mô tả op cho model. */
const OP_DESCRIPTIONS: Record<string, string> = {
  remove_words:
    "Cut words out of the video (and captions) by word id. Non-adjacent ids become separate cuts. Get ids from get_transcript or search_transcript. tightness also cuts the pauses around the removed words, leaving tight 0.06s / balanced 0.15s / loose 0.32s next to the words that stay — use balanced for fillers and stumbles so the sentence does not gap.",
  remove_silence:
    "Cut every pause longer than min_pause (default 0.5s) from the video in one step, leaving padding (default 0.15s) next to speech on each side; dead air at the very start and end of the clip is cut fully. Prefer it over many remove_ranges calls for general tightening.",
  remove_ranges:
    "Cut stretches of source time out of the video (and captions), e.g. pauses from find_silences. Seconds are source seconds as in get_transcript.",
  restore_words: "Put previously removed words back into the video, by word id.",
  restore_all: "Undo every cut made from the transcript, restoring the full clip window.",
  edit_words:
    "Fix caption text for one or more words (e.g. misheard words). Text with spaces becomes several words. Empty text removes the word from captions only, not from the video.",
  split_line: "Start a new caption line at this word.",
  merge_lines: "Join the caption line containing this word with the next line.",
  nudge_word: "Shift the start or end time of one word by a number of seconds (negative = earlier).",
  set_frame:
    "Change the frame size, e.g. 1080x1920 (9:16 vertical), 1080x1080 (1:1), 1080x1350 (4:5), 1920x1080 (16:9). mode 'fill' crops and follows the speaker; 'fit' shows the whole video with bars.",
  set_layout:
    "Split the frame between the speaker and a visual panel over a time range (read_guide layout). mode split-bottom = speaker at the bottom, panel on top; split-top = the reverse; visual-only = the panel covers the frame while the voice continues; pip = visual full frame with the speaker in a rounded corner square (anchor = corner); side-by-side = speaker column beside the visual (anchor left/right); full = back to full frame. start/end in clip seconds (omit for the whole clip), ratio = speaker's share (height for splits 0.3-0.7, width for pip 0.2-0.5 and side-by-side 0.3-0.7).",
  set_caption_style:
    "Change the caption style of EVERY caption layer at once (words, timing and position stay): preset, highlight colors, main text color, font and weight. classic highlights one word at a time, spotlight is bold with a colored active word, stark is clean white. Colors are hex like #FFD400; null keeps the preset's own colors. color/font/weight: null resets to the preset, omit to keep.",
  add_text:
    "Add a simple centered text overlay (title, hook, call to action). start/end are seconds on the clip timeline; y is the vertical center from 0 (top) to 1 (bottom). For richer text (animation, stroke, shadow, highlight ranges) add it with insert_node or change it with set_props/add_part.",
  update_element:
    "Change properties of one element by id, e.g. color, fontSize, start, end, x, y. For text elements, `text` replaces what it says.",
  delete_element: "Delete one element by id (text, image, B-roll). The main clip video cannot be deleted.",
  move_elements: "Move elements later (positive) or earlier (negative) on the timeline by a number of seconds.",
  trim_element: "Move the start (edge 'in') or end (edge 'out') of an element to a clip-timeline second.",
  split_elements: "Split elements in two at a clip-timeline second. Always pass element_ids.",
  move_layer:
    "Reorder or re-parent an element: put it in parent_id, just before before_id (null = on top). Later children draw on top.",
  move_keyframe: "Move one keyframe (by id, from get_document) to a new time in the element's own seconds.",
  set_workarea: "Set the part of the timeline that gets exported, or clear it.",
  set_marker:
    "Add (no marker_id) or change a timeline marker: a point or a range (duration) at clip seconds with a name, color, note and status open/review/resolved. Use markers to leave the user review notes on moments you could not fix or want them to check; markers never appear in the export.",
  delete_marker: "Delete a timeline marker by id.",
  set_caption_breaks:
    "Change how captions break into lines for every caption layer: max_words / max_chars cap what is on screen at once (breaks at sentence ends, then commas, then the middle word), hold_gap keeps a line up through pauses shorter than that many seconds so captions do not blink off between sentences. null returns to the preset's own rule. 3-5 words with hold_gap 0.4 suits fast short-form.",
  clean_audio: "Remove steady background noise (hum, fan, room hiss) from a video/audio element when the clip is exported. amount 0-1 (0.6 suits voice, 0 turns it off); omit element_id for the clip's own video, every cut piece. The preview keeps the original sound.",
  set_fade: "Fade elements in and/or out: in/out are seconds (0 removes that fade, omit to keep). Picture fades for visuals, sound fades for video/audio. Capped at half the element's length.",
  slip_element:
    "Show a different part of a B-roll video or audio clip without moving it on the timeline: by is seconds of footage to move forward (positive) or back. Clamped to the file. Not for the clip's own video.",
  set_audio_roll:
    "Shape a cut of the clip's own video like a pro editor (J-cut / L-cut): the picture still cuts at the same frame, the SOUND cuts earlier or later. at = the cut's clip second (cut_points in get_project_state). seconds > 0 = L-cut: the speaker's last words keep playing over the next shot; seconds < 0 = J-cut: the next sound starts early, under the shot before. 0.3-1s feels natural; 0 makes the cut straight again; omit at with 0 to straighten every cut. Cutting more words keeps the J/L-cuts on cuts that remain.",
  ripple_delete:
    "Delete one element and pull everything after it in the same container earlier to close the gap (e.g. a B-roll shot inside a sequence). Refused when that would move the clip's own video or captions.",
  set_props:
    "Set any properties of one element (see read_guide 'document' for names), e.g. {opacity: 0.8}, {fontWeight: 800, textCase: 'upper'}, {scale: 1.1}, {transition: {type: 'dissolve', duration: 0.5}}. null removes a property.",
  set_keyframe:
    "Add, change or remove a keyframe for an animatable property (x, y, scale, rotation, opacity, width, height, volume, blur, ...). time is in the element's own seconds from its start. Use it for zoom-ins, pans and fades.",
  add_part:
    "Add a sub-part to an element: paints, strokes, shadows, effects, animations (e.g. {type: 'fade', phase: 'in', duration: 0.4}), ranges (text highlight), masks or gradient stops.",
  move_part: "Reorder a sub-part (paint, stroke, effect, ...) within its list.",
  copy_settings:
    "Make elements look like another one: copy groups of settings from from_id to to_ids — look (opacity, corners, blend), text (font, size, weight, color, case, stroke; text to text only), effects (filters, shadows), motion (animations, transition), audio (volume, mute). Never copies timing, position, wording or keyframes. Default: every group that fits each target.",
  duplicate_elements: "Duplicate elements in place.",
  paste_nodes: "Insert copies of full node JSON (from get_document) under a parent.",
  group_elements: "Wrap elements in a group, a sequence (plays one after another) or a nested scene. frame is the clip-timeline frame to measure boxes at.",
  ungroup_elements: "Unwrap groups, sequences or nested scenes, keeping their contents in place.",
  insert_scene: "Add a new scene (a separate composition) to the project.",
  activate_scene: "Open another scene.",
  create_timeline:
    "Create a timeline and switch to it — every read and edit now targets it. With from (a timeline id from get_project_state timelines), it is a full copy: the way to make a version (\"a tighter cut\", \"a 9:16 version\") while the original stays intact. Without from, an empty timeline the same size as the open one.",
  set_active_timeline:
    "Switch the open timeline. Re-read get_project_state after switching: element ids from the previous timeline are not valid targets.",
  rename_timeline: "Rename a timeline (shown on its tab).",
  delete_timeline: "Delete a timeline. Only when the user asks; the last timeline cannot be deleted.",
  set_project_settings:
    "Change the open timeline's export frame rate (fps 24/25/30/50/60; editing stays on a 30 fps grid) or its size: exact width+height, or aspectRatio like \"16:9\" / \"2.39:1\" (keeps the short edge) and/or quality 720p/1080p/2K/4K (sets the short edge). With the clip's own video, resizing reframes like set_frame.",
  apply_layout:
    "Arrange several video/image elements in one of 13 layouts (like an NLE's layout presets): full, side_by_side (left/right), top_bottom (top/bottom), pip_bottom_right/pip_bottom_left/pip_top_right/pip_top_left (main + inset: the inset is the small corner box, drawn on top), grid_2x2 (r1c1…r2c2), grid_3x3, grid_4x4, main_sidebar (main 70% / sidebar 30%), three_up (left/center/right columns), three_stack (top/middle/bottom rows). Fill EVERY slot with element ids (several ids in one slot = shown one after another); the elements must overlap in time. fit fill (default) crops to cover the slot, anchor chooses what stays (top keeps a face); fit shows the whole media inside the slot. The clip's own video (its element id from get_project_state) may fill one slot: face tracking is kept and it stays in the slot from start to end (default: while the other elements play). For the speaker plus ONE explainer panel over a spoken range use set_layout instead. New media: insert_asset first, then apply_layout with the new ids.",
  apply_color:
    "Color-grade video, image or shape elements in one step, like a colorist: exposure (stops), contrast, highlights, shadows, whites, blacks, saturation, vibrance, temperature (+warm), tint (+magenta), clarity, dehaze, sharpen, grain, glow, vignette {amount, midpoint, roundness, feather}, curves {master/red/green/blue points [in, out] 0-1}, wheels {lift/gamma/gain [r,g,b] offsets}, hue_curves {hue/sat/lum points [hue 0-1, change]}, chroma_key {color, range, spill} for green screen, motion_blur {amount, angle}, lut {path, strength} = a 3D .cube LUT the user imported (list_library type LUT). Each key replaces that adjustment, 0 removes it, reset: true starts the grade over; blur and other filters are kept. Subtle values look professional: ±0.1-0.3 for tone, wheel offsets ±0.03-0.15. Check the result with inspect_color or capture.",
  add_shape:
    "Draw a pointer on the video, hand-drawn style (strokes draw on): arrow (from/to, optional bend), line, underline (from/to), circle, box, diamond, highlight (marker swipe), check, cross (box). Coordinates are 0-1 of the frame. Use it to point at what the speaker is talking about.",
  add_lottie:
    "Place a Lottie animation. animation = a built-in name from find_lotties — a moving stick person (walk, run, wave, point, jump, cheer), a motion effect (confetti, check-draw, pulse-ring, typing-dots, arrow-spin, bow-shot, sparkle, heart-beat, lightbulb-on, rocket-launch, star-burst, spinner, clock-tick, swipe-up, arrow-bounce, target-hit) or an animated emoji (emoji/<name>, e.g. emoji/fire, emoji/joy, emoji/exploding-head) — or the path of a Lottie .json in the library (list_library). at = center, size = share of the frame's short side, flip: true mirrors it (a person walking left), speed, loop (default true), label. Use a person to act out what is said (running late → run, success → cheer), an emoji for the speaker's feeling or the audience's reaction, an effect for the idea (idea → lightbulb-on, goal → target-hit, launch → rocket-launch).",
  add_icon:
    "Place an animated line icon (name from find_icons). at = center, size = share of the frame's short side. motion: draw (sketches itself), pop, spin (turns in place), orbit (circles around), bounce, float, pulse, shake, fly (travels to `to` along a curve; orient: true turns it to face where it flies, heading = the direction the icon points, 0 = right, -45 = up-right). Use fly for an arrow shot from a bow, a rocket launching, money flying to a wallet.",
  add_diagram:
    "Add an explainer diagram: labeled nodes joined by arrows that build one by one. layout row (≤3 short steps), column (steps on a vertical video), cycle (a loop), tree (first node splits into the rest), compare (exactly two nodes with bullet items, VS between). Time it to the sentence that lists the steps. region is 0-1 of the frame (default: top third on vertical video, clear of face and captions).",
  add_chart:
    "Turn numbers the speaker says into an animated chart: bar (bars grow), line (line draws on), pie, donut (sweeps round; shows the first share in the middle), stat (one big number with a label). Values are raw numbers; unit is a suffix like % or k.",
  add_graph:
    "Plot y = f(x) on axes, drawn on like a 3Blue1Brown animation. expr uses x, + - * / ^, brackets, sin cos tan exp log sqrt abs, pi, e (e.g. 2^x, x^2, sin(x)). Optional x and y ranges.",
  update_visual:
    "Change a visual made with add_shape/add_diagram/add_chart/add_graph by its group id: changes are merged into its original input (labels, data, layout, colors, region) and it is rebuilt in place. Optional new start/end.",
  stagger:
    "Animate several elements one after another (like a list appearing item by item): same animation type, each delayed by step seconds.",
  make_room:
    "Ripple insert: open a gap of `seconds` at `at` (timeline seconds) by pushing every layer that starts at or after `at` later; layers playing across `at` stay. Then insert_asset/insert_node into the gap. Use it to slot a shot between two shots in a montage or a blank edit without overlapping. It never moves the clip's own speaker video or captions — cover the speaker with B-roll on top instead.",
  insert_node:
    "Add a new element with full properties under parent_id (usually the scene id): text, rect, path (SVG path data: arrows, lines, circles, custom shapes; animate trimEnd 0→1 to draw it on), image, video, audio, captions or group. See read_guide 'document'. Prefer insert_asset for library media.",
};

function opSpec(name: string, input: z.ZodType): ToolSpec {
  const json = z.toJSONSchema(input, { io: "input", unrepresentable: "any" }) as {
    properties: Record<string, unknown>;
    required?: string[];
  };
  delete json.properties.op;
  json.required = (json.required ?? []).filter((key) => key !== "op");
  const { schema, open } = sanitize(json);
  return { name, description: OP_DESCRIPTIONS[name] ?? describeFallback(name), schema: schema as Record<string, unknown>, strict: !open };
}

const describeFallback = (name: string) => name.replace(/_/g, " ");

const INSERT_ASSET = spec(
  "insert_asset",
  "Place library media on the clip (B-roll, image, music, sound effect) at a time, sized to the frame. Check list_library first; look inside videos with media_grab to pick the moment.",
  insertAssetInput,
);

/**
 * Danh sách tool, THỨ TỰ TẤT ĐỊNH: tools là phần đầu của prefix cache, một
 * thứ tự khác là cache hỏng cho mọi request.
 */
export const TOOL_SPECS: ToolSpec[] = [
  ...READ_TOOLS,
  ...TALK_TOOLS,
  ...BROWSER_TOOLS,
  INSERT_ASSET,
  ...Object.keys(AGENT_OP_INPUTS)
    .sort()
    .map((name) => opSpec(name, AGENT_OP_INPUTS[name]!)),
];

// `generate_media`/`add_3d_scene`/`add_voiceover` ghi lên clip (khai báo `generate.*`) sau thẻ duyệt.
const WRITE_TOOLS = new Set([...Object.keys(AGENT_OP_INPUTS), "insert_asset", "generate_media", "add_3d_scene", "add_voiceover"]);
export const isWriteTool = (name: string): boolean => WRITE_TOOLS.has(name);

export type ToolEnv = { workspace: AgentWorkspace };

export type ToolOutcome = {
  ok: boolean;
  /** Nội dung tool_result gửi model. */
  content: string;
  /** Câu ngắn cho thẻ hành động trong UI. */
  summary: string;
  /** Version mới khi tool ghi thành công và document đổi. */
  version?: number;
  /** Dữ liệu cho UI (plan, câu hỏi) — không gửi model. */
  view?: Record<string, unknown>;
};

const FILLERS = new Set(["um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah", "hmm", "mm", "mhm"]);
const bare = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/**
 * Dữ liệu từ người dùng (transcript, chữ trên video) đi vào tool_result trong
 * một phong bì có nhãn: system prompt dặn model coi mọi thứ trong đó là dữ
 * liệu, không phải chỉ thị (spec §6.7).
 */
const asData = (value: unknown): string => JSON.stringify({ untrusted_data: value });

/** Trạng thái editor không phải dữ liệu dựng: bỏ khỏi thứ agent đọc. */
const EDITOR_STATE = new Set(["selected", "expanded", "clipHeight", "timeline", "playhead"]);
const MAX_DOCUMENT_CHARS = 60_000;

function documentView(document: ClipDocument, nodeId?: string): unknown {
  const target = nodeId ? byId(document, nodeId)?.entity : document.stage;
  if (!target) return null;
  const strip = (value: unknown, depth: number, compact: boolean): unknown => {
    if (Array.isArray(value)) return value.map((item) => strip(item, depth + 1, compact));
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (EDITOR_STATE.has(key)) continue;
      if (compact && key === "keyframes" && Array.isArray(item) && item.length > 4) {
        out[key] = [...item.slice(0, 2), { omitted: item.length - 4 }, ...item.slice(-2)];
        continue;
      }
      out[key] = strip(item, depth + 1, compact);
    }
    return out;
  };
  const full = strip(target, 0, false);
  if (JSON.stringify(full).length <= MAX_DOCUMENT_CHARS) return full;
  return { truncated: "Long keyframe tracks are shortened; read one element by node_id for all of it.", ...(strip(target, 0, true) as object) };
}

/** Chạy `check` trên bản đang lưu — tool `check` và lượt tự kiểm của loop dùng chung. */
export async function runCheck(workspace: AgentWorkspace): Promise<CheckReport> {
  const snapshot = await workspace.read();
  const ctx = await workspace.opContext(snapshot.document, snapshot.manifest);
  const paths = new Set([MASTER_SRC, ...snapshot.manifest.assets.map((record) => record.path)]);
  return checkDocument(snapshot.document, {
    duration: (src) => ctx.media?.duration(src) ?? null,
    transcript: (src) => ctx.media?.transcript?.(src) ?? null,
    exists: (src) => paths.has(src) || /^https?:/.test(src),
  });
}

async function readTools(name: string, input: unknown, env: ToolEnv): Promise<ToolOutcome> {
  const { workspace } = env;
  const snapshot = await workspace.read();
  const document = snapshot.document;

  switch (name) {
    case "get_project_state": {
      // Gọn (học Palmier §A3): bỏ trường null, số 3 chữ lẻ — model đọc ít token hơn mà không mất gì.
      const summary = summarizeProject(document);
      const markers = readMarkers(document);
      const elements = summary.elements.map((element) =>
        Object.fromEntries(Object.entries(element).filter(([, value]) => value !== null && value !== "")),
      );
      return {
        ok: true,
        content: asData({
          version: snapshot.version,
          ...summary,
          elements,
          ...(markers.length ? { markers } : {}),
          // Chỗ cắt theo giây CLIP (+ J/L-cut đang có) — đầu vào của set_audio_roll.
          ...(cutPoints(document).length ? { cut_points: cutPoints(document) } : {}),
        }),
        summary: "Read the clip",
      };
    }
    case "get_document": {
      const { node_id } = documentInput.parse(input ?? {});
      const view = documentView(document, node_id);
      if (!view) return { ok: false, content: JSON.stringify({ error: `There is no element "${node_id}".` }), summary: "Element not found" };
      return { ok: true, content: asData({ version: snapshot.version, [node_id ? "element" : "stage"]: view }), summary: "Read the project tree" };
    }
    case "list_library": {
      const ctx = await workspace.opContext(document, snapshot.manifest);
      const assets = [
        {
          path: MASTER_SRC,
          type: "VIDEO",
          role: "the clip's own video (cut it from the transcript, do not insert it again)",
          duration: ctx.media?.duration(MASTER_SRC) ?? null,
          width: ctx.master?.width ?? null,
          height: ctx.master?.height ?? null,
        },
        ...snapshot.manifest.assets.map((record) => ({
          path: record.path,
          type: record.type,
          duration: typeof record.duration === "number" ? record.duration : null,
          width: typeof record.width === "number" ? record.width : null,
          height: typeof record.height === "number" ? record.height : null,
          ...("state" in record ? { state: record.state === "pending" ? "still generating" : "failed" } : {}),
        })),
      ];
      return { ok: true, content: asData({ assets }), summary: `Read the library (${assets.length} ${assets.length === 1 ? "item" : "items"})` };
    }
    case "check": {
      const report = await runCheck(workspace);
      const errors = report.issues.filter((issue) => issue.severity === "error").length;
      return {
        ok: true,
        content: JSON.stringify(report),
        summary: report.issues.length
          ? `Found ${report.issues.length} ${report.issues.length === 1 ? "issue" : "issues"}${errors ? ` (${errors} to fix)` : ""}`
          : "No problems found",
      };
    }
  }

  const ctx = await workspace.opContext(document, snapshot.manifest);
  const model = await loadCaptions(document, ctx);
  if (!model) return { ok: true, content: JSON.stringify({ captions: null }), summary: "No captions on this clip" };

  if (name === "find_silences") {
    const options = silencesInput.parse(input ?? {});
    const silences = findSilences(model, { minGap: options.min_gap, keep: options.keep });
    return {
      ok: true,
      content: JSON.stringify({ window: model.window, silences }),
      summary: silences.length ? `Found ${silences.length} ${silences.length === 1 ? "pause" : "pauses"}` : "No long pauses",
    };
  }

  const removed = model.removed;
  const lines = (model.transcript as Transcript).map((segment) =>
    segment.words.map((word) => ({
      id: word.id,
      text: word.text,
      start: word.start,
      end: word.end,
      ...(isRemoved(word, removed) ? { removed: true } : {}),
    })),
  );

  if (name === "search_transcript") {
    const parsed = searchInput.safeParse(input ?? {});
    if (!parsed.success) return { ok: false, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues[0]?.message }), summary: "Could not search" };
    const hits = searchSpoken(model.transcript as Transcript, { window: model.window, removed }, parsed.data.query, parsed.data.limit ?? 20);
    return {
      ok: true,
      content: asData({ query: parsed.data.query, hits }),
      summary: hits.length ? `Found "${parsed.data.query}" ${hits.length} ${hits.length === 1 ? "time" : "times"}` : `"${parsed.data.query}" is not said`,
    };
  }

  if (name === "get_transcript") {
    return { ok: true, content: asData({ window: model.window, cuts: removed, lines }), summary: "Read the transcript" };
  }

  // find_filler_words
  const flat = lines.flat().filter((word) => !word.removed);
  const hits: Array<{ id?: string; text: string; reason: string }> = [];
  flat.forEach((word, index) => {
    const text = bare(word.text);
    if (FILLERS.has(text)) hits.push({ id: word.id, text: word.text, reason: "filler" });
    else if (index > 0 && text && text === bare(flat[index - 1]!.text)) {
      hits.push({ id: word.id, text: word.text, reason: "repeated" });
    }
  });
  return {
    ok: true,
    content: asData({ suggestions: hits }),
    summary: hits.length ? `Found ${hits.length} possible filler ${hits.length === 1 ? "word" : "words"}` : "No filler words found",
  };
}

const READS = new Set(["get_project_state", "get_document", "get_transcript", "search_transcript", "find_filler_words", "find_silences", "list_library", "check"]);

/** Op timeline/inspector chạm vào thời gian của video chính thì phá mốc cắt và phụ đề. */
const TIMING_PROPS = ["start", "end", "sourceIn", "sourceOut", "playbackRate", "src"];

function masterIds(document: ClipDocument): Set<string> {
  const ids = new Set<string>();
  walk(document, ({ entity, tag }) => {
    if (tag === "video" && entity.src === MASTER_SRC && entity.id) ids.add(entity.id);
  });
  return ids;
}

/** Luật riêng của agent trên op mà người dùng được làm bằng tay. */
function guard(op: Record<string, unknown>, document: ClipDocument): string | null {
  const masters = masterIds(document);
  const touches = (ids: unknown) => (Array.isArray(ids) ? ids : [ids]).some((id) => typeof id === "string" && masters.has(id));
  const recut = "Cut the clip's own video from the transcript (remove_words or remove_ranges) instead of changing its timing.";
  switch (op.op) {
    case "move_elements":
    case "duplicate_elements":
      return touches(op.element_ids) ? recut : null;
    case "trim_element":
      return touches(op.element_id) ? recut : null;
    case "split_elements":
      if (!Array.isArray(op.element_ids) || !op.element_ids.length) return "Pass element_ids: which elements to split.";
      return touches(op.element_ids) ? recut : null;
    case "set_props":
    case "update_element": {
      const props = Object.keys((op.props as object | undefined) ?? {});
      return touches(op.element_id) && props.some((prop) => TIMING_PROPS.includes(prop)) ? recut : null;
    }
    default:
      return null;
  }
}

function invalid(op: { op: string }, message: string): ToolOutcome {
  return {
    ok: false,
    content: JSON.stringify({ INVALID_INPUT: message }),
    summary: `Could not ${describeOp(op as Op).toLowerCase()}`,
  };
}

/** Chạy một tool. Không bao giờ ném: lỗi thành `ok: false` để model đọc và sửa. */
export async function runTool(name: string, input: unknown, env: ToolEnv): Promise<ToolOutcome> {
  try {
    if (READS.has(name)) return await readTools(name, input, env);
    if (name === "find_icons") {
      const parsed = iconsInput.safeParse(input);
      if (!parsed.success) return { ok: false, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues[0]?.message }), summary: "Could not search icons" };
      const icons = await findIcons(parsed.data.query, parsed.data.limit ?? 12);
      return { ok: true, content: JSON.stringify({ icons }), summary: icons.length ? `Found ${icons.length} icons` : "No icons found" };
    }
    if (name === "find_lotties") {
      const parsed = lottiesInput.safeParse(input);
      if (!parsed.success) return { ok: false, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues[0]?.message }), summary: "Could not search animations" };
      const animations = findLotties(parsed.data.query, parsed.data.limit ?? 12).map(({ name, title }) => ({ name, title }));
      return { ok: true, content: JSON.stringify({ animations }), summary: animations.length ? `Found ${animations.length} animations` : "No animations found" };
    }
    if (name === "read_guide") {
      const parsed = guideInput.safeParse(input);
      if (!parsed.success) return { ok: false, content: JSON.stringify({ INVALID_INPUT: `Unknown guide. Available: ${GUIDE_NAMES.join(", ")}.` }), summary: "Unknown guide" };
      return { ok: true, content: readGuide(parsed.data.name), summary: `Read the ${parsed.data.name} guide` };
    }
    if (name === "update_plan") {
      const parsed = planInput.safeParse(input);
      if (!parsed.success) return { ok: false, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues[0]?.message }), summary: "Could not update the plan" };
      return { ok: true, content: JSON.stringify({ ok: true }), summary: "Updated the plan", view: { plan: parsed.data.items } };
    }
    if (name === "insert_asset") return await insertAsset(input, env);

    // Chỉ op Assistant được gọi thẳng: `add_generated` mà model tự bịa tên gọi
    // thì bị từ chối ở đây — nó chỉ đi qua `generate_media` (thẻ có giá).
    const schema = AGENT_OP_INPUTS[name];
    if (!schema) return { ok: false, content: `Unknown tool "${name}".`, summary: `Unknown tool ${name}` };

    const op = { ...(input && typeof input === "object" ? input : {}), op: name };
    // Eager input streaming: API không kiểm input, nên kiểm ở đây trước khi chạy.
    const parsed = schema.safeParse(op);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      return invalid(op as Op, `${where}${issue?.message ?? "Invalid input."}`);
    }
    const blocked = guard(parsed.data as Record<string, unknown>, (await env.workspace.read()).document);
    if (blocked) return invalid(op as Op, blocked);

    return await applyOpOutcome(parsed.data as Op, env);
  } catch (err) {
    return toolFailure(name, err);
  }
}

async function insertAsset(input: unknown, env: ToolEnv): Promise<ToolOutcome> {
  const parsed = insertAssetInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, content: JSON.stringify({ INVALID_INPUT: `${issue?.path.join(".") ?? ""}: ${issue?.message}` }), summary: "Could not add media" };
  }
  const { path, end: given, quote, fit = "cover", volume } = parsed.data;
  const snapshot = await env.workspace.read();
  let start = parsed.data.start;
  let end = given;
  if (start === undefined) {
    if (!quote) return { ok: false, content: JSON.stringify({ INVALID_INPUT: "Give start (clip seconds) or quote (words from <clip_context>)." }), summary: "Could not add media" };
    try {
      const found = await quoteRange(snapshot.document, await env.workspace.opContext(snapshot.document, snapshot.manifest), quote, { min: 1.5, max: 4 });
      start = found.start;
      end ??= found.end;
    } catch (err) {
      return { ok: false, content: JSON.stringify({ error: (err as Error).message }), summary: "Line not found" };
    }
  }
  const record = snapshot.manifest.assets.find((item) => item.path === path);
  if (!record) return { ok: false, content: JSON.stringify({ error: `"${path}" is not in the library. Call list_library.` }), summary: "Media not found" };
  if ("state" in record) return { ok: false, content: JSON.stringify({ error: `"${path}" is still generating or failed.` }), summary: "Media not ready" };
  const scenes = snapshot.document.stage.children.filter((node) => node.kind === "scene");
  const scene = (scenes.find((node) => (node as { active?: boolean }).active) ?? scenes[0]) as unknown as Record<string, unknown> & { id?: string };
  if (!scene?.id) return { ok: false, content: JSON.stringify({ error: "This project has no scene." }), summary: "No scene" };

  const node = nodeFor(record, scene, { start });
  if (!node) return { ok: false, content: JSON.stringify({ error: `"${path}" cannot be placed on the clip.` }), summary: "Unsupported media" };
  if (end !== undefined) {
    if (end <= start) return { ok: false, content: JSON.stringify({ INVALID_INPUT: "end must be after start." }), summary: "Could not add media" };
    node.end = Math.round(end * 1e4) / 1e4;
  }
  if (volume !== undefined && (record.type === "VIDEO" || record.type === "AUDIO")) node.volume = volume;
  // Phủ khung: B-roll dọc/ngang đều lấp kín 9:16, cắt phần thừa như `object-fit: cover`.
  if (fit !== "native" && (record.type === "VIDEO" || record.type === "IMAGE") && typeof node.width === "number" && typeof node.height === "number") {
    const W = Number(scene.width);
    const H = Number(scene.height);
    const ratio = fit === "cover" ? Math.max(W / node.width, H / node.height) : Math.min(W / node.width, H / node.height);
    const width = Math.round(node.width * ratio);
    const height = Math.round(node.height * ratio);
    Object.assign(node, { width, height, x: Math.round((W - width) / 2), y: Math.round((H - height) / 2) });
  }
  // B-roll/âm thanh vào hàng cùng làn còn trống chỗ (`insert_to_row`), không mỗi cái một hàng.
  const rowed = record.type === "VIDEO" || record.type === "IMAGE" || record.type === "AUDIO";
  return applyOpOutcome((rowed ? { op: "insert_to_row", node } : { op: "insert_node", parent_id: scene.id, node }) as Op, env);
}

/**
 * Áp MỘT op đã qua schema lên clip và trả kết quả cho model. Dùng chung cho
 * tool op và cho `generate_media` sau thẻ duyệt.
 */
export async function applyOpTool(op: Op, env: ToolEnv): Promise<ToolOutcome> {
  try {
    const schema = OP_INPUTS[op.op];
    if (!schema) throw new Error(`unknown op ${op.op}`);
    return await applyOpOutcome(schema.parse(op) as Op, env);
  } catch (err) {
    return toolFailure(op.op, err);
  }
}

async function applyOpOutcome(op: Op, env: ToolEnv): Promise<ToolOutcome> {
  const applied = await env.workspace.apply([op]);
  const result = applied.results[0];
  // Trả phần đổi thay cho cả project (học Palmier §A1): model tự cập nhật, không đọc lại.
  const delta = applied.changed ? diffDocuments(applied.before, applied.after) : null;
  const touched = delta ? [...delta.added.map((item) => item.id), ...delta.changed.map((item) => item.id), ...delta.shifted.flatMap((rule) => rule.ids)] : [];
  return {
    ok: true,
    content: JSON.stringify({ ok: true, changed: applied.changed, version: applied.version, summary: result?.summary, ...(delta ? { delta } : {}) }),
    summary: result?.summary ?? describeOp(op),
    version: applied.changed ? applied.version : undefined,
    // Editor nháy các lớp vừa đổi trên timeline (§A6).
    ...(touched.length ? { view: { touched: touched.slice(0, 60) } } : {}),
  };
}

function toolFailure(name: string, err: unknown): ToolOutcome {
  if (err instanceof ApiError && err.status < 500) {
    return { ok: false, content: JSON.stringify({ error: err.message }), summary: err.message };
  }
  if (err instanceof OpError) return { ok: false, content: JSON.stringify({ error: err.message }), summary: err.message };
  console.error(`[agent] tool ${name} lỗi`, err);
  return {
    ok: false,
    content: JSON.stringify({ error: "This change could not be applied." }),
    summary: "This change could not be applied.",
  };
}
