/**
 * Bài eval của agent editor (spec agent-editor §6): câu lệnh như người dùng
 * gõ, chấm bằng code trên document cuối — không chấm bằng model. Mỗi grader
 * chỉ đòi điều câu lệnh đòi, và không cho qua khi agent làm hỏng thứ khác
 * (cắt quá tay, `check` còn lỗi).
 */

import type { ClipDocument } from "@opencmo/clip-doc";
import {
  MASTER_SRC,
  clipWords,
  findQuote,
  findSilences,
  isRemoved,
  keptDuration,
  keptRanges,
  readCaptionState,
  readCaptionStyle,
  readFrame,
  readLayout,
  toOutput,
  walk,
  type CheckReport,
  type Entity,
} from "@opencmo/editor-core";

import type { PreparedGeneration } from "../generate-tool";
import { TRANSCRIPT } from "./fixture";

export type Outcome = { document: ClipDocument; report: CheckReport; tools: string[]; generations?: PreparedGeneration[] };
export type Grade = { pass: boolean; notes: string[] };

export type EvalTask = {
  id: string;
  prompt: string;
  /** Sửa document mẫu trước khi chạy (cài sẵn lỗi cho bài "sửa lỗi"). */
  setup?: (document: ClipDocument) => void;
  /** Câu trả lời khi agent hỏi (`ask_user`). */
  answer?: string;
  grade: (outcome: Outcome) => Grade;
};

type Found = { entity: Entity; tag: string; parent: Entity | null };
function all(document: ClipDocument): Found[] {
  const out: Found[] = [];
  walk(document, ({ entity, tag, parent }) => out.push({ entity, tag, parent }));
  return out;
}
const texts = (document: ClipDocument) => all(document).filter((item) => item.tag === "text");
const words = () => TRANSCRIPT.flatMap((segment) => segment.words);

function state(document: ClipDocument) {
  const caption = readCaptionState(document);
  const window = caption?.window ?? { start: 0, end: 30 };
  const removed = caption?.removed ?? [];
  const kept = keptRanges(window, removed);
  return { window, removed, kept, duration: keptDuration(kept) };
}

/** Mốc trên timeline clip (sau cắt) của một từ nguồn. */
function clipTime(document: ClipDocument, text: string): number | null {
  const word = words().find((item) => item.text.toLowerCase() === text.toLowerCase());
  return word ? toOutput(word.start, state(document).kept) : null;
}

function check(notes: string[], ok: boolean, message: string): boolean {
  if (!ok) notes.push(message);
  return ok;
}

/** Luật chung: không còn lỗi `check`, không cắt quá 30% clip. */
function sane(outcome: Outcome, notes: string[]): boolean {
  const errors = outcome.report.issues.filter((issue) => issue.severity === "error");
  const a = check(notes, !errors.length, `check still has errors: ${errors.map((issue) => issue.code).join(", ")}`);
  const b = check(notes, state(outcome.document).duration >= 21, `cut too much: ${state(outcome.document).duration}s left`);
  return a && b;
}

const hasAnimation = (entity: Entity, phase?: "in" | "out") =>
  ((entity.animations as { phase?: string }[] | undefined) ?? []).some((animation) => !phase || (animation.phase ?? "in") === phase);

const srcOf = (entity: Entity): string[] => [
  ...(typeof entity.src === "string" ? [entity.src] : []),
  ...(((entity.paints as { src?: unknown }[] | undefined) ?? []).flatMap((paint) => (typeof paint.src === "string" ? [paint.src] : []))),
];

const masters = (document: ClipDocument) => all(document).filter((item) => item.tag === "video" && item.entity.src === MASTER_SRC);

export const TASKS: EvalTask[] = [
  {
    id: "filler",
    prompt: "Remove the filler words.",
    grade(outcome) {
      const notes: string[] = [];
      const { removed } = state(outcome.document);
      const gone = (text: string) => words().filter((word) => word.text === text).every((word) => isRemoved(word, removed));
      const fillers = check(notes, gone("um") && gone("uh"), "um/uh still in the video");
      const cutWords = words().filter((word) => isRemoved(word, removed)).length;
      const careful = check(notes, cutWords <= 4, `removed ${cutWords} words (expected about 3)`);
      return { pass: fillers && careful && sane(outcome, notes), notes };
    },
  },
  {
    id: "pauses",
    prompt: "Tighten the pacing by cutting the long pauses.",
    grade(outcome) {
      const notes: string[] = [];
      const { window, removed } = state(outcome.document);
      const left = findSilences({ transcript: TRANSCRIPT, window, removed }, { minGap: 0.8 });
      const tight = check(notes, !left.length, `pauses left: ${left.map((item) => `${item.start}-${item.end}`).join(", ")}`);
      const kept = words().filter((word) => !isRemoved(word, removed)).length;
      const words_ = check(notes, kept >= words().length - 3, `cut ${words().length - kept} spoken words`);
      return { pass: tight && words_ && sane(outcome, notes), notes };
    },
  },
  {
    id: "hook",
    prompt: "Add a bold hook title in the first 3 seconds that says: Nobody tells you this.",
    grade(outcome) {
      const notes: string[] = [];
      const hook = texts(outcome.document).find((item) => /nobody tells you this/i.test(String(item.entity.text)));
      if (!check(notes, Boolean(hook), "no hook text")) return { pass: false, notes };
      const start = Number(hook!.entity.start ?? 0);
      const end = Number(hook!.entity.end ?? 16);
      const timing = check(notes, start <= 0.5 && end >= 1.5 && end <= 4.5, `hook runs ${start}-${end}s`);
      const moves = check(notes, hasAnimation(hook!.entity, "in"), "hook has no entrance animation");
      const bold = check(notes, Number(hook!.entity.fontWeight ?? 400) >= 700, "hook is not bold");
      return { pass: timing && moves && bold && sane(outcome, notes), notes };
    },
  },
  {
    id: "square",
    prompt: "Make this clip square.",
    grade(outcome) {
      const notes: string[] = [];
      const frame = readFrame(outcome.document);
      const square = check(notes, frame?.width === frame?.height && Boolean(frame), `frame is ${frame?.width}x${frame?.height}`);
      return { pass: square && sane(outcome, notes), notes };
    },
  },
  {
    id: "broll",
    prompt: "Show the B-roll from the library while they talk about better hooks.",
    grade(outcome) {
      const notes: string[] = [];
      const broll = all(outcome.document).find((item) => srcOf(item.entity).includes("assets/broll.mp4"));
      if (!check(notes, Boolean(broll), "B-roll not placed")) return { pass: false, notes };
      const at = clipTime(outcome.document, "hooks") ?? 10;
      const start = Number(broll!.entity.start ?? 0);
      const near = check(notes, Math.abs(start - (at - 2)) <= 3, `B-roll starts at ${start}s, "better hooks" is around ${at}s`);
      return { pass: near && sane(outcome, notes), notes };
    },
  },
  {
    id: "captions",
    prompt: "Use the classic caption style with a yellow highlight.",
    grade(outcome) {
      const notes: string[] = [];
      const style = readCaptionStyle(outcome.document);
      const preset = check(notes, style?.preset === "classic", `preset is ${style?.preset}`);
      const yellow = check(
        notes,
        (style?.colors ?? []).some((color) => {
          const value = parseInt(color.slice(1, 7), 16);
          return (value >> 16) > 200 && ((value >> 8) & 255) > 170 && (value & 255) < 110;
        }),
        `colors are ${JSON.stringify(style?.colors)}`,
      );
      return { pass: preset && yellow && sane(outcome, notes), notes };
    },
  },
  {
    id: "zoom",
    prompt: "Add a punch-in zoom on the speaker when they say 'first three seconds'.",
    grade(outcome) {
      const notes: string[] = [];
      const zoomed = masters(outcome.document).some((item) =>
        ((item.entity.tracks as { property: string; keyframes: { value: unknown }[] }[] | undefined) ?? []).some(
          (track) => ["scale", "scaleX", "scaleY"].includes(track.property) && track.keyframes.some((key) => Number(key.value) > 1.04),
        ),
      );
      const scaledGroup = all(outcome.document).some(
        (item) => (item.tag === "group" || item.tag === "scene") && ((item.entity.tracks as { property: string }[] | undefined) ?? []).some((track) => track.property.startsWith("scale")),
      );
      const ok = check(notes, zoomed || scaledGroup, "no scale keyframes on the speaker video");
      return { pass: ok && sane(outcome, notes), notes };
    },
  },
  {
    id: "fix",
    prompt: "Check this clip for problems and fix them.",
    setup(document) {
      const scene = document.stage.children[0] as unknown as { children: Record<string, unknown>[] };
      scene.children.push(
        { kind: "text", id: "ghost", text: "Draft note", opacity: 0, start: 2, end: 6, fontSize: 60, color: "#FFFFFF" },
        { kind: "rect", id: "stray", fill: "#FF0000", x: 5000, y: 5000, width: 200, height: 200, start: 0, end: 4 },
      );
    },
    grade(outcome) {
      const notes: string[] = [];
      const left = outcome.report.issues.filter((issue) => issue.node_id === "ghost" || issue.node_id === "stray");
      const ok = check(notes, !left.length, `still flagged: ${left.map((issue) => issue.code).join(", ")}`);
      return { pass: ok && sane(outcome, notes), notes };
    },
  },
  {
    id: "ask",
    prompt: "Make it better.",
    answer: "Tighten the pacing and add a hook title.",
    grade(outcome) {
      const notes: string[] = [];
      const asked = check(notes, outcome.tools.includes("ask_user"), "did not ask what 'better' means");
      return { pass: asked && sane(outcome, notes), notes };
    },
  },
  {
    id: "cta",
    prompt: "Add a call to action 'Follow for more' in the last 2 seconds.",
    grade(outcome) {
      const notes: string[] = [];
      const cta = texts(outcome.document).find((item) => /follow for more/i.test(String(item.entity.text)));
      if (!check(notes, Boolean(cta), "no call to action")) return { pass: false, notes };
      const { duration } = state(outcome.document);
      const start = Number(cta!.entity.start ?? 0);
      const end = Number(cta!.entity.end ?? 16);
      const timing = check(notes, start >= duration - 2.6 && end >= duration - 0.3, `CTA runs ${start}-${end}s, clip is ${duration}s`);
      return { pass: timing && sane(outcome, notes), notes };
    },
  },
  {
    id: "restyle",
    prompt: "Make the title uppercase, bigger, and give it a black outline.",
    setup(document) {
      const scene = document.stage.children[0] as unknown as { children: Record<string, unknown>[] };
      scene.children.push({
        kind: "text", id: "title0", text: "watch this", start: 0, end: 3, y: 300, width: 1080, height: 216,
        textAlign: "center", textBaseline: "middle", fontSize: 72, fontWeight: 700, color: "#FFFFFF", fontFamily: "Inter",
      });
    },
    grade(outcome) {
      const notes: string[] = [];
      const title = texts(outcome.document).find((item) => /watch this/i.test(String(item.entity.text)));
      if (!check(notes, Boolean(title), "title is gone")) return { pass: false, notes };
      const entity = title!.entity;
      const upper = check(notes, entity.textCase === "upper" || String(entity.text) === "WATCH THIS", "not uppercase");
      const bigger = check(notes, Number(entity.fontSize ?? 0) > 72, `fontSize ${entity.fontSize}`);
      const outline = check(
        notes,
        ((entity.strokes as { color: string }[] | undefined) ?? []).some((stroke) => /^#(0{6}|000)/i.test(stroke.color)),
        "no black stroke",
      );
      return { pass: upper && bigger && outline && sane(outcome, notes), notes };
    },
  },
  {
    id: "endfade",
    prompt: "Fade to black at the very end of the clip.",
    grade(outcome) {
      const notes: string[] = [];
      const { duration } = state(outcome.document);
      const found = all(outcome.document);
      const videoFade = masters(outcome.document).some(
        (item) =>
          hasAnimation(item.entity, "out") ||
          ((item.entity.tracks as { property: string; keyframes: { value: unknown }[] }[] | undefined) ?? []).some(
            (track) => track.property === "opacity" && Number(track.keyframes.at(-1)?.value) <= 0.1,
          ),
      );
      const overlay = found.some(
        (item) =>
          item.tag === "rect" &&
          /^#0{3,6}/i.test(String(item.entity.fill ?? "")) &&
          Number(item.entity.start ?? 0) >= duration - 3 &&
          (hasAnimation(item.entity, "in") || ((item.entity.tracks as { property: string }[] | undefined) ?? []).some((track) => track.property === "opacity")),
      );
      const container = found.some((item) => ["sequence", "group", "scene"].includes(item.tag) && hasAnimation(item.entity, "out"));
      const ok = check(notes, videoFade || overlay || container, "no fade at the end");
      return { pass: ok && sane(outcome, notes), notes };
    },
  },
  {
    id: "steps",
    prompt: "When I say 'start with the result then show how you got there', show those two steps as a simple diagram on screen.",
    grade(outcome) {
      const notes: string[] = [];
      const visual = all(outcome.document).find(
        (item) => item.tag === "group" && (item.entity.marks as { visual?: { op?: string } } | undefined)?.visual?.op === "add_diagram",
      );
      if (!check(notes, Boolean(visual), "no diagram")) return { pass: false, notes };
      const entity = visual!.entity;
      const input = (entity.marks as { visual: { input: { nodes: { label: string }[] } } }).visual.input;
      const two = check(notes, input.nodes.length >= 2 && input.nodes.length <= 4, `${input.nodes.length} nodes`);
      const labels = input.nodes.map((node) => node.label.toLowerCase()).join(" | ");
      const words = check(notes, /result/.test(labels) && /(how|got|process|steps?|show)/.test(labels), `labels: ${labels}`);
      // Hiện trong lúc người nói nói câu đó (mốc clip của "start" … "there").
      const from = clipTime(outcome.document, "result");
      const start = Number(entity.start ?? 0);
      const end = Number(entity.end ?? 0);
      const timed = check(notes, from !== null && start <= from + 0.5 && end >= from + 1.5, `shown ${start}-${end}s, phrase at ${from}s`);
      return { pass: two && words && timed && sane(outcome, notes), notes };
    },
  },
  {
    id: "number",
    prompt: "When I say 'the first three seconds', put a big on-screen 3 SECONDS stat to hammer it home.",
    grade(outcome) {
      const notes: string[] = [];
      const at = clipTime(outcome.document, "three");
      const chart = all(outcome.document).find((item) => {
        const visual = (item.entity.marks as { visual?: { op?: string; input?: { type?: string; data?: { value: number }[] } } } | undefined)?.visual;
        return item.tag === "group" && visual?.op === "add_chart" && visual.input?.type === "stat" && visual.input.data?.[0]?.value === 3;
      });
      const bigText = texts(outcome.document).find((item) => /\b3\b|three/i.test(String(item.entity.text)) && Number(item.entity.fontSize ?? 0) >= 120);
      const found = chart ?? bigText;
      if (!check(notes, Boolean(found), "no big 3 on screen")) return { pass: false, notes };
      const start = Number(found!.entity.start ?? (found!.parent?.start as number | undefined) ?? 0);
      const end = Number(found!.entity.end ?? (found!.parent?.end as number | undefined) ?? 0);
      const timed = check(notes, at !== null && start <= at + 0.5 && end >= at + 0.8, `shown ${start}-${end}s, word at ${at}s`);
      return { pass: timed && sane(outcome, notes), notes };
    },
  },
  {
    id: "split",
    prompt: "While I explain 'start with the result then show how you got there', split the screen: me at the bottom, those two steps as a diagram on top.",
    grade(outcome) {
      const notes: string[] = [];
      const from = clipTime(outcome.document, "result");
      const ranges = readLayout(outcome.document);
      const split = ranges.find((range) => range.mode === "split-bottom" && from !== null && range.start <= from + 0.5 && range.end >= from + 1.5);
      if (!check(notes, Boolean(split), `layout: ${JSON.stringify(ranges)}`)) return { pass: false, notes };
      const diagram = all(outcome.document).find(
        (item) => item.tag === "group" && (item.entity.marks as { visual?: { op?: string } } | undefined)?.visual?.op === "add_diagram",
      );
      const placed = check(notes, Boolean(diagram), "no diagram");
      const covers = outcome.report.issues.filter((issue) => issue.code === "covers-speaker");
      const clear = check(notes, !covers.length, `covers the speaker: ${covers.map((issue) => issue.message).join("; ")}`);
      // Chia đôi chỉ trong đoạn giải thích, không cả clip.
      const short = check(notes, split!.end - split!.start <= 15, `split ${split!.start}-${split!.end}s`);
      return { pass: placed && clear && short && sane(outcome, notes), notes };
    },
  },
  {
    id: "icon",
    prompt: "When I say 'growing an audience', pop a fitting animated icon on screen.",
    grade(outcome) {
      const notes: string[] = [];
      const at = clipTime(outcome.document, "growing");
      const found = all(outcome.document).find((item) => {
        const visual = (item.entity.marks as { visual?: { op?: string; input?: { name?: string; animation?: string } } } | undefined)?.visual;
        return item.tag === "group" && (visual?.op === "add_icon" || visual?.op === "add_lottie");
      });
      if (!check(notes, Boolean(found), "no icon")) return { pass: false, notes };
      const input = (found!.entity.marks as { visual: { op: string; input: { name?: string; animation?: string; motion?: string } } }).visual.input;
      const name = String(input.name ?? input.animation ?? "");
      const fits = check(notes, /user|people|person|trend|grow|chart|sprout|rocket|arrow-up|walk|cheer|megaphone/.test(name), `icon: ${name}`);
      const start = Number(found!.entity.start ?? 0);
      const end = Number(found!.entity.end ?? 0);
      const timed = check(notes, at !== null && start <= at + 0.5 && end >= at + 0.8, `shown ${start}-${end}s, word at ${at}s`);
      return { pass: fits && timed && sane(outcome, notes), notes };
    },
  },
  {
    id: "emoji",
    prompt: "Add a fitting animated emoji reaction when I say 'people lose viewers'.",
    grade(outcome) {
      const notes: string[] = [];
      const at = clipTime(outcome.document, "lose");
      const found = visuals(outcome.document).find((item) => item.op === "add_lottie");
      if (!check(notes, Boolean(found), "no animation")) return { pass: false, notes };
      const animation = String((found!.input as { animation?: string }).animation ?? "");
      const emoji = check(notes, animation.startsWith("emoji/"), `not an emoji: ${animation}`);
      const fits = check(notes, /scream|fearful|anxious|cry|sob|weary|pensive|skull|grimacing|astonished|open-mouth|exploding|chart-down|broken|warning/.test(animation), `emoji: ${animation}`);
      const timed = check(notes, at !== null && found!.start <= at + 0.5 && found!.end >= at + 0.8, `shown ${found!.start}-${found!.end}s, word at ${at}s`);
      return { pass: emoji && fits && timed && sane(outcome, notes), notes };
    },
  },
  {
    id: "explain3d",
    prompt: "Add a 3D visual that explains how growing an audience compounds.",
    grade(outcome) {
      const notes: string[] = [];
      const noGen = check(notes, !outcome.tools.includes("generate_media"), "used generate_media for an explainer");
      // "3D" → cảnh code (spec code-scenes); visual vẽ phẳng vẫn chấp nhận được cho ý trừu tượng.
      const scene = outcome.generations?.find((item) => item.model.id === "studio-3d");
      const drawn = visuals(outcome.document).find((item) => ["add_graph", "add_diagram", "add_chart"].includes(item.op));
      const visual = scene ? { start: Number((scene.op as { start?: number }).start ?? -1), quote: scene.quote } : drawn;
      if (!check(notes, Boolean(visual), "no 3D animation or drawn visual")) return { pass: false, notes };
      const previewed = check(notes, !scene || outcome.tools.includes("preview_3d"), "added a 3D scene without previewing it");
      const at = clipTime(outcome.document, "growing");
      const grounded = check(notes, at !== null && Math.abs(visual!.start - at) <= 1.5, `starts ${visual!.start}s, "growing" at ${at}s`);
      const quoted = check(notes, quoteFound(outcome.document, visual!.quote), `quote not in transcript: ${visual!.quote ?? "(none)"}`);
      return { pass: noGen && previewed && grounded && quoted && sane(outcome, notes), notes };
    },
  },
  {
    id: "brollgen",
    prompt: "Generate a B-roll shot for 'watch the numbers change'.",
    grade(outcome) {
      const notes: string[] = [];
      const gen = outcome.generations?.find((item) => item.model.kind === "video" || item.model.kind === "image");
      if (!check(notes, Boolean(gen), "no AI image/video prepared")) return { pass: false, notes };
      const quoted = check(notes, quoteFound(outcome.document, gen!.quote), `quote not in transcript: ${gen!.quote ?? "(none)"}`);
      const prompt = gen!.spec.prompt.toLowerCase();
      const noText = check(notes, !prompt.includes("watch the numbers change"), "the spoken line leaked into the prompt (models draw it as text)");
      const noWords = check(notes, /no text/.test(prompt), "prompt does not forbid text in the frame");
      const at = clipTime(outcome.document, "numbers");
      const start = Number((gen!.op as { start?: number }).start ?? 0);
      const timed = check(notes, at !== null && Math.abs(start - at) <= 1.5, `starts ${start}s, "numbers" at ${at}s`);
      return { pass: quoted && noText && noWords && timed && sane(outcome, notes), notes };
    },
  },
  {
    id: "brollset",
    prompt: "Generate B-roll: AI shots for the lines that name something concrete",
    grade(outcome) {
      const notes: string[] = [];
      const stills = (outcome.generations ?? []).filter((item) => item.model.kind === "image");
      // Guide broll: ảnh tĩnh trước (rẻ), nhiều shot trong MỘT lượt để duyệt chung một thẻ.
      const several = check(notes, stills.length >= 2, `${stills.length} stills prepared`);
      const noVideo = check(notes, !(outcome.generations ?? []).some((item) => item.model.kind === "video"), "animated before the user saw the stills");
      const quotes = stills.map((item) => item.quote ?? "");
      const grounded = check(notes, quotes.every((quote) => quoteFound(outcome.document, quote)), `quotes: ${quotes.join(" | ")}`);
      const distinct = check(notes, new Set(quotes).size === quotes.length, "two shots on the same line");
      const hook = clipTime(outcome.document, "nobody");
      const starts = stills.map((item) => Number((item.op as { start?: number }).start ?? 0));
      const offHook = check(notes, hook === null || starts.every((start) => start > hook + 1), `starts ${starts.join(", ")}s; hook at ${hook}s`);
      const short = check(
        notes,
        stills.every((item) => {
          const length = (item.op as { length?: number }).length;
          return length !== undefined && length >= 1.5 && length <= 4;
        }),
        "each shot should stay 1.5-4 s",
      );
      return { pass: several && noVideo && grounded && distinct && offHook && short && sane(outcome, notes), notes };
    },
  },
  {
    id: "code3d",
    prompt: "Make a 3D animation for 'the first three seconds' — it's the hero moment of this clip.",
    grade(outcome) {
      const notes: string[] = [];
      // Spec code-scenes: preview trước rồi mới đặt — model phải NHÌN cảnh trước khi trả tiền render.
      const previewed = outcome.tools.indexOf("preview_3d");
      const added = outcome.tools.indexOf("add_3d_scene");
      const order = check(notes, previewed >= 0 && added > previewed, `tools: ${outcome.tools.join(", ")}`);
      const gen = outcome.generations?.find((item) => item.model.id === "studio-3d");
      if (!check(notes, Boolean(gen), "no 3D animation prepared")) return { pass: false, notes };
      const scene = gen!.spec.scene as { template?: string; code_ref?: string } | undefined;
      const code = check(notes, scene?.template === "code" && /^[0-9a-f]{64}$/.test(scene.code_ref ?? ""), `scene: ${JSON.stringify(scene)}`);
      const quoted = check(notes, quoteFound(outcome.document, gen!.quote), `quote not in transcript: ${gen!.quote ?? "(none)"}`);
      const at = clipTime(outcome.document, "three");
      const start = Number((gen!.op as { start?: number }).start ?? -1);
      const timed = check(notes, at !== null && Math.abs(start - at) <= 1.5, `starts ${start}s, "three" at ${at}s`);
      const placed = check(
        notes,
        all(outcome.document).some((item) => ((item.entity.paints as { src?: { model?: string } }[] | undefined) ?? []).some((paint) => paint.src?.model === "studio-3d")),
        "the render is not on the clip",
      );
      return { pass: order && code && quoted && timed && placed && sane(outcome, notes), notes };
    },
  },
  {
    id: "voiceover",
    prompt: "Repurpose this clip: replace the speaker with a new AI narration in your own words, with captions for the new voice.",
    grade(outcome) {
      const notes: string[] = [];
      const gen = outcome.generations?.find((item) => item.model.kind === "voice" && (item.op as { op?: string }).op === "add_voiceover");
      if (!check(notes, Boolean(gen), "no voiceover prepared")) return { pass: false, notes };
      const op = gen!.op as { mode?: string; text?: string; captions?: boolean };
      const replace = check(notes, op.mode === "replace", `mode ${op.mode}`);
      // Kịch bản của chính agent: không chép nguyên một câu dài của người nói.
      const script = (op.text ?? "").toLowerCase();
      const copied = TRANSCRIPT.map((segment) => segment.text.toLowerCase().trim()).filter((line) => line.split(/\s+/).length >= 8 && script.includes(line));
      const own = check(notes, copied.length === 0, `script copies the speaker: ${copied[0] ?? ""}`);
      // Vừa clip: ~3 từ/giây (WORDS_PER_SECOND), cho rộng tới 3.5.
      const count = script.split(/\s+/).filter(Boolean).length;
      const fits = check(notes, count > 0 && count <= state(outcome.document).duration * 3.5, `${count} words for a ${state(outcome.document).duration}s clip`);
      const placed = all(outcome.document).find((item) => item.tag === "audio" && (item.entity.marks as { voiceover?: unknown } | undefined)?.voiceover);
      const onClip = check(notes, Boolean(placed), "the voiceover is not on the clip");
      const muted = check(notes, masters(outcome.document).every((item) => item.entity.muted === true), "the original speech still plays");
      const captions = check(
        notes,
        all(outcome.document).some((item) => item.tag === "captions" && (item.entity.marks as { voiceover?: unknown } | undefined)?.voiceover),
        "no captions for the new voice",
      );
      return { pass: replace && own && fits && onClip && muted && captions && sane(outcome, notes), notes };
    },
  },
  {
    id: "grade",
    prompt: "Give the whole clip a warm cinematic color grade.",
    grade(outcome) {
      const notes: string[] = [];
      const effectsOf = (entity: Entity) => (entity.effects as { type: string; value: number; params?: Record<string, number[]> }[] | undefined) ?? [];
      const shots = masters(outcome.document);
      if (!check(notes, shots.length > 0, "no master video")) return { pass: false, notes };
      let ok = true;
      for (const { entity } of shots) {
        const effects = effectsOf(entity);
        ok = check(notes, effects.length > 0, `${entity.id} has no grade`) && ok;
        // Ấm = kênh đỏ được đẩy hơn kênh xanh (gain của wheels hoặc temperature dương).
        const gain = effects.find((effect) => effect.type === "wheels")?.params?.gain;
        const warm = (gain ? gain[0]! > gain[2]! : false) || effects.some((effect) => effect.type === "temperature" && effect.value > 0);
        ok = check(notes, warm, `${entity.id} is not warmer`) && ok;
        const extreme = effects.some((effect) => ["saturation", "temperature", "highlights", "shadows"].includes(effect.type) && Math.abs(effect.value) > 0.6);
        ok = check(notes, !extreme, `${entity.id} grade is heavy-handed`) && ok;
      }
      return { pass: ok && sane(outcome, notes), notes };
    },
  },
  {
    id: "arrange",
    prompt: "Put the speaker side by side with some B-roll from the library.",
    grade(outcome) {
      const notes: string[] = [];
      const scene = outcome.document.stage.children[0] as unknown as { width: number; marks?: { layout?: { ranges?: { mode: string; rect?: number[] }[] } } };
      const cell = scene.marks?.layout?.ranges?.find((range) => range.mode === "cell");
      let ok = check(notes, !!cell, "the speaker is not in a layout cell");
      if (cell) ok = check(notes, (cell.rect?.[2] ?? 1) <= 0.5 + 1e-6, `speaker cell too wide: ${cell.rect}`) && ok;
      // B-roll lấp nửa còn lại của khung.
      const media = all(outcome.document).filter((item) => item.tag === "rect" && ((item.entity.paints as { type?: string }[] | undefined) ?? []).some((paint) => paint.type === "video" || paint.type === "image"));
      const half = media.some((item) => Math.abs(Number(item.entity.width) - scene.width / 2) < 2);
      ok = check(notes, half, "no B-roll fills half the frame") && ok;
      return { pass: ok && sane(outcome, notes), notes };
    },
  },
  {
    id: "grounded",
    prompt: "Make this clip more visual.",
    grade(outcome) {
      const notes: string[] = [];
      const list = visuals(outcome.document);
      if (!check(notes, list.length > 0, "no visuals")) return { pass: false, notes };
      let ok = true;
      for (const item of list) {
        const hit = quoteHit(outcome.document, item.quote);
        ok = check(notes, Boolean(hit), `${item.op} has no quote from the transcript (${item.quote ?? "none"})`) && ok;
        if (hit) ok = check(notes, Math.abs(item.start - hit.start) <= 0.6, `${item.op} starts ${item.start}s, its line at ${hit.start}s`) && ok;
        ok = check(notes, item.start >= 3, `${item.op} covers the hook (starts ${item.start}s)`) && ok;
      }
      return { pass: ok && sane(outcome, notes), notes };
    },
  },
];

/** Visual (group có mark `visual`) với op, mốc và câu trích. */
function visuals(document: ClipDocument): Array<{ op: string; start: number; end: number; quote?: string; input: Record<string, unknown> }> {
  return all(document)
    .filter((item) => item.tag === "group" && (item.entity.marks as { visual?: unknown } | undefined)?.visual)
    .map((item) => {
      const visual = (item.entity.marks as { visual: { op: string; input?: Record<string, unknown> & { quote?: string } } }).visual;
      return { op: visual.op, start: Number(item.entity.start ?? 0), end: Number(item.entity.end ?? 0), quote: visual.input?.quote, input: visual.input ?? {} };
    });
}

function quoteHit(document: ClipDocument, quote: string | undefined) {
  if (!quote) return null;
  const { window, removed } = state(document);
  return findQuote(clipWords(TRANSCRIPT, window, removed), quote);
}

const quoteFound = (document: ClipDocument, quote: string | undefined): boolean => Boolean(quoteHit(document, quote));
