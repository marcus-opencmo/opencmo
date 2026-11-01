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

import type { ClipDocument } from "@opencmo/clip-doc";
import { findIcons } from "@opencmo/clip-icons";
import {
  AGENT_OP_INPUTS,
  MASTER_SRC,
  OP_INPUTS,
  OpError,
  OpFailure,
  byId,
  checkDocument,
  describeOp,
  diffDocuments,
  findSilences,
  guardProps,
  isCutSequence,
  isMasterSound,
  isRemoved,
  loadCaptions,
  quoteRange,
  readMarkers,
  searchSpoken,
  speechElement,
  summarizeProject,
  cutPoints,
  walk,
  type CheckReport,
  type Entity,
  type Op,
  type Transcript,
} from "@opencmo/editor-core";

import { ApiError } from "@/lib/api/errors";
import { nodeFor } from "@/lib/editor/asset-node";

import { GUIDE_NAMES, readGuide } from "./guides";
import { FILLERS, bare, findRetakes } from "./retakes";
import { noTranscript, sourceOf, speechCount } from "./speech";
import { readyStyles } from "./styles";
import type { AgentWorkspace } from "./workspace";
import type { Image } from "./providers/types";

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
/** Which video's words: the transcript tools take the same `element_id` as the cut ops. */
export const transcriptInput = z.object({ element_id: speechElement });
export const silencesInput = z.object({
  element_id: speechElement,
  min_gap: z.number().min(0.1).max(10).optional().describe("Shortest pause to report, seconds. Default 0.5."),
  keep: z.number().min(0).max(2).optional().describe("Pause to leave in when cutting, seconds, split between both sides. Default 0.2."),
});
export const guideInput = z.object({ name: z.enum(GUIDE_NAMES) });
export const searchInput = z.object({
  element_id: speechElement,
  query: z.string().trim().min(1).max(120).describe('Words the speaker says, e.g. "late invoices". Case, accents and punctuation are ignored; the last word may be a prefix.'),
  limit: z.number().int().min(1).max(40).optional(),
});
export const iconsInput = z.object({ query: z.string().trim().min(1).max(80).describe('Words for what the icon shows, e.g. "bow arrow", "money", "running person".'), limit: z.number().int().min(1).max(40).optional() });
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

const brollBeat = z.object({
  path: z.string().min(1).max(500).describe("A video or image from list_library."),
  quote: z.string().trim().min(2).max(300).optional().describe("The words from <clip_context> it illustrates; it appears when they are spoken. Or give start."),
  start: z.number().min(0).max(86_400).optional().describe("Clip seconds where it appears, when there is no quote."),
  seconds: z.number().min(0.5).max(30).optional().describe("How long it shows, 0.5 to 30 s. Default: while the quoted words are spoken (1.5 to 4 s), otherwise 3 s."),
  source_start: z.number().min(0).max(86_400).optional().describe("For a video: the second inside the file to start from (look with media_grab first)."),
  fit: z.enum(["cover", "pip"]).optional().describe("cover fills the frame over the speaker (default); pip shows it small in the top right corner, the speaker still visible."),
  sound: z.boolean().optional().describe("Keep the video's own sound. Default: muted when the clip has a speaker, so the voice stays clear."),
});
export const placeBrollInput = z.object({ beats: z.array(brollBeat).min(1).max(12).describe("One entry per shot, in any order, 1 to 12.") });

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
    "Read a video's transcript as caption lines of words with stable ids, source-time seconds, and whether each word is already cut from the video. Pass element_id for a video other than the main one (<clip_context> speech_sources).",
    transcriptInput,
  ),
  spec(
    "search_transcript",
    "Find where the speaker says something: each hit has the matching words' ids (for remove_words), SOURCE seconds (for remove_ranges), CLIP seconds after cuts (null when that part is already cut), and the whole caption line for context. Cheaper than reading the whole transcript when you know what to look for.",
    searchInput,
  ),
  spec(
    "find_filler_words",
    "List likely filler words (um, uh, erm, ...) and immediately repeated words, with ids. Suggestions only: check the context in get_transcript before removing.",
    transcriptInput,
  ),
  spec(
    "find_silences",
    "List pauses between spoken words (source seconds), with the words on each side and a suggested range to pass to remove_ranges that leaves a natural gap.",
    silencesInput,
  ),
  spec(
    "find_retakes",
    "List sentences the speaker said more than once within a minute (retakes and false starts), each with the last take to keep, the earlier takes as [first word id, last word id], and drop_word_ids to pass to remove_words. Suggestions only: a repetition can be deliberate, so read the lines in get_transcript before removing.",
    transcriptInput,
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
  add_slide: "Add a slide to a slideshow: a heading, an optional body and a colour or library image behind them, shown for a few seconds. Text is always a layer, never inside the image. Refused on a timeline with video.",
  move_slide: "Move a slide of a slideshow to another position; the slides stay touching and keep their durations.",
  delete_slide: "Delete a slide of a slideshow and close the gap. The last slide cannot be deleted.",
  set_slide_duration: "Change how many seconds a slide of a slideshow stays on screen; the later slides move with it.",
  set_slide_text: "Change a slide's heading or body. An empty body removes it.",
  remove_words:
    "Cut words out of the video (and captions) by word id. Non-adjacent ids become separate cuts. Get ids from get_transcript or search_transcript. tightness also cuts the pauses around the removed words, leaving tight 0.06s / balanced 0.15s / loose 0.32s next to the words that stay — use balanced for fillers and stumbles so the sentence does not gap. element_id picks the video when the clip has several with speech (speech_sources in <clip_context>).",
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
    "Set any properties of one element (see read_guide 'document' for names), e.g. {opacity: 0.8}, {fontWeight: 800, textCase: 'upper'}, {scale: 1.1}, {transition: {type: 'dissolve', duration: 0.5}}, {start: 2, end: 6}; on a text element {text: '...'} replaces what it says. null removes a property.",
  set_keyframe:
    "Add, change or remove a keyframe for an animatable property (x, y, scale, rotation, opacity, width, height, volume, blur, ...). time is in the element's own seconds from its start. Use it for zoom-ins, pans and fades.",
  add_part:
    "Add a sub-part to an element: paints, strokes, shadows, effects, animations (e.g. {type: 'fade', phase: 'in', duration: 0.4}), ranges (text highlight), masks or gradient stops.",
  move_part: "Reorder a sub-part (paint, stroke, effect, ...) within its list.",
  move_to_row:
    "Move clips onto another timeline row so they share it: target_id is a clip or row id from get_project_state; the scene's id gives each clip its own row again. Only the same kind shares a row: B-roll with B-roll, text with text, sounds with sounds.",
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
  add_icon:
    "Place an animated line icon (name from find_icons). at = center, size = share of the frame's short side. motion: draw (sketches itself), pop, spin (turns in place), orbit (circles around), bounce, float, pulse, shake, fly (travels to `to` along a curve; orient: true turns it to face where it flies, heading = the direction the icon points, 0 = right, -45 = up-right). Use fly for an arrow shot from a bow, a rocket launching, money flying to a wallet.",
  add_diagram:
    "Add an explainer diagram: labeled nodes joined by arrows that build one by one. layout row (≤3 short steps), column (steps on a vertical video), cycle (a loop), tree (first node splits into the rest), compare (exactly two nodes with bullet items, VS between). Time it to the sentence that lists the steps. region is 0-1 of the frame (default: top third on vertical video, clear of face and captions).",
  add_chart:
    "Turn numbers the speaker says into an animated chart: bar (bars grow), line (line draws on), pie, donut (sweeps round; shows the first share in the middle), stat (one big number with a label). Values are raw numbers; unit is a suffix like % or k.",
  add_graph:
    "Plot y = f(x) on axes, drawn on like a 3Blue1Brown animation. expr uses x, + - * / ^, brackets, sin cos tan exp log sqrt abs, pi, e (e.g. 2^x, x^2, sin(x)). Optional x and y ranges.",
  apply_style:
    "Apply a style from <styles> as ONE change and one undo, after read_skill on it: write an Edit Plan (hook lines, words to emphasize, chapters, an optional list, proofs from ready page captures) where every beat quotes exact words from <clip_context>, never seconds. The style's preset sets captions, punch-in, transitions and colours. Beats whose words are not found, and parts that are not available, are skipped and listed in the result's receipt; tell the user about them.",
  emphasize_words:
    "Style chosen keywords in the captions (the captions' emphasis style: font, italic, colour) — not the word being spoken, which highlight already marks. quotes = exact words from <clip_context>, one to three words each: numbers, names, promises; at most one every 2 seconds, never filler. Emphasis follows the words through later cuts. remove: true takes those words out; clear: true removes all emphasis first (with no quotes: removes it all).",
  add_hook_title:
    "Add the opening hook: one or two short lines (≤ 40 characters each) in the upper third, clear of the face and captions — line 1 the topic, line 2 the promise on an accent box (accent_line picks the boxed line; accent_font_style italic for a serif accent). Without start/end/quote it shows from 0 to 3 s; it stays up 1.5–8 s. Use the speaker's strongest phrase. One hook per clip.",
  punch_in:
    "Alternate the speaker's zoom at every cut (scales = [wide, close], default [1, 1.15]) so jump cuts read as deliberate; shots shorter than min_shot (default 1.2 s) keep the zoom before them. The zoom stays centred on the face. Running it again replaces the earlier punch-ins.",
  add_camera_move:
    "Move the camera on the talking head, baked into keyframes so preview and export match: impact_shake (0.2-0.45 s, on a number or a hard claim), white_flash (up to 0.35 s, on a hard beat or a reveal), whip (0.25-0.4 s throw left/right, into the next point), push_in (0.5-6 s slow zoom on a build-up; holds until the next cut), handheld (1-30 s gentle drift on a calm stretch), beat_pulse (0.2-0.3 s zoom bump on a beat). quote = exact words from <clip_context> (it lands where they start) or start in clip seconds; strength 0-1. The frame always stays covered. At most one shake or flash per 20 s; not where a layout panel shrinks the speaker. The same kind on the same words replaces the earlier move. read_guide \"pacing\".",
  remove_camera_moves:
    "Remove the camera move playing at clip second `at`, or every camera move when `at` is omitted.",
  add_list:
    "Show a numbered list (2–7 items: label, optional short meta like \"12.4k\", blur: true hides a label the speaker is teasing) in the visual panel of a split layout or the upper region. reveal_quotes, one per item in order, light each row when the speaker reaches it (exact words from <clip_context>). Pass quote or start/end for when the list appears.",
  add_proof:
    "Show a captured web page as proof while the speaker makes a claim: a browser frame with the page's real address slides in, eases in on focus (words copied from the page) and marks them as quote (the speaker's words) starts. capture_id must be a ready capture from capture_page. One card per claim; it ends before the next card. read_guide \"proof\".",
  add_title:
    "Add a title card in the brand's colors and font: kind lowerThird (a name and role when a speaker appears), nameTag (the compact version), chapter (a centered section title; sub = \"Chapter 2\" or \"Episode 12\"). title = the name or chapter title (≤ 60 characters), sub = role, company or episode. look: bar (accent bar, no panel), kicker (sub on an accent band above the name), card (panel with an accent line). side left/right/center, motion calm/standard/punchy. Pass quote = the words the speaker says when it should appear (often their introduction): it starts there and holds 5.5-8 s. It is placed inside title-safe, above the captions, clear of the phone's buttons. One name tag per speaker, at their first appearance; chapters where the topic changes. read_guide \"titles\".",
  update_visual:
    "Change a visual made with add_shape/add_diagram/add_chart/add_graph/add_title by its group id: changes are merged into its original input (labels, data, layout, colors, region; a title's title, sub, look, side) and it is rebuilt in place. Optional new start/end.",
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

const PLACE_BROLL = spec(
  "place_broll",
  "Place B-roll from the library (videos or images) on several moments of the clip in ONE step and one undo: each beat appears when its quoted words are spoken, fills the frame (or sits picture-in-picture), fades in and out, and is muted over the speaker. Use it for B-roll from the library instead of insert_asset + set_props per shot; insert_asset stays for music and sound effects. AI shots from generate_media are already placed. Nothing is placed if one beat is wrong; the error names it.",
  placeBrollInput,
);

/**
 * Ops the Assistant is not offered, though they stay in editor-core (the editor's own buttons, and
 * calls in older chats still run): each has a better tool for the model. update_element takes no
 * objects, so the model's transitions and strokes failed there (production run 1); set_props takes
 * everything it did. duplicate_elements covers paste_nodes; set_keyframe covers move_keyframe; scene
 * and part reordering are editor gestures. Fewer near-twins, fewer wrong picks, a shorter prompt.
 */
export const NOT_OFFERED = new Set(["update_element", "paste_nodes", "insert_scene", "activate_scene", "move_part", "move_keyframe"]);

/**
 * Danh sách tool, THỨ TỰ TẤT ĐỊNH: tools là phần đầu của prefix cache, một
 * thứ tự khác là cache hỏng cho mọi request.
 */
export const TOOL_SPECS: ToolSpec[] = [
  ...READ_TOOLS,
  ...TALK_TOOLS,
  ...BROWSER_TOOLS,
  INSERT_ASSET,
  PLACE_BROLL,
  ...Object.keys(AGENT_OP_INPUTS)
    .filter((name) => !NOT_OFFERED.has(name))
    // A style needs a ready style to apply; until one is, the tool would only invite a degraded run.
    .filter((name) => name !== "apply_style" || readyStyles().length > 0)
    .sort()
    .map((name) => opSpec(name, AGENT_OP_INPUTS[name]!)),
];

// `generate_media`/`add_voiceover` write to the clip (a `generate.*` declaration) after the approval card.
/**
 * Tools that only read: the model often asks for several in one step (state, transcript, library),
 * and they can run at the same time. Anything that writes, pauses or spends stays in order.
 */
export const PARALLEL_SAFE = new Set([...READ_TOOLS.map((tool) => tool.name), "read_skill", "list_clips", "get_clip"]);

/**
 * Tools that cut or read a video by its words. A blank New edit with no video that has a transcript
 * could only fail with them; leaving them out keeps ~6k characters of schema out of every request.
 * They come back once a video on it is transcribed: the tool list (the start of the prompt cache)
 * changes once in that session, then holds.
 */
export const OWN_VIDEO_TOOLS = new Set(["find_filler_words", "find_silences", "find_retakes", "remove_words", "restore_words", "restore_all", "remove_ranges", "remove_silence", "set_audio_roll"]);

/**
 * The verify gate: what the model is told when it tries to finish while the last <check> after its
 * writes still lists errors. Once per request, so a check it cannot clear never loops.
 */
export const VERIFY_GATE =
  "Before you finish: the check after your last change still lists errors (below). Fix each one, or tell the user plainly why it cannot be fixed, then finish.";

type CheckIssueLike = { severity?: string; code?: string; node_id?: string };
const issueKey = (issue: CheckIssueLike) => `${issue.code ?? ""}:${issue.node_id ?? ""}`;

function checkIssues(state: string | undefined): CheckIssueLike[] | null {
  const match = state?.match(/<check>(\{.*\})<\/check>/s);
  if (!match) return null;
  try {
    return (JSON.parse(match[1]!) as { issues?: CheckIssueLike[] }).issues ?? [];
  } catch {
    return null;
  }
}

/** The errors a state message's `<check>` reports, by code and element: the gate's baseline. */
export function checkErrorKeys(state: string | undefined): Set<string> {
  return new Set((checkIssues(state) ?? []).filter((issue) => issue.severity === "error").map(issueKey));
}

/**
 * A `<check>` block of the errors in `state` that `before` did not have, else null. Errors the clip
 * had when the request began (a blank edit's empty seconds, the user's own stray layer) are not the
 * model's to fix before it may finish.
 */
export function failingCheck(state: string | undefined, before: Set<string> = new Set()): string | null {
  const fresh = (checkIssues(state) ?? []).filter((issue) => issue.severity === "error" && !before.has(issueKey(issue)));
  return fresh.length ? `<check>${JSON.stringify({ ok: false, issues: fresh })}</check>` : null;
}

/** The run of parallel-safe calls that starts at `index` (empty when that call is not one). */
export function readGroup<T extends { name: string }>(calls: T[], index: number): T[] {
  const group: T[] = [];
  for (let at = index; at < calls.length && PARALLEL_SAFE.has(calls[at]!.name); at++) group.push(calls[at]!);
  return group;
}

const WRITE_TOOLS = new Set([...Object.keys(AGENT_OP_INPUTS), "insert_asset", "place_broll", "generate_media", "add_voiceover", "replace_background", "create_video", "edit_video", "add_explainer", "animate_video", "redo_keyframe"]);
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
  /** The saved document's fingerprint alongside `version`; library-only saves keep it. */
  documentHash?: string;
  /** Dữ liệu cho UI (plan, câu hỏi) — không gửi model. */
  view?: Record<string, unknown>;
  /** Images the model sees with the result (a server-rendered preview); not stored in the tool row. */
  images?: Image[];
};


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
export async function runCheck(workspace: AgentWorkspace, read?: Awaited<ReturnType<AgentWorkspace["read"]>>): Promise<CheckReport> {
  const snapshot = read ?? (await workspace.read());
  const ctx = await workspace.opContext(snapshot.document, snapshot.manifest);
  const paths = new Set([MASTER_SRC, ...snapshot.manifest.assets.map((record) => record.path)]);
  return checkDocument(snapshot.document, {
    duration: (src) => ctx.media?.duration(src) ?? null,
    transcript: (src) => ctx.media?.transcript?.(src) ?? null,
    transcriptFailed: (src) => ctx.media?.transcriptFailed?.(src) ?? false,
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
  const asked = transcriptInput.safeParse(input ?? {});
  if (!asked.success) return { ok: false, content: JSON.stringify({ INVALID_INPUT: asked.error.issues[0]?.message }), summary: "Could not read the transcript" };
  const elementId = asked.data.element_id;
  let model: Awaited<ReturnType<typeof loadCaptions>>;
  try {
    model = await loadCaptions(document, ctx, elementId);
  } catch (err) {
    // A video on the timeline without a transcript yet: say whether it is coming, not "no such video".
    const missing = elementId && err instanceof OpFailure ? await noTranscript(document, snapshot.manifest, workspace.transcriptStatus, elementId) : null;
    if (missing) return missing;
    throw err;
  }
  if (!model) return (await noTranscript(document, snapshot.manifest, workspace.transcriptStatus))!;
  // Results name the video they read, so a clip with several speakers' videos stays unambiguous.
  const source = sourceOf(document, elementId);
  const of = source && speechCount(document) > 1 ? ` of ${source.name}` : "";

  if (name === "find_silences") {
    const parsed = silencesInput.safeParse(input ?? {});
    if (!parsed.success) return { ok: false, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues[0]?.message }), summary: "Could not find pauses" };
    const options = parsed.data;
    const silences = findSilences(model, { minGap: options.min_gap, keep: options.keep });
    return {
      ok: true,
      content: JSON.stringify({ source, window: model.window, silences }),
      summary: silences.length ? `Found ${silences.length} ${silences.length === 1 ? "pause" : "pauses"}${of}` : `No long pauses${of}`,
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
      content: asData({ source, query: parsed.data.query, hits }),
      summary: hits.length ? `Found "${parsed.data.query}" ${hits.length} ${hits.length === 1 ? "time" : "times"}${of}` : `"${parsed.data.query}" is not said${of}`,
    };
  }

  if (name === "get_transcript") {
    return { ok: true, content: asData({ source, window: model.window, cuts: removed, lines }), summary: `Read the transcript${of}` };
  }

  if (name === "find_retakes") {
    const retakes = findRetakes(model.transcript as Transcript, (word) => isRemoved(word, removed));
    return {
      ok: true,
      content: asData({ source, retakes }),
      summary: retakes.length ? `Found ${retakes.length} repeated ${retakes.length === 1 ? "sentence" : "sentences"}${of}` : `No retakes found${of}`,
    };
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
    content: asData({ source, suggestions: hits }),
    summary: hits.length ? `Found ${hits.length} possible filler ${hits.length === 1 ? "word" : "words"}${of}` : `No filler words found${of}`,
  };
}

const READS = new Set(["get_project_state", "get_document", "get_transcript", "search_transcript", "find_filler_words", "find_silences", "find_retakes", "list_library", "check"]);

/** Op timeline/inspector chạm vào thời gian của video chính thì phá mốc cắt và phụ đề. */
const TIMING_PROPS = ["start", "end", "sourceIn", "sourceOut", "playbackRate", "src"];

/**
 * Ids whose timing is the clip's own video: its segments and sound, the cut sequence that holds
 * them, and every group or sequence around them (moving one of those moves the master too).
 */
function masterIds(document: ClipDocument): Set<string> {
  const ids = new Set<string>();
  const parents = new Map<Entity, Entity>();
  const masters: Entity[] = [];
  walk(document, ({ entity, parent }) => {
    if (parent) parents.set(entity, parent);
    if (isMasterSound(entity as never) || isCutSequence(entity as never)) masters.push(entity);
  });
  for (const master of masters) {
    for (let at: Entity | undefined = master; at && at.kind !== "scene" && at.kind !== undefined; at = parents.get(at)) {
      if (typeof at.id === "string") ids.add(at.id);
    }
  }
  return ids;
}

/** Luật riêng của agent trên op mà người dùng được làm bằng tay. */
export function guard(op: Record<string, unknown>, document: ClipDocument): string | null {
  const masters = masterIds(document);
  const touches = (ids: unknown) => (Array.isArray(ids) ? ids : [ids]).some((id) => typeof id === "string" && masters.has(id));
  const recut = "Cut the clip's own video from the transcript (remove_words or remove_ranges) instead of changing its timing.";
  switch (op.op) {
    case "move_elements":
    case "duplicate_elements":
    case "group_elements":
      return touches(op.element_ids) ? recut : null;
    case "move_layer":
      return touches(op.element_id) || touches(op.parent_id) ? recut : null;
    case "trim_element":
      return touches(op.element_id) ? recut : null;
    case "split_elements":
      if (!Array.isArray(op.element_ids) || !op.element_ids.length) return "Pass element_ids: which elements to split.";
      return touches(op.element_ids) ? recut : null;
    case "set_props":
    case "update_element": {
      const props = Object.keys((op.props as object | undefined) ?? {});
      if (touches(op.element_id) && props.some((prop) => TIMING_PROPS.includes(prop))) return recut;
      // The same rules as update_element's: no ids or children, no frame size, no captions source.
      const found = typeof op.element_id === "string" ? byId(document, op.element_id) : null;
      if (!found) return null;
      try {
        guardProps(found.tag, found.entity, props);
      } catch (error) {
        return error instanceof Error ? error.message : "That property cannot be changed.";
      }
      return null;
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
    if (name === "place_broll") return await placeBroll(input, env);

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

    if (name === "apply_style") return await applyStyleOutcome(parsed.data as Op, env);
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

/** Seconds of fade at each end of a B-roll beat: a hard cut over a speaker reads as a glitch. */
const BROLL_FADE = 0.25;

/**
 * Several B-roll beats as one write: each resolved (time from its quote, size, sound) before any is
 * placed, so a wrong beat places nothing and the model fixes that one; the rest is one revision and
 * one undo.
 */
async function placeBroll(input: unknown, env: ToolEnv): Promise<ToolOutcome> {
  const parsed = placeBrollInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, content: JSON.stringify({ INVALID_INPUT: `${issue?.path.join(".") ?? ""}: ${issue?.message}` }), summary: "Could not place the B-roll" };
  }
  const snapshot = await env.workspace.read();
  const scenes = snapshot.document.stage.children.filter((node) => node.kind === "scene");
  const scene = (scenes.find((node) => (node as { active?: boolean }).active) ?? scenes[0]) as unknown as Record<string, unknown> & { id?: string };
  if (!scene?.id) return { ok: false, content: JSON.stringify({ error: "This project has no scene." }), summary: "No scene" };
  const W = Number(scene.width);
  const H = Number(scene.height);
  const speaker = JSON.stringify(snapshot.document).includes(`"${MASTER_SRC}"`);
  const ctx = parsed.data.beats.some((beat) => beat.quote) ? await env.workspace.opContext(snapshot.document, snapshot.manifest) : null;
  const ops: Op[] = [];
  for (const [index, beat] of parsed.data.beats.entries()) {
    const fail = (message: string): ToolOutcome => ({
      ok: false,
      content: JSON.stringify({ error: `Beat ${index + 1} (${beat.path}): ${message} Nothing was placed.` }),
      summary: "Could not place the B-roll",
    });
    const record = snapshot.manifest.assets.find((item) => item.path === beat.path);
    if (!record) return fail("not in the library. Call list_library.");
    if ("state" in record) return fail("still generating or failed.");
    if (record.type !== "VIDEO" && record.type !== "IMAGE") return fail("not a video or image; place sounds with insert_asset.");
    let start = beat.start;
    let length = beat.seconds;
    if (start === undefined) {
      if (!beat.quote || !ctx) return fail("give quote (words from <clip_context>) or start.");
      try {
        const found = await quoteRange(snapshot.document, ctx, beat.quote, { min: 1.5, max: 4 });
        start = found.start;
        length ??= found.end - found.start;
      } catch (err) {
        return fail((err as Error).message);
      }
    }
    length ??= 3;
    const node = nodeFor(record, scene, { start });
    if (!node || typeof node.width !== "number" || typeof node.height !== "number") return fail("cannot be placed on the clip.");
    if (record.type === "VIDEO") {
      const from = beat.source_start ?? 0;
      const footage = typeof record.duration === "number" ? record.duration - from : Infinity;
      if (footage <= 0.1) return fail(`source_start is past the end of the file (${record.duration}s).`);
      length = Math.min(length, footage);
      if (from > 0) node.sourceIn = Math.round(from * 1e4) / 1e4;
      if (speaker && !beat.sound) node.muted = true;
    }
    node.end = Math.round((start + length) * 1e4) / 1e4;
    if (beat.fit === "pip") {
      const width = Math.round(W * 0.42);
      const height = Math.round((node.height / node.width) * width);
      Object.assign(node, { width, height, x: Math.round(W - width - W * 0.05), y: Math.round(H * 0.08), cornerRadius: Math.round(width * 0.04) });
    } else {
      const ratio = Math.max(W / node.width, H / node.height);
      const width = Math.round(node.width * ratio);
      const height = Math.round(node.height * ratio);
      Object.assign(node, { width, height, x: Math.round((W - width) / 2), y: Math.round((H - height) / 2) });
    }
    const fade = Math.min(BROLL_FADE, length / 4);
    node.animations = [
      { type: "fade", phase: "in", duration: fade },
      { type: "fade", phase: "out", duration: fade },
    ];
    ops.push({ op: "insert_to_row", node } as Op);
  }
  return applyOpsOutcome(ops, env, `Placed ${ops.length} B-roll ${ops.length === 1 ? "shot" : "shots"}`);
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

/**
 * `apply_style` with its receipt: what was applied, skipped (and why) and not available. The op
 * reports it on its result, from the run that was written.
 */
async function applyStyleOutcome(op: Op, env: ToolEnv): Promise<ToolOutcome> {
  return applyOpsOutcome([op], env, undefined, { receipt: true });
}

async function applyOpOutcome(op: Op, env: ToolEnv): Promise<ToolOutcome> {
  return applyOpsOutcome([op], env);
}

/** Several ops as one write (one revision, one undo); `label` sums them up for the panel. */
async function applyOpsOutcome(ops: Op[], env: ToolEnv, label?: string, options: { receipt?: boolean } = {}): Promise<ToolOutcome> {
  const op = ops[0]!;
  const applied = await env.workspace.apply(ops);
  const result = ops.length === 1 ? applied.results[0] : { summary: label ?? `${ops.length} changes` };
  const receipt = options.receipt && ops.length === 1 ? applied.results[0]?.detail : undefined;
  // Trả phần đổi thay cho cả project (học Palmier §A1): model tự cập nhật, không đọc lại.
  const delta = applied.changed ? diffDocuments(applied.before, applied.after) : null;
  const touched = delta ? [...delta.added.map((item) => item.id), ...delta.changed.map((item) => item.id), ...delta.shifted.flatMap((rule) => rule.ids)] : [];
  return {
    ok: true,
    content: JSON.stringify({ ok: true, changed: applied.changed, version: applied.version, summary: result?.summary, ...(delta ? { delta } : {}), ...(receipt !== undefined ? { receipt } : {}) }),
    summary: result?.summary ?? describeOp(op),
    version: applied.changed ? applied.version : undefined,
    documentHash: applied.changed ? applied.documentHash : undefined,
    // Editor nháy các lớp vừa đổi trên timeline (§A6).
    ...(touched.length ? { view: { touched: touched.slice(0, 60) } } : {}),
  };
}

function toolFailure(name: string, err: unknown): ToolOutcome {
  if (err instanceof ApiError && err.status < 500) {
    return { ok: false, content: JSON.stringify({ error: err.message }), summary: err.message };
  }
  // OpFailure: a read tool's own refusal ("several videos with speech: pass element_id").
  if (err instanceof OpError || err instanceof OpFailure) return { ok: false, content: JSON.stringify({ error: err.message }), summary: err.message };
  console.error(`[agent] tool ${name} lỗi`, err);
  return {
    ok: false,
    content: JSON.stringify({ error: "This change could not be applied." }),
    summary: "This change could not be applied.",
  };
}
