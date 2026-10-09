import { validate, type ClipDocument } from "@opencmo/clip-doc";
import { describe, expect, it } from "vitest";

import { readCaptionState, readCaptionStyle } from "./captions";
import { nodes, sceneOf } from "./doc";
import { OpError, applyOps, captionsOnTop, describeOp, type OpContext } from "./ops";
import { fitCamera, readFrame } from "./reframe";
import { summarizeProject } from "./summary";
import {
  keptRanges,
  locateWord,
  mergeRanges,
  mergeWithNext,
  normalize,
  nudgeWord,
  rangeOfWords,
  remapTranscript,
  setWordText,
  splitSegment,
  type Transcript,
} from "./transcript";

/** Đúng hình dạng mà `generateProject` sinh ra: 9:16, bám mặt, master cắt ở `sourceIn` 2. */
const SOURCE: ClipDocument = {
  version: 1,
  stage: {
    background: "#000000",
    camera: [0.25, 0, 0, 0.25, 235, 70],
    children: [
      {
        kind: "scene",
        name: "Clip",
        width: 1080,
        height: 1920,
        fill: "#000000",
        active: true,
        workarea: [0, 30],
        marks: { reframe: { focus: 0.5, track: [[2, 0.3], [16, 0.75]], mode: "fill" } },
        children: [
          {
            kind: "video",
            src: "assets/master.mp4",
            x: -484,
            y: 0,
            width: 3413.33,
            height: 1920,
            objectFit: "cover",
            start: 0,
            sourceIn: 2,
            sourceOut: 32,
            tracks: [
              {
                property: "x",
                keyframes: [
                  { time: 2, value: -484, easing: "easeInOut" },
                  { time: 16, value: -2020, easing: "easeInOut" },
                ],
              },
            ],
          },
          { kind: "captions", src: "assets/transcript.json", preset: "classic", verticalAlign: "bottom", start: 0, sourceIn: 2, sourceOut: 32 },
        ],
      },
    ],
  },
};

/** Sửa một bản sao của SOURCE. */
function variant(edit: (scene: { width: number; height: number; children: Record<string, unknown>[] }) => void): ClipDocument {
  const document = structuredClone(SOURCE);
  edit(document.stage.children[0] as never);
  return document;
}

const TRANSCRIPT: Transcript = [
  {
    text: "so this is um the thing",
    words: [
      { text: "so", start: 2.1, end: 2.3 },
      { text: "this", start: 2.35, end: 2.6 },
      { text: "is", start: 2.65, end: 2.8 },
      { text: "um", start: 3.0, end: 3.4 },
      { text: "the", start: 3.5, end: 3.7 },
      { text: "thing", start: 3.75, end: 4.2 },
    ],
  },
  {
    text: "you need",
    words: [
      { text: "you", start: 10, end: 10.3 },
      { text: "need", start: 10.35, end: 10.8 },
    ],
  },
];

/** Ctx trong bộ nhớ: transcript theo đường dẫn, lưu thì đặt tên theo thứ tự. */
function memoryContext(): OpContext & { files: Map<string, Transcript> } {
  const files = new Map<string, Transcript>([["assets/transcript.json", TRANSCRIPT]]);
  return {
    files,
    master: { width: 1920, height: 1080 },
    readTranscript: async (path) => {
      const found = files.get(path);
      if (!found) throw new Error(`missing ${path}`);
      return structuredClone(found);
    },
    saveTranscript: async (transcript) => {
      const path = `assets/transcripts/${String(files.size).padStart(64, "0")}.json`;
      files.set(path, structuredClone(transcript));
      return path;
    },
  };
}

const ids = normalize(TRANSCRIPT).flatMap((segment) => segment.words.map((word) => word.id!));

describe("id từ ổn định", () => {
  it("tất định theo mốc: đọc lại cùng transcript ra cùng id", () => {
    expect(ids).toEqual(normalize(structuredClone(TRANSCRIPT)).flatMap((s) => s.words.map((w) => w.id)));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(`w${(2100).toString(36)}`);
  });

  it("trùng mốc thì thêm hậu tố, không đè id có sẵn", () => {
    const dup = normalize([
      { text: "a b", words: [{ text: "a", start: 1, end: 1 }, { id: "w1", text: "b", start: 1, end: 1.2 }] },
    ]);
    expect(dup[0]!.words.map((word) => word.id)).toEqual([`w${(1000).toString(36)}`, "w1"]);
    const clash = normalize([
      { text: "a b", words: [{ text: "a", start: 1, end: 1.1 }, { id: `w${(1000).toString(36)}`, text: "b", start: 1.2, end: 1.3 }] },
    ]);
    expect(clash[0]!.words[1]!.id).toBe(`w${(1000).toString(36)}`);
    expect(clash[0]!.words[0]!.id).toBe(`w${(1000).toString(36)}-2`);
  });

  it("giữ qua sửa chữ, tách, gộp, nudge và remap", () => {
    const base = normalize(TRANSCRIPT);
    const edited = setWordText(base, [0, 5], "stuff here");
    expect(edited[0]!.words[5]!.id).toBe(ids[5]);
    expect(edited[0]!.words[6]!.id).toMatch(/^w/);
    expect(new Set(edited.flatMap((s) => s.words.map((w) => w.id))).size).toBe(9);

    const split = splitSegment(base, [0, 3]);
    expect(split.flatMap((s) => s.words.map((w) => w.id))).toEqual(ids);
    expect(mergeWithNext(split, 0).flatMap((s) => s.words.map((w) => w.id))).toEqual(ids);
    expect(nudgeWord(base, [0, 1], "end", 0.02)[0]!.words[1]!.id).toBe(ids[1]);

    const kept = keptRanges({ start: 2, end: 32 }, [{ start: 2.97, end: 3.73 }]);
    expect(remapTranscript(base, kept)[0]!.words.map((w) => w.id)).toEqual([ids[0], ids[1], ids[2], ids[5]]);
    expect(locateWord(split, ids[4]!)).toEqual([1, 1]);
  });
});

const kinds = (document: ClipDocument) => nodes(document).map((node) => node.kind);
const find = (document: ClipDocument, kind: string) => nodes(document).find((node) => node.kind === kind) as Record<string, unknown> | undefined;

describe("applyOps", () => {
  it("remove_words theo id ra đúng khoảng như cách tính theo vị trí cũ", async () => {
    const ctx = memoryContext();
    const { document, results } = await applyOps(SOURCE, [{ op: "remove_words", word_ids: [ids[3], ids[4]] }], ctx);
    const base = normalize(TRANSCRIPT);
    const expected = mergeRanges([rangeOfWords([base[0]!.words[3]!, base[0]!.words[4]!], { start: 2, end: 32 })!]);
    expect(readCaptionState(document)!.removed).toEqual(expected);
    expect(results).toEqual([{ op: "remove_words", summary: "Remove 2 words from the video", changed: true }]);
    expect(kinds(document)).toContain("sequence");
    // Id stamp cho mọi phần tử — kể cả các đoạn video mới của sequence.
    expect(summarizeProject(document).elements.every((element) => element.id)).toBe(true);
  });

  it("remove_words có độ chặt: ăn khoảng hở, chừa đúng phần lặng cạnh từ còn lại", async () => {
    const balanced = await applyOps(SOURCE, [{ op: "remove_words", word_ids: [ids[3]], tightness: "balanced" }], memoryContext());
    // "is" hết 2.8, "the" bắt đầu 3.5: chừa 0.15 sau "is"; phía sau khoảng hở ngắn hơn thì chỉ đệm CUT_PAD.
    expect(readCaptionState(balanced.document)!.removed).toEqual([{ start: 2.95, end: 3.43 }]);
    const tight = await applyOps(SOURCE, [{ op: "remove_words", word_ids: [ids[3]], tightness: "tight" }], memoryContext());
    expect(readCaptionState(tight.document)!.removed).toEqual([{ start: 2.86, end: 3.44 }]);
    // Từ cuối cửa sổ: cắt tới mép, không để khoảng chết cuối clip.
    const tail = await applyOps(SOURCE, [{ op: "remove_words", word_ids: [ids[7]], tightness: "loose" }], memoryContext());
    // "you" hết 10.3, "need" bắt đầu 10.35: khoảng hở ngắn hơn padding → chỉ đệm CUT_PAD.
    expect(readCaptionState(tail.document)!.removed).toEqual([{ start: 10.32, end: 32 }]);
  });

  it("remove_silence: cắt khoảng ≥ min_pause, chừa padding cạnh lời, không chừa ở mép cửa sổ", async () => {
    const { document, results } = await applyOps(SOURCE, [{ op: "remove_silence" }], memoryContext());
    expect(readCaptionState(document)!.removed).toEqual([
      { start: 4.35, end: 9.85 },
      { start: 10.95, end: 32 },
    ]);
    expect(results[0]).toMatchObject({ op: "remove_silence", changed: true });
    const strict = await applyOps(SOURCE, [{ op: "remove_silence", min_pause: 0.25, padding: 0 }], memoryContext());
    // Khoảng 0.25s giữa "is" (2.8) và "um" (3.0) chưa đủ dài — 0.2s; giữa "um" và "the" 0.1s.
    expect(readCaptionState(strict.document)!.removed).toEqual([
      { start: 4.2, end: 10 },
      { start: 10.8, end: 32 },
    ]);
  });

  it("không sửa document đầu vào", async () => {
    const before = structuredClone(SOURCE);
    await applyOps(SOURCE, [{ op: "remove_words", word_ids: [ids[3]] }, { op: "set_frame", width: 1080, height: 1080 }], memoryContext());
    expect(SOURCE).toEqual(before);
  });

  it("từ không liền nhau là nhiều khoảng, không nuốt phần giữa", async () => {
    const { document } = await applyOps(SOURCE, [{ op: "remove_words", word_ids: [ids[0], ids[6]] }], memoryContext());
    expect(readCaptionState(document)!.removed).toHaveLength(2);
  });

  it("restore_words và restore_all đưa document về không cắt", async () => {
    const ctx = memoryContext();
    const cut = await applyOps(SOURCE, [{ op: "remove_words", word_ids: [ids[3]] }], ctx);
    const restored = await applyOps(cut.document, [{ op: "restore_words", word_ids: [ids[3]] }], ctx);
    expect(readCaptionState(restored.document)!.removed).toEqual([]);
    expect(kinds(restored.document)).not.toContain("sequence");
    const all = await applyOps(cut.document, [{ op: "restore_all" }], ctx);
    expect(readCaptionState(all.document)!.removed).toEqual([]);
  });

  it("edit_words lưu transcript mới và trỏ <captions> vào nó", async () => {
    const ctx = memoryContext();
    const { document } = await applyOps(SOURCE, [{ op: "edit_words", edits: [{ word_id: ids[5], text: "stuff" }] }], ctx);
    const base = readCaptionState(document)!.base!;
    expect(base).toMatch(/^assets\/transcripts\//);
    expect(ctx.files.get(base)![0]!.words[5]).toMatchObject({ id: ids[5], text: "stuff" });
  });

  it("split_line/merge_lines/nudge_word đi qua transcript theo id", async () => {
    const ctx = memoryContext();
    const split = await applyOps(SOURCE, [{ op: "split_line", word_id: ids[3] }], ctx);
    expect(ctx.files.get(readCaptionState(split.document)!.base!)).toHaveLength(3);
    const merged = await applyOps(split.document, [{ op: "merge_lines", word_id: ids[0] }], ctx);
    expect(ctx.files.get(readCaptionState(merged.document)!.base!)).toHaveLength(2);
    const nudged = await applyOps(SOURCE, [{ op: "nudge_word", word_id: ids[1], edge: "end", seconds: 0.03 }], ctx);
    expect(ctx.files.get(readCaptionState(nudged.document)!.base!)![0]!.words[1]!.end).toBe(2.63);
  });

  it("set_frame và set_caption_style", async () => {
    const { document } = await applyOps(
      SOURCE,
      [
        { op: "set_frame", width: 1080, height: 1080 },
        { op: "set_caption_style", preset: "spotlight", colors: ["#FFD400"] },
      ],
      memoryContext(),
    );
    expect(readFrame(document)).toEqual({ width: 1080, height: 1080, mode: "fill" });
    expect(readCaptionStyle(document)).toEqual({ preset: "spotlight", colors: ["#FFD400"] });
  });

  it("set_frame không có video người nói (F1 New edit): đổi khung, lớp khác co theo; có video mà chưa có master thì báo", async () => {
    const blank = {
      version: 1,
      stage: { children: [{ kind: "scene", name: "Edit", width: 1080, height: 1920, active: true, children: [{ kind: "rect", x: 0, y: 960, width: 1080, height: 960 }] }] },
    } as unknown as ClipDocument;
    const { document } = await applyOps(blank, [{ op: "set_frame", width: 1080, height: 1080 }], { ...memoryContext(), master: null });
    expect(readFrame(document)).toMatchObject({ width: 1080, height: 1080 });
    const rect = (sceneOf(document) as unknown as { children: { y: number; height: number }[] }).children[0]!;
    expect(rect.y).toBe(540);
    await expect(applyOps(SOURCE, [{ op: "set_frame", width: 1080, height: 1080 }], { ...memoryContext(), master: null })).rejects.toThrow(/not ready/);
  });

  it("set_project_settings (E2-b): fps lưu trên scene, cỡ theo tỉ lệ/chất lượng, khung có video đi đường set_frame", async () => {
    const ctx = memoryContext();
    const fps = (await applyOps(SOURCE, [{ op: "set_project_settings", fps: 60 }], ctx)).document;
    expect((sceneOf(fps) as { fps?: number }).fps).toBe(60);
    const back = (await applyOps(fps, [{ op: "set_project_settings", fps: 30 }], ctx)).document;
    expect((sceneOf(back) as { fps?: number }).fps).toBeUndefined();
    const wide = (await applyOps(SOURCE, [{ op: "set_project_settings", aspectRatio: "16:9" }], ctx)).document;
    expect(readFrame(wide)).toEqual({ width: 1920, height: 1080, mode: "fill" });
    const four = (await applyOps(SOURCE, [{ op: "set_project_settings", quality: "4K" }], ctx)).document;
    expect(readFrame(four)).toMatchObject({ width: 2160, height: 3840 });
    const custom = (await applyOps(SOURCE, [{ op: "set_project_settings", width: 1001, height: 1500 }], ctx)).document;
    expect(readFrame(custom)).toMatchObject({ width: 1002, height: 1500 });
    await expect(applyOps(SOURCE, [{ op: "set_project_settings", width: 1000 }], ctx)).rejects.toThrow(/both width and height/);
    await expect(applyOps(SOURCE, [{ op: "set_project_settings", fps: 29 }], ctx)).rejects.toThrow();
    // Timeline trống (không video chính): chỉ đổi cỡ khung.
    const stamped = (await applyOps(SOURCE, [{ op: "set_caption_style", preset: "spotlight" }], ctx)).document;
    const blank = (await applyOps(stamped, [{ op: "create_timeline" }, { op: "set_project_settings", width: 1280, height: 720 }], ctx)).document;
    const [main, empty] = blank.stage.children as unknown as { width: number; height: number }[];
    expect([empty!.width, empty!.height]).toEqual([1280, 720]);
    expect([main!.width, main!.height]).toEqual([1080, 1920]);
  });

  it("hai timeline (E2-a): set_frame và cắt chữ sửa timeline đang mở, bản gốc giữ nguyên", async () => {
    const ctx = memoryContext();
    // SOURCE chưa có id: một lượt op stamp id rồi nhân bản theo id thật.
    const stamped = (await applyOps(SOURCE, [{ op: "set_caption_style", preset: "spotlight" }], ctx)).document;
    const mainId = stamped.stage.children[0]!.id!;
    const two = (await applyOps(stamped, [{ op: "create_timeline", from: mainId, name: "Square" }], ctx)).document;
    const squared = (await applyOps(two, [{ op: "set_frame", width: 1080, height: 1080 }], ctx)).document;
    expect(readFrame(squared)).toEqual({ width: 1080, height: 1080, mode: "fill" });
    const [main, square] = squared.stage.children as unknown as { width: number; height: number }[];
    expect([main!.width, main!.height]).toEqual([1080, 1920]);
    expect([square!.width, square!.height]).toEqual([1080, 1080]);
    expect(summarizeProject(squared).timelines?.map((item) => [item.name, item.active])).toEqual([["Clip", false], ["Square", true]]);
    const back = (await applyOps(squared, [{ op: "set_active_timeline", timeline_id: mainId }], ctx)).document;
    expect(readFrame(back)).toEqual({ width: 1080, height: 1920, mode: "fill" });
  });

  it("set_caption_style: font, độ đậm, màu chữ áp cho MỌI lớp phụ đề; thiếu khoá thì giữ, null thì về preset", async () => {
    const ctx = memoryContext();
    // Thêm một lớp phụ đề thứ hai (như phụ đề voiceover).
    const two = structuredClone(SOURCE) as unknown as { stage: { children: { children: Record<string, unknown>[] }[] } };
    two.stage.children[0]!.children.push({ kind: "captions", name: "Voiceover captions", verticalAlign: "top", start: 0 });
    const styled = (await applyOps(two as unknown as ClipDocument, [{ op: "set_caption_style", preset: "classic", color: "#FFD400", font: "Bebas Neue", weight: 400 }], ctx)).document;
    const layers = (sceneOf(styled)!.children ?? []).filter((child) => child.kind === "captions") as unknown as Record<string, unknown>[];
    expect(layers).toHaveLength(2);
    for (const layer of layers) expect(layer).toMatchObject({ color: "#FFD400", fontFamily: "Bebas Neue", fontWeight: 400 });
    // Vị trí của từng lớp không đổi.
    expect(layers[1]!.verticalAlign).toBe("top");
    const kept = (await applyOps(styled, [{ op: "set_caption_style", preset: "spotlight" }], ctx)).document;
    expect(readCaptionStyle(kept)).toMatchObject({ preset: "spotlight", color: "#FFD400", fontFamily: "Bebas Neue" });
    const reset = (await applyOps(kept, [{ op: "set_caption_style", preset: "spotlight", font: null, color: null, weight: null }], ctx)).document;
    expect(readCaptionStyle(reset)).toEqual({ preset: "spotlight", colors: null });
    await expect(applyOps(styled, [{ op: "set_caption_style", preset: "classic", font: "Comic Sans" }] as never, ctx)).rejects.toThrow();
  });

  it("add_generated đặt ảnh/video DƯỚI phụ đề và chữ, không che chúng", async () => {
    const ctx = memoryContext();
    const kinds = (doc: ClipDocument) => (sceneOf(doc)!.children ?? []).map((child) => child.kind);
    const before = kinds(SOURCE);
    expect(before).toContain("captions");
    const { document } = await applyOps(
      SOURCE,
      [{ op: "add_generated", kind: "video", model: "fake-video", prompt: "3D logo", seed: 1, aspect_ratio: "9:16" }],
      ctx,
    );
    const after = kinds(document);
    // Media sinh ra vào một hàng B-roll (`tracks.ts`).
    const rect = after.lastIndexOf("sequence");
    const firstText = after.findIndex((kind) => kind === "captions" || kind === "text");
    expect(rect).toBeGreaterThanOrEqual(0);
    expect(rect, `thứ tự lớp: ${after.join(" > ")}`).toBeLessThan(firstText);
  });

  it("phụ đề luôn là lớp trên cùng: B-roll phủ khung, chữ, hay kéo phụ đề xuống đều không che được nó", async () => {
    const ctx = memoryContext();
    const kinds = (doc: ClipDocument) => (sceneOf(doc)!.children ?? []).map((child) => child.kind);
    // Agent chèn B-roll phủ kín khung bằng insert_node (đường của insert_asset), rồi thêm hook.
    const stamped = (await applyOps(SOURCE, [{ op: "add_text", text: "Hook", start: 0, end: 3 }], ctx)).document;
    const scene = sceneOf(stamped)!;
    const broll = await applyOps(
      stamped,
      [{ op: "insert_node", parent_id: scene.id, node: { kind: "rect", x: 0, y: 0, width: 1080, height: 1920, start: 0, end: 5, fill: "#FF0000" } }],
      ctx,
    );
    expect(kinds(broll.document).at(-1), kinds(broll.document).join(" > ")).toBe("captions");
    // Kéo phụ đề xuống dưới video (move_layer) → bất biến kéo nó lên lại.
    const captions = sceneOf(broll.document)!.children!.find((child) => child.kind === "captions")!;
    const video = sceneOf(broll.document)!.children!.find((child) => child.kind === "video")!;
    const moved = await applyOps(broll.document, [{ op: "move_layer", element_id: captions.id, parent_id: scene.id, before_id: video.id }], ctx);
    expect(kinds(moved.document).at(-1)).toBe("captions");
    // Thứ tự các lớp còn lại giữ nguyên.
    expect(kinds(moved.document).filter((kind) => kind !== "captions")).toEqual(kinds(broll.document).filter((kind) => kind !== "captions"));
  });

  it("captionsOnTop không đụng document đã đúng thứ tự", () => {
    expect(captionsOnTop(SOURCE)).toBe(SOURCE);
  });

  it("add_generated chèn khai báo generate.* vào khung", async () => {
    const ctx = memoryContext();
    const image = await applyOps(
      SOURCE,
      [{ op: "add_generated", kind: "image", model: "fake-image", prompt: 'A "neon" city {night}', seed: 7, aspect_ratio: "16:9" }],
      ctx,
    );
    // Khung 1080×1920: ảnh 16:9 thu về 1080×608, căn giữa theo chiều dọc.
    expect(find(image.document, "rect")).toMatchObject({
      name: 'A "neon" city {night}',
      keepAspectRatio: true,
      x: 0,
      y: 656,
      width: 1080,
      height: 608,
      paints: [{ type: "image", src: { generate: "image", prompt: 'A "neon" city {night}', model: "fake-image", aspectRatio: "16:9", seed: 7 } }],
    });

    const voice = await applyOps(
      image.document,
      [{ op: "add_generated", kind: "voice", model: "fake-voice", prompt: "Welcome back", voice: "Test A", seed: 1, start: 2 }],
      ctx,
    );
    expect(find(voice.document, "audio")).toMatchObject({ src: { generate: "voice", prompt: "Welcome back", voice: "Test A", seed: 1 }, start: 2 });
    expect(describeOp({ op: "add_generated", kind: "voice", model: "m", prompt: "Welcome back", seed: 1 })).toBe(
      'Generate a voice-over: "Welcome back"',
    );
  });

  it("regenerate đổi seed của khai báo, giữ mọi trường khác; phần tử thường bị từ chối", async () => {
    const ctx = memoryContext();
    const image = await applyOps(
      SOURCE,
      [{ op: "add_generated", kind: "image", model: "fake-image", prompt: "a fox", seed: 7, aspect_ratio: "16:9" }],
      ctx,
    );
    const id = String((find(image.document, "rect") as { id: string }).id);
    const again = await applyOps(image.document, [{ op: "regenerate", element_id: id, seed: 42 }], ctx);
    expect(find(again.document, "rect")).toMatchObject({
      paints: [{ type: "image", src: { generate: "image", prompt: "a fox", model: "fake-image", aspectRatio: "16:9", seed: 42 } }],
    });
    const plain = String((find(again.document, "captions") as { id: string }).id);
    await expect(applyOps(again.document, [{ op: "regenerate", element_id: plain, seed: 1 }], ctx)).rejects.toThrow(/Only AI-generated media/);
  });

  it("enhance_generated nâng độ phân giải, giữ seed + frame; không hạ, không vượt model", async () => {
    const ctx = memoryContext();
    const draft = await applyOps(
      SOURCE,
      [{ op: "add_generated", kind: "video", model: "fake-video", prompt: "a fox", seed: 9, aspect_ratio: "9:16", duration: 3, resolution: "480p", start_frame: "AI/fox.png" }],
      ctx,
    );
    const id = String((find(draft.document, "rect") as { id: string }).id);
    const better = await applyOps(draft.document, [{ op: "enhance_generated", element_id: id, resolution: "720p" }], ctx);
    expect(find(better.document, "rect")).toMatchObject({
      paints: [{ type: "video", src: { generate: "video", prompt: "a fox", seed: 9, resolution: "720p", startFrame: "AI/fox.png" } }],
    });
    await expect(applyOps(better.document, [{ op: "enhance_generated", element_id: id, resolution: "480p" }], ctx)).rejects.toThrow(/cannot be enhanced/);
    await expect(applyOps(better.document, [{ op: "enhance_generated", element_id: id, resolution: "4k" }], ctx)).rejects.toThrow(/cannot be enhanced/);
  });

  it("add_generated B-roll: tắt tiếng + hiện ngắn hơn phần đã trả, frame đầu vào khai báo", async () => {
    const ctx = memoryContext();
    const video = await applyOps(
      SOURCE,
      [{ op: "add_generated", kind: "video", model: "fal-seedance", prompt: "a fox", seed: 3, aspect_ratio: "9:16", duration: 5, start: 4, length: 2.5, muted: true, start_frame: "AI/fox.png", resolution: "720p" }],
      ctx,
    );
    expect(find(video.document, "rect")).toMatchObject({
      start: 4,
      end: 6.5,
      muted: true,
      paints: [{ type: "video", src: { generate: "video", duration: 5, startFrame: "AI/fox.png", resolution: "720p" } }],
    });
    // length không bao giờ dài hơn phần đã sinh; ảnh tĩnh nhận length làm thời lượng.
    const long = await applyOps(SOURCE, [{ op: "add_generated", kind: "video", model: "m", prompt: "x", seed: 1, duration: 5, length: 9 }], ctx);
    expect(find(long.document, "rect")).toMatchObject({ end: 5 });
    const still = await applyOps(SOURCE, [{ op: "add_generated", kind: "image", model: "m", prompt: "x", seed: 1, start: 1, length: 3 }], ctx);
    expect(find(still.document, "rect")).toMatchObject({ start: 1, end: 4 });
    expect(find(still.document, "rect")).not.toHaveProperty("muted");
    // AI transition: video 5 s nén vào 1.25 s để tới đúng frame cuối.
    const fit = await applyOps(SOURCE, [{ op: "add_generated", kind: "video", model: "m", prompt: "x", seed: 1, duration: 5, start: 2, length: 1.25, fit: true }], ctx);
    expect(find(fit.document, "rect")).toMatchObject({ start: 2, end: 3.25, playbackRate: 4 });
  });

  it("add_text, update_element rồi delete_element", async () => {
    const ctx = memoryContext();
    const added = await applyOps(SOURCE, [{ op: "add_text", text: "Wait {for} it", start: 0, end: 99, y: 0.1 }], ctx);
    const text = summarizeProject(added.document).elements.find((element) => element.tag === "text")!;
    // Nhãn là chữ thật, không phải JSX nguyên văn.
    expect(text).toMatchObject({ label: "Wait {for} it", start: 0, end: 30 });
    expect(text.id).toBeTruthy();

    const updated = await applyOps(
      added.document,
      [{ op: "update_element", element_id: text.id!, props: { color: "#FF0000", fontSize: 50.456 }, text: "Watch this" }],
      ctx,
    );
    expect(find(updated.document, "text")).toMatchObject({ color: "#FF0000", fontSize: 50.46, text: "Watch this" });

    // `null` và `false` là bỏ prop — bản TSX cũ ghi `color={null}`, document không đọc được.
    const cleared = await applyOps(updated.document, [{ op: "update_element", element_id: text.id!, props: { color: null } }], ctx);
    expect(find(cleared.document, "text")).not.toHaveProperty("color");
    expect(() => validate(cleared.document)).not.toThrow();

    const deleted = await applyOps(updated.document, [{ op: "delete_element", element_id: text.id! }], ctx);
    expect(kinds(deleted.document)).not.toContain("text");
  });

  it("prop document không nhận thì op lỗi rõ ràng, không ghi gì", async () => {
    const ctx = memoryContext();
    const stamped = (await applyOps(SOURCE, [{ op: "set_caption_style", preset: "stark" }], ctx)).document;
    const video = summarizeProject(stamped).elements.find((element) => element.tag === "video")!;
    await expect(
      applyOps(stamped, [{ op: "update_element", element_id: video.id!, props: { banana: 1 } }], ctx),
    ).rejects.toThrow(/could not be changed \("banana" is not accepted there\)/);
  });

  it("không cho xoá video master hay đổi cửa sổ nguồn của nó", async () => {
    const ctx = memoryContext();
    const stamped = (await applyOps(SOURCE, [{ op: "set_caption_style", preset: "stark" }], ctx)).document;
    const video = summarizeProject(stamped).elements.find((element) => element.tag === "video")!;
    await expect(applyOps(stamped, [{ op: "delete_element", element_id: video.id! }], ctx)).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(
      applyOps(stamped, [{ op: "update_element", element_id: video.id!, props: { sourceIn: 0 } }], ctx),
    ).rejects.toThrow(/transcript/);
  });

  it("op hỏng dừng cả chuỗi, báo đúng vị trí, không trả document nửa vời", async () => {
    const ctx = memoryContext();
    const error = await applyOps(
      SOURCE,
      [
        { op: "set_frame", width: 1080, height: 1080 },
        { op: "remove_words", word_ids: ["nope"] },
      ],
      ctx,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpError);
    expect(error).toMatchObject({ index: 1, op: "remove_words", message: 'The word "nope" is not in this transcript.' });
  });

  it("schema được kiểm trước khi op đầu tiên chạy", async () => {
    const ctx = memoryContext();
    let saved = 0;
    const counting = { ...ctx, saveTranscript: async (t: Transcript) => (saved++, ctx.saveTranscript(t)) };
    await expect(
      applyOps(SOURCE, [{ op: "edit_words", edits: [{ word_id: ids[0], text: "x" }] }, { op: "set_frame", width: 5 }], counting),
    ).rejects.toMatchObject({ index: 1, op: "set_frame" });
    expect(saved).toBe(0);
    await expect(applyOps(SOURCE, [{ op: "write_tsx", source: "" }], ctx)).rejects.toThrow(/Unknown operation/);
  });

  it("cắt hết clip là lỗi đọc được", async () => {
    await expect(applyOps(SOURCE, [{ op: "remove_words", word_ids: ids }], memoryContext())).resolves.toBeTruthy();
    const whole = [{ text: "all", words: [{ text: "all", start: 1.9, end: 32.1 }] }];
    const ctx = { ...memoryContext(), readTranscript: async () => whole };
    await expect(
      applyOps(SOURCE, [{ op: "remove_words", word_ids: normalize(whole)[0]!.words.map((w) => w.id!) }], ctx),
    ).rejects.toThrow("That would remove the whole clip.");
  });

  it("clip không có phụ đề: op phụ đề lỗi rõ ràng, set_caption_style không đổi gì", async () => {
    const bare = variant((scene) => {
      scene.children = scene.children.filter((node) => node.kind !== "captions");
    });
    await expect(applyOps(bare, [{ op: "restore_all" }], memoryContext())).rejects.toThrow("This clip has no captions to edit.");
    const styled = await applyOps(bare, [{ op: "set_caption_style", preset: "stark" }], memoryContext());
    expect(styled.results[0]!.changed).toBe(false);
    expect(styled.document).toEqual(bare);
  });

  it("16:9 đã cắt → 9:16: mọi đoạn video có track bám mặt", async () => {
    const ctx = memoryContext();
    const wide = variant((scene) => {
      scene.width = 1920;
      scene.height = 1080;
      const video = scene.children[0]!;
      Object.assign(video, { x: 0, y: 0, width: 1920, height: 1080 });
      delete video.tracks;
    });
    let { document } = await applyOps(wide, [{ op: "remove_words", word_ids: [ids[3]] }], ctx);
    expect(kinds(document).filter((kind) => kind === "video")).toHaveLength(2);
    ({ document } = await applyOps(document, [{ op: "set_frame", width: 1080, height: 1920 }], ctx));
    const videos = nodes(document).filter((node) => node.kind === "video") as { x?: number; tracks?: { property: string }[] }[];
    expect(videos.every((video) => video.tracks?.some((track) => track.property === "x"))).toBe(true);
    // `x` tĩnh khớp keyframe đầu của track: không giật lúc bắt đầu phát.
    expect(videos[0]!.x).toBe(-484);
    expect(readFrame(document)).toEqual({ width: 1080, height: 1920, mode: "fill" });
  });

  it("fitCamera đặt camera theo vùng canvas, không đổi gì khác", () => {
    const fitted = fitCamera(SOURCE, { width: 900, height: 600 });
    expect(fitted).not.toBe(SOURCE);
    const { camera: _a, ...rest } = fitted.stage as Record<string, unknown>;
    const { camera: _b, ...before } = SOURCE.stage as Record<string, unknown>;
    expect(rest).toEqual(before);
    expect(fitCamera(fitted, { width: 900, height: 600 })).toBe(fitted);
  });

  it("describeOp", () => {
    expect(describeOp({ op: "set_frame", width: 1080, height: 1080 })).toBe("Change the frame to 1080×1080");
  });
});

// Spec editor-rewrite B1: document là nguồn sự thật, TSX chỉ là bản cho fork xem.
// Sau mọi op, document phải qua `validate` và khứ hồi qua TSX y hệt.
describe("kết quả op qua validate và khứ hồi TSX", () => {
  it("chuỗi op thật: sau mỗi bước document hợp lệ và khứ hồi y hệt", async () => {
    const ctx = memoryContext();
    const ops: Parameters<typeof applyOps>[1] = [
      { op: "remove_words", word_ids: [ids[3]!, ids[4]!] },
      { op: "edit_words", edits: [{ word_id: ids[5]!, text: "stuff" }] },
      { op: "split_line", word_id: ids[3]! },
      { op: "nudge_word", word_id: ids[1]!, edge: "end", seconds: 0.03 },
      { op: "set_caption_style", preset: "guinea", colors: ["#FFD400", "#FF0000", "#00FF00"] },
      { op: "add_text", text: "Wait {for} <it>", start: 0, end: 99, y: 0.1, bold: true, font: "Bangers" },
      { op: "add_generated", kind: "image", model: "fake-image", prompt: 'A "neon" city {night}', seed: 7, aspect_ratio: "16:9" },
      { op: "add_generated", kind: "voice", model: "fake-voice", prompt: "Welcome back", voice: "Test A", seed: 1, start: 2 },
      { op: "set_frame", width: 1920, height: 1080 },
      { op: "set_frame", width: 1080, height: 1920, mode: "fit" },
    ];
    let document = SOURCE;
    for (const op of ops) {
      document = (await applyOps(document, [op], ctx)).document;
      expect(validate(document), JSON.stringify(op)).toEqual(document);
    }
    const scene = document.stage.children[0]!;
    // Cắt bằng chữ biến video thành <sequence> nhiều đoạn, mang mark text-cut.
    expect(scene.kind === "scene" && scene.children?.some((node) => node.kind === "sequence" && node.marks?.["text-cut"])).toBe(true);
  });
});

describe("set_layout", () => {
  type Node = Record<string, unknown> & { children?: Node[]; marks?: Record<string, unknown>; tracks?: { property: string; keyframes: { time: number; value: number }[] }[] };
  const sceneOf = (document: ClipDocument) => document.stage.children[0] as unknown as Node;
  const roles = (document: ClipDocument) => sceneOf(document).children!.map((child) => (child.marks?.layout as string | undefined) ?? (child.kind as string));
  const speaker = (document: ClipDocument) => sceneOf(document).children!.find((child) => child.marks?.layout === "speaker")!;

  it("bọc master trong Speaker + panel ngay sau; gọi lại ra cùng kết quả; full gỡ hết", async () => {
    const ctx = memoryContext();
    const { document } = await applyOps(SOURCE, [{ op: "set_layout", mode: "split-bottom", start: 4, end: 12 }], ctx);
    expect(() => validate(document)).not.toThrow();
    expect(roles(document).slice(0, 3)).toEqual(["speaker", "panel", "captions"]);
    const offset = speaker(document).tracks!.find((track) => track.property === "offsetY")!.keyframes;
    // Ngoài khoảng 0, trong khoảng dời xuống (người nói ở dải dưới).
    expect(offset[0]!.value).toBe(0);
    expect(Math.max(...offset.map((k) => k.value))).toBeGreaterThan(0);
    const again = await applyOps(document, [{ op: "set_layout", mode: "split-bottom", start: 4, end: 12 }], ctx);
    expect(again.results[0]!.changed).toBe(false);
    const cleared = await applyOps(document, [{ op: "set_layout", mode: "full" }], ctx);
    expect(roles(cleared.document)).toEqual(roles(SOURCE));
    expect(sceneOf(cleared.document).marks?.layout).toBeUndefined();
  });

  it("panel luôn cao ≥ độ dời của người nói (không lộ khoảng trống khi chuyển)", async () => {
    const { document } = await applyOps(SOURCE, [{ op: "set_layout", mode: "split-bottom", ratio: 0.6 }], memoryContext());
    const panel = sceneOf(document).children!.find((child) => child.marks?.layout === "panel")!;
    const heights = panel.tracks!.find((track) => track.property === "height")!.keyframes;
    const offsets = speaker(document).tracks!.find((track) => track.property === "offsetY")!.keyframes;
    for (const k of offsets) {
      const h = heights.find((item) => item.time === k.time);
      if (h) expect(h.value).toBeGreaterThanOrEqual(k.value);
    }
  });

  it("sống qua cắt chữ và đổi khung: master vẫn trong Speaker, panel theo khung mới", async () => {
    const ctx = memoryContext();
    const { document } = await applyOps(
      SOURCE,
      [
        { op: "set_layout", mode: "split-top", start: 2, end: 10 },
        { op: "remove_words", word_ids: [ids[3]] },
        { op: "set_frame", width: 1080, height: 1080 },
      ],
      ctx,
    );
    expect(() => validate(document)).not.toThrow();
    expect(speaker(document).children![0]!.kind).toBe("sequence");
    const panel = sceneOf(document).children!.find((child) => child.marks?.layout === "panel")!;
    expect(panel.width).toBe(1080);
    const ys = panel.tracks!.find((track) => track.property === "y")!.keyframes.map((k) => k.value);
    expect(Math.max(...ys)).toBeLessThanOrEqual(1080);
  });

  it("visual thêm trong khoảng chia đôi tự vào panel", async () => {
    const { document } = await applyOps(
      SOURCE,
      [
        { op: "set_layout", mode: "split-top", start: 0, end: 10 },
        { op: "add_icon", start: 1, end: 3, name: "rocket" },
      ],
      memoryContext(),
    );
    // Phụ đề luôn là lớp cuối (`captionsOnTop`): lớp visual là lớp cuối KHÔNG phải phụ đề.
    const icon = sceneOf(document).children!.filter((node) => node.kind !== "captions").at(-1)!.children![0]!;
    // split-top: người nói ở nửa trên, icon phải nằm ở nửa dưới.
    expect(icon.y as number).toBeGreaterThan(1920 / 2);
  });
});

describe("set_layout: ca biên (review 29/09)", () => {
  type Keys = { time: number; value: number }[];
  type Node = Record<string, unknown> & { children?: Node[]; marks?: Record<string, unknown>; tracks?: { property: string; keyframes: Keys }[] };
  const scene = (document: ClipDocument) => document.stage.children[0] as unknown as Node;
  const role = (document: ClipDocument, name: string) => scene(document).children!.find((child) => child.marks?.layout === name)!;
  const track = (node: Node, property: string) => node.tracks!.find((item) => item.property === property)!.keyframes;
  // Nội suy tuyến tính: mọi track của layout dùng chung easing và chung mốc nên
  // bất biến "panel phủ phần hở" đúng với tuyến tính thì đúng với easeInOut.
  const at = (keys: Keys, t: number) => {
    if (t <= keys[0]!.time) return keys[0]!.value;
    for (let k = 1; k < keys.length; k++) {
      const a = keys[k - 1]!;
      const b = keys[k]!;
      if (t <= b.time) return a.value + ((b.value - a.value) * (t - a.time)) / (b.time - a.time || 1);
    }
    return keys.at(-1)!.value;
  };

  it("hai khoảng khác chế độ sát nhau: không lộ dải trống lúc chuyển", async () => {
    const { document } = await applyOps(
      SOURCE,
      [
        { op: "set_layout", mode: "split-top", start: 2, end: 10 },
        { op: "set_layout", mode: "split-bottom", start: 10, end: 18 },
      ],
      memoryContext(),
    );
    const H = 1920;
    const offset = track(role(document, "speaker"), "offsetY");
    const panel = role(document, "panel");
    const [ys, hs, ops] = [track(panel, "y"), track(panel, "height"), track(panel, "opacity")];
    for (let t = 0; t <= 20; t += 1 / 120) {
      const o = at(offset, t);
      if (Math.abs(o) < 0.5) continue;
      const y = at(ys, t);
      const h = at(hs, t);
      expect(at(ops, t), `opacity @${t.toFixed(3)}`).toBeGreaterThan(0.99);
      if (o < 0) expect(y + h, `phủ đáy @${t.toFixed(3)}`).toBeGreaterThanOrEqual(H - 0.5);
      if (o < 0) expect(y, `phủ phần hở @${t.toFixed(3)}`).toBeLessThanOrEqual(H + o + 0.5);
      if (o > 0) expect(y + h, `phủ đỉnh @${t.toFixed(3)}`).toBeGreaterThanOrEqual(o - 0.5);
    }
  });

  it("clip ngắn lại sau set_layout: khoảng ngoài clip bị bỏ, không dồn mốc về cuối", async () => {
    const { document } = await applyOps(SOURCE, [{ op: "set_layout", mode: "split-bottom", start: 4, end: 8 }], memoryContext());
    const shorter = structuredClone(document);
    const marks = scene(shorter).marks as { layout: { ranges: { start: number; end: number }[] } };
    marks.layout.ranges.push({ ...marks.layout.ranges[0]!, start: 500, end: 520 });
    const { rebuildLayout } = await import("./layout");
    const rebuilt = rebuildLayout(shorter);
    const offset = track(role(rebuilt, "speaker"), "offsetY");
    expect(Math.max(...offset.map((k) => k.time))).toBeLessThan(500);
    // Sau khoảng thật (4–8) người nói về chỗ cũ.
    expect(at(offset, 12)).toBe(0);
  });

  it("dựng lại sau khứ hồi jsonb (khoá đổi thứ tự) vẫn giữ id, op lặp là không đổi", async () => {
    const ctx = memoryContext();
    const { document } = await applyOps(SOURCE, [{ op: "set_layout", mode: "split-top", start: 2, end: 10 }], ctx);
    const shuffle = (value: unknown): unknown =>
      Array.isArray(value) ? value.map(shuffle) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, shuffle(v)])) : value;
    const stored = shuffle(document) as ClipDocument;
    const again = await applyOps(stored, [{ op: "set_layout", mode: "split-top", start: 2, end: 10 }], ctx);
    expect(again.results[0]!.changed).toBe(false);
    expect(role(again.document, "panel").id).toBe(role(document, "panel").id);
  });
});

describe("set_layout: pip + side-by-side (học Palmier §C3)", () => {
  type Keys = { time: number; value: number }[];
  type Node = Record<string, unknown> & { children?: Node[]; masks?: Node[]; marks?: Record<string, unknown>; tracks?: { property: string; keyframes: Keys }[] };
  const scene = (document: ClipDocument) => document.stage.children[0] as unknown as Node;
  const roles = (document: ClipDocument) => scene(document).children!.map((child) => (child.marks?.layout as string | undefined) ?? (child.kind as string));
  const role = (document: ClipDocument, name: string) => scene(document).children!.find((child) => child.marks?.layout === name)!;
  const track = (node: Node, property: string) => node.tracks!.find((item) => item.property === property)!.keyframes;
  const at = (keys: Keys, time: number) => {
    const after = keys.findIndex((k) => k.time >= time);
    if (after <= 0) return keys[after < 0 ? keys.length - 1 : 0]!.value;
    const a = keys[after - 1]!, b = keys[after]!;
    return a.value + ((b.value - a.value) * (time - a.time)) / (b.time - a.time);
  };

  it("pip: nền dưới, Speaker là rect có mask vuông bo góc, thu về góc; gọi lại không đổi; full gỡ hết", async () => {
    const ctx = memoryContext();
    const { document } = await applyOps(SOURCE, [{ op: "set_layout", mode: "pip", start: 2, end: 10 }], ctx);
    expect(() => validate(document)).not.toThrow();
    expect(roles(document).slice(0, 4)).toEqual(["backdrop", "speaker", "panel", "captions"]);
    const speaker = role(document, "speaker");
    expect(speaker.kind).toBe("rect");
    expect(speaker).toMatchObject({ width: 1080, height: 1920, start: 0 });
    const mask = speaker.masks![0]!;
    // Giữa khoảng: ô vuông 1080 quanh mặt, bo góc; ngoài khoảng: nguyên khung, không bo.
    expect(at(track(mask, "height"), 6)).toBe(1080);
    expect(at(track(mask, "height"), 0.5)).toBe(1920);
    expect(at(track(mask, "cornerRadius"), 6)).toBeGreaterThan(100);
    // Ô trên màn hình ở góc dưới phải: cạnh 0.36 × 1080, lề 4%.
    const scale = at(track(speaker, "scale"), 6);
    expect(scale * 1080).toBeCloseTo(0.36 * 1080, 1);
    const centerX = 540 + at(track(speaker, "offsetX"), 6);
    expect(centerX).toBeCloseTo(1080 - 0.04 * 1080 - (0.36 * 1080) / 2, 0);
    expect(at(track(role(document, "backdrop"), "opacity"), 6)).toBe(1);
    expect(at(track(role(document, "backdrop"), "opacity"), 12)).toBe(0);
    const again = await applyOps(document, [{ op: "set_layout", mode: "pip", start: 2, end: 10 }], ctx);
    expect(again.results[0]!.changed).toBe(false);
    const cleared = await applyOps(document, [{ op: "set_layout", mode: "full" }], ctx);
    expect(roles(cleared.document)).toEqual(roles(SOURCE));
  });

  it("pip góc trên trái: ô ở trên trái, visual tự nằm dưới ô", async () => {
    const { document } = await applyOps(
      SOURCE,
      [
        { op: "set_layout", mode: "pip", start: 0, end: 10, anchor: "top-left" },
        { op: "add_icon", start: 1, end: 3, name: "rocket" },
      ],
      memoryContext(),
    );
    const speaker = role(document, "speaker");
    expect(540 + (speaker.offsetX as number)).toBeLessThan(540);
    expect(960 + (speaker.offsetY as number)).toBeLessThan(960);
    const icon = scene(document).children!.filter((node) => node.kind !== "captions").at(-1)!.children![0]!;
    expect(icon.y as number).toBeGreaterThan(0.36 * 1080 + 0.08 * 1080);
  });

  it("side-by-side: cột người nói bên trái, panel phủ nửa phải, mask là cột", async () => {
    const { document } = await applyOps(SOURCE, [{ op: "set_layout", mode: "side-by-side", start: 2, end: 10 }], memoryContext());
    expect(() => validate(document)).not.toThrow();
    expect(roles(document).slice(0, 3)).toEqual(["speaker", "panel", "captions"]);
    const speaker = role(document, "speaker");
    const mask = speaker.masks![0]!;
    expect(at(track(mask, "width"), 6)).toBe(540);
    expect(540 + at(track(speaker, "offsetX"), 6)).toBe(270);
    const panel = role(document, "panel");
    expect(at(track(panel, "x"), 6)).toBe(540);
    expect(at(track(panel, "width"), 6)).toBe(540);
    expect(at(track(panel, "opacity"), 6)).toBe(1);
  });

  it("từ chối tỉ lệ / góc sai kiểu", async () => {
    await expect(applyOps(SOURCE, [{ op: "set_layout", mode: "pip", ratio: 0.6 }], memoryContext())).rejects.toThrow(/between 0.2 and 0.5/);
    await expect(applyOps(SOURCE, [{ op: "set_layout", mode: "pip", anchor: "left" }], memoryContext())).rejects.toThrow(/corner/);
    await expect(applyOps(SOURCE, [{ op: "set_layout", mode: "side-by-side", anchor: "top-left" }], memoryContext())).rejects.toThrow(/left or the right/);
    await expect(applyOps(SOURCE, [{ op: "set_layout", mode: "split-top", ratio: 0.25 }], memoryContext())).rejects.toThrow(/between 0.3 and 0.7/);
  });

  it("chia trên/dưới rồi pip liền nhau: dựng một Speaker rect, chia trên/dưới vẫn dời đúng", async () => {
    const { document } = await applyOps(
      SOURCE,
      [
        { op: "set_layout", mode: "split-bottom", start: 1, end: 5 },
        { op: "set_layout", mode: "pip", start: 5, end: 9 },
      ],
      memoryContext(),
    );
    expect(() => validate(document)).not.toThrow();
    const speaker = role(document, "speaker");
    expect(speaker.kind).toBe("rect");
    expect(at(track(speaker, "offsetY"), 3)).toBeGreaterThan(0);
    expect(at(track(speaker, "scale"), 3)).toBe(1);
    expect(at(track(speaker, "scale"), 7)).toBeLessThan(0.5);
  });
});

describe("check covers-speaker", () => {
  it("visual đặt thẳng vào dải người nói bị báo", async () => {
    const { checkDocument } = await import("./check");
    const { document } = await applyOps(
      SOURCE,
      [
        { op: "set_layout", mode: "split-bottom", start: 0, end: 10 },
        { op: "add_icon", start: 2, end: 5, name: "rocket", at: [0.5, 0.8], size: 0.3 },
        { op: "add_icon", start: 2, end: 5, name: "star" },
      ],
      memoryContext(),
    );
    const flagged = checkDocument(document, { duration: () => 30 }).issues.filter((issue) => issue.code === "covers-speaker");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.message).toMatch(/rocket/);
  });
});

describe("quote: visual neo vào câu người nói", () => {
  it("không có start/end: đặt theo mốc CLIP của câu, kể cả sau khi cắt", async () => {
    const ctx = memoryContext();
    // "you need" ở giây nguồn 10 → giây clip 8 (sourceIn 2).
    const plain = await applyOps(SOURCE, [{ op: "add_icon", name: "rocket", quote: "you need" }] as never, ctx);
    const icon = (plain.document.stage.children[0] as unknown as { children: Record<string, unknown>[] }).children.filter((node) => node.kind !== "captions").at(-1)!;
    expect(icon.start).toBeCloseTo(8, 1);
    expect((icon.marks as { visual: { input: { quote: string } } }).visual.input.quote).toBe("you need");
    // Cắt "um" (nguồn 3.0–3.4) → câu dời lên sớm hơn.
    const umId = normalize(TRANSCRIPT)[0]!.words[3]!.id!;
    const cut = await applyOps(SOURCE, [{ op: "remove_words", word_ids: [umId] }, { op: "add_icon", name: "rocket", quote: "you need" }] as never, memoryContext());
    const after = (cut.document.stage.children[0] as unknown as { children: Record<string, unknown>[] }).children.filter((node) => node.kind !== "captions").at(-1)!;
    expect(after.start as number).toBeLessThan(8);
  });

  it("câu không có trong clip, hay thiếu cả thời gian lẫn câu → lỗi đọc được", async () => {
    await expect(applyOps(SOURCE, [{ op: "add_icon", name: "rocket", quote: "compound interest wins" }] as never, memoryContext())).rejects.toThrow(/not in this clip's transcript/);
    await expect(applyOps(SOURCE, [{ op: "add_icon", name: "rocket" }] as never, memoryContext())).rejects.toThrow(/quote/);
  });

  it("set_layout theo câu: bố cục bắt đầu đúng câu", async () => {
    const { document } = await applyOps(SOURCE, [{ op: "set_layout", mode: "split-bottom", quote: "you need" }] as never, memoryContext());
    const range = (document.stage.children[0] as unknown as { marks: { layout: { ranges: { start: number; end: number }[] } } }).marks.layout.ranges[0]!;
    expect(range.start).toBeCloseTo(8, 1);
    expect(range.end - range.start).toBeGreaterThanOrEqual(3);
  });
});

describe("apply_brand", () => {
  const LOGO = { object: "6b519a71-93a7-412e-8274-2444a7343a08/logo-8d519a71-93a7-412e-8274-2444a7343a08.png", width: 400, height: 200, corner: "top-left", size: 0.2, opacity: 0.9 };
  const KIT = {
    version: 1,
    colors: { primary: "#FF5A1F", secondary: "#1F2937", accent: "#22C55E", text: "#F9FAFB", background: "#111827" },
    fonts: { heading: "Anton", body: "DM Sans" },
    captions: { preset: "spotlight", fontScale: 1.2, position: "center" },
    layout: { aspect: "1:1", fit: "fill" },
    logo: LOGO,
  };
  const withTitle = variant((scene) => {
    scene.children.push({ kind: "text", text: "Hook", x: 100, y: 100, width: 880, height: 120, fontFamily: "Inter", fontSize: 72, color: "#FFFFFF", start: 0, end: 3 });
  });

  it("một op: khung, phụ đề, font tiêu đề, logo, mark brand", async () => {
    const { document } = await applyOps(withTitle, [{ op: "apply_brand", kit: KIT }], memoryContext());
    expect(() => validate(document)).not.toThrow();
    expect(readFrame(document)).toMatchObject({ width: 1080, height: 1080, mode: "fill" });
    expect(find(document, "captions")).toMatchObject({ preset: "spotlight", colors: ["#22C55E"], fontScale: 1.2, verticalAlign: "center" });
    expect(find(document, "text")).toMatchObject({ fontFamily: "Anton" });
    const logo = nodes(document).find((node) => (node as { marks?: Record<string, unknown> }).marks?.["brand-logo"]) as Record<string, unknown>;
    expect(logo).toMatchObject({ kind: "rect", width: 216, height: 108, opacity: 0.9, start: 0, end: 30 });
    expect((logo.paints as { src: string }[])[0]!.src).toBe(`brand:${LOGO.object}`);
    expect((sceneOf(document) as unknown as { marks: { brand: unknown } }).marks.brand).toEqual(KIT);
  });

  it("áp lại thì thay logo, không nhân đôi; frame: false giữ khung", async () => {
    const ctx = memoryContext();
    const once = await applyOps(withTitle, [{ op: "apply_brand", kit: KIT, frame: false }], ctx);
    const twice = await applyOps(once.document, [{ op: "apply_brand", kit: { ...KIT, logo: { ...LOGO, corner: "bottom-right" } }, frame: false }], ctx);
    const logos = nodes(twice.document).filter((node) => (node as { marks?: Record<string, unknown> }).marks?.["brand-logo"]);
    expect(logos).toHaveLength(1);
    expect(readFrame(twice.document)).toMatchObject({ width: 1080, height: 1920 });
    // Góc dưới phải lùi lên, chừa chỗ watermark.
    expect((logos[0] as { y: number }).y).toBeLessThan(1920 - 43 - 108 - 1);
  });

  it("visual thêm sau lấy màu/font của kit; đổi kit thì visual cũ đổi theo", async () => {
    const ctx = memoryContext();
    const branded = await applyOps(SOURCE, [{ op: "apply_brand", kit: { ...KIT, logo: null }, frame: false }, { op: "add_chart", start: 1, end: 4, type: "bar", data: [{ label: "a", value: 1 }, { label: "b", value: 2 }] }], ctx);
    const json = JSON.stringify(branded.document);
    expect(json).toContain("#22C55E");
    expect(json).not.toContain("#FACC15");
    expect(json).toContain('"fontFamily":"Anton"');
    const next = await applyOps(branded.document, [{ op: "apply_brand", kit: { ...KIT, logo: null, colors: { ...KIT.colors, accent: "#E11D48" } }, frame: false }], ctx);
    const after = JSON.stringify(nodes(next.document).filter((node) => (node as { marks?: Record<string, unknown> }).marks?.visual));
    expect(after).toContain("#E11D48");
    expect(after).not.toContain("#22C55E");
  });

  it("kit sai bị từ chối bằng câu đọc được", async () => {
    await expect(applyOps(SOURCE, [{ op: "apply_brand", kit: { ...KIT, fonts: { heading: "Comic Sans", body: "Inter" } } }], memoryContext())).rejects.toThrow(/heading/);
  });
});

describe("make_room (F2 ripple insert)", () => {
  it("dời các lớp bắt đầu từ `at` trở đi, lớp đang chiếu qua giữ nguyên; không dời video người nói", async () => {
    const blank = {
      version: 1,
      stage: { children: [{ kind: "scene", name: "Edit", width: 1080, height: 1920, active: true, children: [
        { kind: "rect", id: "a", start: 0, end: 4, width: 10, height: 10 },
        { kind: "rect", id: "b", start: 4, end: 6, width: 10, height: 10 },
        { kind: "text", id: "c", text: "hi", start: 5, end: 8 },
      ] }] },
    } as unknown as ClipDocument;
    const { document } = await applyOps(blank, [{ op: "make_room", at: 4, seconds: 2 }], { ...memoryContext(), master: null });
    const kids = (sceneOf(document) as unknown as { children: { id: string; start: number; end: number }[] }).children;
    expect(kids.map((kid) => [kid.id, kid.start, kid.end])).toEqual([["a", 0, 4], ["b", 6, 8], ["c", 7, 10]]);
    await expect(applyOps(SOURCE, [{ op: "make_room", at: 0, seconds: 2 }], memoryContext())).rejects.toThrow(/own video or captions/);
  });
});
