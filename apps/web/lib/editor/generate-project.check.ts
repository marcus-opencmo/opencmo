/**
 * Bộ sinh document: khung crop, bám mặt động, và những chỗ hỏng IM LẶNG.
 *
 * Không mục nào ở đây ném lỗi khi sai. Document vẫn hợp lệ, canvas vẫn có hình
 * — chỉ là người nói bị cắt mất nửa người, hoặc phụ đề lệch, hoặc timeline
 * rỗng. Đó là lý do chúng được đo bằng assertion chứ không bằng mắt.
 */
import assert from "node:assert/strict";

import { validate, type CaptionsNode, type ClipDocument, type SceneNode, type TextNode, type VideoNode } from "@opencmo/clip-doc";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { generateProject, type EditorFocus, type GenerateInput } from "@/lib/editor/generate-project";
import type { RevisionSettings } from "@/lib/settings-schema";

const settings = (patch: Partial<RevisionSettings> = {}): RevisionSettings =>
  ({
    source_start: 10,
    source_end: 40,
    aspect: "9:16",
    layout: "fill",
    focus_x: 0.5,
    captions: false,
    texts: [],
    ...patch,
  }) as RevisionSettings;

/** 1920×1080, giây 0 của master nằm ở giây 8 của video GỐC. */
const source = { width: 1920, height: 1080, duration: 34, offset: 8 };

/** Mọi project mà file này sinh ra — cuối file kiểm lại tất cả qua `validate`. */
const generated: ClipDocument[] = [];

const build = (patch: Partial<GenerateInput> = {}): ClipDocument => {
  const document = generateProject({ settings: settings(), source, hasTranscript: false, ...patch });
  generated.push(document);
  return document;
};

const sceneOf = (document: ClipDocument): SceneNode => {
  const scene = document.stage.children[0]!;
  assert.equal(scene.kind, "scene");
  return scene as SceneNode;
};

const nodes = <T>(document: ClipDocument, kind: string): T[] =>
  (sceneOf(document).children ?? []).filter((node) => node.kind === kind) as T[];

const videoOf = (document: ClipDocument): VideoNode => nodes<VideoNode>(document, "video")[0]!;
const captionsOf = (document: ClipDocument): CaptionsNode | undefined => nodes<CaptionsNode>(document, "captions")[0];

/** Keyframe của track `x` trên video; rỗng khi khung tĩnh. */
const keys = (document: ClipDocument): { time: number; value: number }[] =>
  (videoOf(document).tracks?.find((track) => track.property === "x")?.keyframes ?? []) as {
    time: number;
    value: number;
  }[];

const times = (document: ClipDocument): number[] => keys(document).map((key) => key.time);
const values = (document: ClipDocument): number[] => keys(document).map((key) => key.value);
const hasTrack = (document: ClipDocument): boolean => keys(document).length > 0;

// --------------------------------------------------------- khung cơ bản
{
  const document = build();
  const scene = sceneOf(document);
  const video = videoOf(document);
  // Thiếu `active`: timeline rỗng, không playhead, KHÔNG CÓ SCENE NÀO ĐỂ EXPORT.
  assert.equal(scene.active, true);
  // `workarea` quyết định khoảng được render. Thiếu nó, export ra độ dài mặc
  // định chứ không phải độ dài clip.
  assert.deepEqual(scene.workarea, [0, 30]);
  // Khung dọc mà không có camera thì project mở ra là một vệt nhỏ giữa canvas.
  assert.deepEqual(document.stage.camera, [0.25, 0, 0, 0.25, 235, 70]);
  // `sourceIn` = source_start − offset. Quên nó là phụ đề và tiếng lệch đúng
  // bằng phần bị cắt ở đầu.
  assert.deepEqual([video.sourceIn, video.sourceOut], [2, 32]);
  // Hộp giữ đúng tỉ lệ nguồn, phóng theo CHIỀU CAO: 1080 → 1920 là ×1.7778.
  assert.deepEqual([video.width, video.height], [3413.33, 1920]);
}

// Không có `face_track` → không có track `x`, chỉ `x` tĩnh.
{
  const document = build();
  assert.equal(hasTrack(document), false);
  // focus 0.5 → cửa sổ ở giữa: 540 − 0.5×3413.33 = −1166.667 (`xForFocus` của editor-core, 3 chữ số).
  assert.equal(videoOf(document).x, -1166.667);
}

// --------------------------------------------------------- bám mặt động
//
// Dãy tâm do worker tính (R4: `steps/reframe.py::editor_focus`, Python là bản
// duy nhất). Ở đây dùng đúng dãy mà fixture parity ghi cho người nói đi từ trái
// sang phải giữa clip (0.3 → 0.75 ở giây 22 gốc = 14 của master): bộ sinh chỉ
// còn việc đổi tâm thành `x` và gắn vào document.
type Case = { name: string; expected: Array<[number, number]> };
const cases = (
  JSON.parse(readFileSync(join(process.cwd(), "..", "..", "tests", "contracts", "reframe", "focus-points.json"), "utf8")) as {
    cases: Case[];
  }
).cases;
const walkingPoints = cases.find((entry) => entry.name === "walking-9x16")!.expected;
const walking: EditorFocus = { frame: walkingPoints, reframe: walkingPoints };

{
  const document = build({ focus: walking });
  assert.ok(hasTrack(document));
  // Mọi mốc dùng easeInOut: mốc không có easing là nhảy bậc giữa hai tâm.
  assert.ok(keys(document).every((key) => (key as { easing?: string }).easing === "easeInOut"));

  const stamps = times(document);
  // Mốc đầu PHẢI là `sourceIn`. Thiếu nó, DS nội suy từ `x` tĩnh tới mốc đầu
  // tiên: một cú trượt ngang ở đầu mỗi clip.
  assert.equal(stamps[0], 2);
  assert.ok(stamps.every((t) => t >= 2 && t <= 32), `mốc ngoài khoảng: ${stamps}`);
  assert.deepEqual([...stamps].sort((a, b) => a - b), stamps);

  // `x` tĩnh của video khớp keyframe đầu: khác nhau là một cú giật lúc phát.
  assert.equal(videoOf(document).x, values(document)[0]);

  // Người nói dịch sang phải → cửa sổ trượt sang phải → `x` âm dần.
  const xs = values(document);
  assert.ok(xs[xs.length - 1] < xs[0], `cửa sổ không trượt: ${xs}`);

  // Đổi cảnh: giữ tâm cũ tới frame ngay trước giây 14, rồi sang tâm mới.
  const at = stamps.indexOf(14);
  assert.ok(at > 0, `không có mốc nhảy ở 14: ${stamps}`);
  assert.equal(stamps[at - 1], 13.967);
  assert.equal(xs[at - 1], xs[0]);
  assert.equal(xs[at], xs[xs.length - 1]);
}

// Không có dãy (job trước R4, không bám được mặt) hoặc dãy một mốc → khung tĩnh.
{
  assert.equal(hasTrack(build({ focus: { frame: [], reframe: [] } })), false);
  assert.equal(hasTrack(build({ focus: { frame: [[2, 0.4]], reframe: [] } })), false);
}

// `manual` là người dùng đã tự chỉ vào một chỗ. Bám mặt đè lên đó là lấy lại
// quyền quyết định mà họ vừa dùng.
{
  assert.equal(hasTrack(build({ focus: walking, settings: settings({ layout: "manual", focus_x: 0.2 }) })), false);
}

// `fit` viền đen hai bên: không có gì để trượt, nên không có gì để bám.
{
  assert.equal(hasTrack(build({ focus: walking, settings: settings({ layout: "fit" }) })), false);
}

// Nguồn đã dọc sẵn: hộp không rộng hơn khung, cùng lý do.
{
  const document = generateProject({
    settings: settings(),
    source: { width: 1080, height: 1920, duration: 34, offset: 8 },
    hasTranscript: false,
    focus: walking,
  });
  assert.equal(hasTrack(document), false);
}

// ------------------------------------------ marker đổi khung cho editor
{
  const marker = (document: ClipDocument) =>
    sceneOf(document).marks!.reframe as {
      focus: number;
      track: [number, number][];
      mode: string;
    };
  // Khung 16:9 trên nguồn 16:9 không có keyframe nào (không có gì để trượt),
  // nhưng marker VẪN phải mang track bám mặt: đó là thứ duy nhất cho editor
  // biết người nói ở đâu khi người dùng đổi sang 9:16 trên top bar.
  const wide = build({ focus: walking, settings: settings({ aspect: "16:9" }) });
  assert.equal(hasTrack(wide), false);
  assert.ok(marker(wide).track.length >= 2, "marker 16:9 mất track bám mặt");
  assert.equal(marker(wide).mode, "fill");
  // `manual`: người dùng đã tự chọn tâm, track không được đè lên.
  assert.deepEqual(marker(build({ focus: walking, settings: settings({ layout: "manual" }) })).track, []);
  assert.equal(marker(build({ settings: settings({ layout: "fit" }) })).mode, "fit");
}

// --------------------------------------------------------- phụ đề và chữ
// ---------------------------------------- một kiểu phụ đề (R4)
//
// Form clipping chỉ bật/tắt phụ đề; project mới luôn mang preset khớp kiểu mà
// pipeline đốt. Revision cũ còn `caption_preset` thì vẫn đọc được và bỏ qua.
{
  const captions = captionsOf(build({ settings: settings({ captions: true }), hasTranscript: true }))!;
  assert.equal(captions.src, "assets/transcript.json");
  assert.equal(captions.preset, "spotlight");
  assert.deepEqual(captions.colors, ["#ff7a59"]);
}
{
  // Phụ đề phải mang CÙNG cửa sổ nguồn với video. Transcript lấy gốc 0 ở đầu
  // file master; thiếu `sourceIn` thì phụ đề chậm hơn tiếng đúng 2 giây ở đây
  // (source_start 10 − offset 8) — lỗi im lặng, file vẫn ra, chữ vẫn chạy.
  const document = build({ settings: settings({ captions: true }), hasTranscript: true });
  const video = videoOf(document);
  const captions = captionsOf(document)!;
  assert.equal(captions.start, 0);
  assert.deepEqual([captions.sourceIn, captions.sourceOut], [video.sourceIn, video.sourceOut]);
  // Nâng 12% khung khỏi mép dưới: `bottom` mặc định của DS đè lên watermark.
  assert.deepEqual([captions.verticalAlign, captions.offsetY], ["bottom", -230]);
}
{
  // Ma trận khung: mọi khung phải ra một scene đúng kích thước, một
  // `<captions>` đúng preset, và một hộp video che kín scene (không lộ nền đen
  // ở mép — `objectFit="cover"` không cứu được một hộp nhỏ hơn khung).
  const FRAMES: Record<string, [number, number]> = {
    "9:16": [1080, 1920],
    "1:1": [1080, 1080],
    "16:9": [1920, 1080],
  };
  for (const [aspect, [width, height]] of Object.entries(FRAMES)) {
    {
      const preset = "spotlight";
      const document = build({
        settings: settings({ aspect: aspect as never, captions: true }),
        hasTranscript: true,
      });
      const label = aspect;
      const scene = sceneOf(document);
      assert.deepEqual([scene.width, scene.height], [width, height], label);
      assert.equal(captionsOf(document)?.preset, preset, label);
      const video = videoOf(document);
      const [x, y, w, h] = [video.x ?? 0, video.y ?? 0, video.width ?? 0, video.height ?? 0];
      assert.ok(x <= 0.01 && y <= 0.01, `${label}: hộp video lệch vào trong khung (${x}, ${y})`);
      assert.ok(x + w >= width - 0.01 && y + h >= height - 0.01, `${label}: hộp video không che kín khung`);
    }
  }
}
{
  // Không có transcript thì KHÔNG gắn `captions`: một node trỏ vào asset
  // không tồn tại là phụ đề rỗng, im lặng.
  assert.equal(captionsOf(build({ settings: settings({ captions: true }), hasTranscript: false })), undefined);
}
{
  const document = build({
    settings: settings({
      texts: [
        {
          text: "Hook {it} <now> &amp;",
          start: 0,
          end: 3,
          style: { x: 0.5, y: 0.12, size: 94, color: "#ffffff", font: "DejaVu Sans", bold: true },
        },
      ],
    } as Partial<RevisionSettings>),
  });
  const text = nodes<TextNode>(document, "text")[0]!;
  // `text` cần CẢ `width` LẪN `height` thì `textAlign` mới có tác dụng.
  assert.deepEqual([text.width, text.height, text.textAlign], [1080, 282, "center"]);
  // Mặc định của DS là `fontSize` 16 và không có màu — luôn ghi rõ.
  assert.equal(text.fontSize, 94);
  assert.equal(text.color, "#ffffff");
  // Chữ đi nguyên văn: không còn bước escape JSX nào để làm hỏng ngoặc hay entity.
  assert.equal(text.text, "Hook {it} <now> &amp;");
}

// --------------------------------------------------------- document (spec editor-rewrite A1)
// Project đầu tiên của MỌI clip đi qua đây. Document không qua được `validate`
// thì export trên server và editor không mở được clip nào.
for (const document of generated) assert.deepEqual(validate(document), document);
{
  const document = build({ focus: walking, settings: settings({ captions: true }), hasTranscript: true });
  // Marker khung và track bám mặt phải nằm trong document: đổi 9:16 ↔ 16:9 đọc chúng.
  assert.ok((sceneOf(document).marks?.reframe as { track: unknown[] }).track.length >= 2);
  assert.equal(videoOf(document).tracks?.[0]?.property, "x");
}
console.log(`  clip-doc: ${generated.length} document hợp lệ`);

console.log("generate-project.check.ts ok");
