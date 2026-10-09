/**
 * Revision đầu tiên của một clip → document của editor (`@opencmo/clip-doc`).
 *
 * Đây là cầu nối duy nhất giữa hai mô hình dữ liệu: `RevisionSettings` (thứ
 * pipeline sinh ra) và document mà editor, clip-render
 * và export trên server đọc. Nó chỉ chạy MỘT LẦN cho mỗi clip — lần đầu ai đó
 * mở editor. Từ lúc đó document là nguồn sự thật của chính nó, không ai sinh lại.
 *
 * Trước R3 (07/10/2026) hàm này viết ra chuỗi TSX rồi `fromTsx` đọc ngược lại
 * thành document: hai bước, và compiler TypeScript nằm trong runtime chỉ để
 * khứ hồi. Giờ nó dựng thẳng document; tên trường giữ đúng tên prop của DS.
 *
 * ## Những thứ hỏng IM LẶNG nếu viết sai
 *
 * Mỗi mục dưới đây đã làm hỏng một khung hình trong lúc dựng, và không mục nào
 * ném lỗi — file vẫn ra, canvas vẫn có hình, chỉ là sai.
 *
 *   - **`active` trên scene là bắt buộc.** Thiếu nó: timeline rỗng, không
 *     playhead, và không có scene nào để export.
 *   - **`workarea` quyết định khoảng được render.** Không đặt thì export ra
 *     đúng độ dài mặc định, không phải độ dài clip.
 *   - **Đừng dùng `scale` để zoom.** `scale` nhân quanh GÓC TRÊN TRÁI của box.
 *     Zoom được nướng vào `width`/`height`, và `x` là một cửa sổ trượt 1:1.
 *   - **`<text>` cần CẢ `width` LẪN `height` thì `textAlign` mới có tác dụng.**
 *     Doc của DS nói chỉ cần một trong hai; sai. Thiếu `height` thì
 *     `computed.width` bị ghi đè bằng bề rộng chữ đo được, nên phép canh giữa
 *     luôn ra 0 và chữ dính mép trái.
 *   - **`<text>` mặc định `fontSize` 16 và không có màu.** Luôn ghi rõ.
 *   - **`sourceIn`/`start` đi cùng nhau** khi cắt đầu, nếu không phụ đề và
 *     tiếng lệch đúng bằng phần bị cắt.
 *
 * ## Nguồn video
 *
 * `master.mp4`: cửa sổ của clip cắt bằng `-c copy`, ở độ phân giải NGUỒN. Job
 * cũ hơn Phase 3 chỉ có proxy 540p và vẫn mở được — mọi phép tính dưới đây
 * theo TỈ LỆ, không theo số pixel cụ thể, nên hai nguồn cho ra cùng một khung.
 *
 * ## Bám mặt động
 *
 * `focus` là dãy tâm khung mà worker đã tính sẵn cho clip (`masters[clip].focus`,
 * `steps/reframe.py::editor_focus` — R4: Python là bản DUY NHẤT của thuật toán
 * bám mặt). Khi có nó và khung đang `fill`, khung crop thành một
 * `<keyframeTrack property="x">` trượt theo người nói. Không có dãy (job cũ,
 * không bám được mặt), hoặc người dùng đã tự chọn tâm (`layout: "manual"`), thì
 * `x` tĩnh theo `focus_x` của revision — đúng bằng bản render của engine.
 */

import { DOCUMENT_VERSION, validate, type ClipDocument } from "@opencmo/clip-doc";

import type { RevisionSettings, TextStyle } from "@/lib/settings-schema";
import { xForFocus } from "@opencmo/editor-core";

/** Node trước khi qua `validate()` — schema của clip-doc là chỗ kiểm, không phải kiểu ở đây. */
type Node = Record<string, unknown>;

/** Khung đích theo tỉ lệ. Cạnh ngắn 1080 cho cả ba, như pipeline. */
const FRAMES = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
} as const;

/**
 * Font của DS ánh xạ từ ba font mà `settings-schema` cho phép.
 *
 * `FONTS` là tên DejaVu — chúng tồn tại vì ffmpeg của worker có sẵn chúng
 * (`fonts-dejavu-core` trong `modal_app.py`). Trình duyệt thì không: bảng font
 * của DS (`packages/runtime/src/fonts/fixtures.ts`) là một danh sách khác hẳn.
 * Ánh xạ ở đây thay vì để `fontFamily="DejaVu Sans"` rơi về font hệ thống —
 * thứ hỏng im lặng và cho ra serif.
 *
 * Cả ba họ đích PHẢI có trong bảng đó. Một tên không có ở đấy không ném lỗi:
 * `loadWebFont` không có gì để nạp và `<text>` vẽ bằng font mặc định.
 */
const FONT_FAMILY: Record<string, string> = {
  "DejaVu Sans": "Inter",
  "DejaVu Serif": "Lora",
  "DejaVu Sans Mono": "Source Code Pro",
};

/**
 * Kiểu phụ đề của project mới: một preset của editor, khớp kiểu duy nhất mà
 * pipeline đốt vào clip giao khách (`media/frame.py::CAPTION_STYLE`, chữ đậm
 * nhấn từng từ). Từ R4 form clipping chỉ bật/tắt phụ đề; đổi kiểu làm trong
 * editor bằng chính bộ preset này, nên chỉ còn một bộ tên.
 *
 * `spotlight` nhấn từng từ bằng một ô màu; đổ swatch cam vào ô đó thay cho
 * mặc định cyan của DS. Preset không có ô màu nào (`classic`, `stark`) thì
 * `colors` bỏ qua im lặng — nên chỉ gắn màu cho preset có ô.
 */
const CAPTION_STYLE = { preset: "spotlight", colors: ["#ff7a59"] } as const;

export type MasterSource = {
  /** Bề ngang thật của file nguồn, tính bằng pixel. */
  width: number;
  /** Chiều cao thật của file nguồn. */
  height: number;
  /** Độ dài file nguồn, giây. */
  duration: number;
  /**
   * Mốc của giây 0 trong file nguồn, tính theo thời gian của VIDEO GỐC.
   * `source_start` của settings cũng theo thang đó, nên hiệu của chúng là
   * `sourceIn`.
   */
  offset: number;
};

export type GenerateInput = {
  settings: RevisionSettings;
  source: MasterSource;
  /** Có `assets/transcript.json` để gắn `<captions>` hay không. */
  hasTranscript: boolean;
  /**
   * Dãy `[giây master, tâm]` worker tính sẵn: `frame` cho khung hiện tại (keyframe
   * `x`), `reframe` cho mark đổi khung. Thiếu là khung tĩnh.
   */
  focus?: EditorFocus;
};

export type EditorFocus = { frame: Array<[number, number]>; reframe: Array<[number, number]> };

const round = (value: number): number => Math.round(value * 100) / 100;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/**
 * Camera mở project ra đã khớp khung.
 *
 * Mặc định của `<stage>` khớp 1920×1080; khung dọc mà không có camera thì mở
 * ra là một vệt nhỏ giữa canvas. Con số cho 1080×1920 lấy thẳng từ doc của DS
 * và đã nhìn bằng mắt ở spike Phase 0; hai tỉ lệ còn lại tính theo cùng công
 * thức (khớp khung vào khoảng 580×330 pixel màn hình).
 *
 * Lần pan hoặc zoom đầu tiên ghi đè nó, nên con số chính xác không quan trọng —
 * chỉ cần project không mở ra ở một chỗ không nhìn thấy gì.
 */
function camera(width: number, height: number): number[] | null {
  if (width === 1920 && height === 1080) return null;
  if (width === 1080 && height === 1920) return [0.25, 0, 0, 0.25, 235, 70];
  const scale = round(Math.min(580 / width, 330 / height));
  return [scale, 0, 0, scale, round((580 - width * scale) / 2), round((330 - height * scale) / 2)];
}

/**
 * Hộp mà video chiếm trên scene.
 *
 * `fill`/`manual`: phủ kín khung (cắt hai bên), tâm ngang đặt theo `focus_x`.
 * `fit`: lọt hẳn vào khung (viền đen hai bên).
 *
 * `focus_x` là tâm quan tâm CHUẨN HOÁ theo bề ngang nguồn — cùng đại lượng mà
 * `steps/reframe.py` tính, nên hai đường cho ra cùng một khung.
 */
function videoBox(
  settings: RevisionSettings,
  source: MasterSource,
  frame: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const fit = settings.layout === "fit";
  const scale = fit
    ? Math.min(frame.width / source.width, frame.height / source.height)
    : Math.max(frame.width / source.width, frame.height / source.height);

  const width = source.width * scale;
  const height = source.height * scale;

  // `focus_x` null nghĩa là pipeline không bám được mặt nào — căn giữa, đúng
  // như `reframe.py` rơi về khi thiếu MediaPipe.
  const focus = settings.focus_x ?? 0.5;

  return {
    x: xForFocus(focus, width, frame.width),
    y: round((frame.height - height) / 2),
    width: round(width),
    height: round(height),
  };
}

/**
 * `<keyframeTrack property="x">` bám theo người nói.
 *
 * Trả mảng RỖNG khi không có gì để bám: không track, khung `fit` (không có gì
 * để trượt), hoặc người dùng đã tự chọn tâm. Người gọi khi đó giữ `x` tĩnh.
 *
 * Mốc là giây SOURCE-local (giây 0 của `master.mp4`) và mốc đầu nằm ở
 * `sourceIn` — worker đã lo cả hai (`steps/reframe.py::editor_focus`), kể cả
 * cửa sổ chọn tâm đúng bằng cửa sổ crop thật của khung.
 */
function keyframes(
  input: GenerateInput,
  frame: { width: number; height: number },
  box: { width: number },
): { time: number; value: number }[] {
  const points = input.focus?.frame ?? [];
  // `manual` là người dùng đã tự chỉ vào một chỗ. Bám mặt đè lên đó là lấy lại
  // quyền quyết định mà họ vừa dùng.
  if (points.length < 2 || input.settings.layout !== "fill") return [];
  if (box.width <= frame.width) return [];
  // Một mốc duy nhất là một khung tĩnh viết dài dòng — worker đã bỏ ca đó.
  return points.map(([time, focus]) => ({ time, value: xForFocus(focus, box.width, frame.width) }));
}

/**
 * Track `focus` (tâm quan tâm chuẩn hoá theo bề ngang NGUỒN) cho marker
 * `opencmo:reframe` — thứ editor đọc khi người dùng đổi khung trên top bar
 * (`packages/editor-core/src/reframe.ts`).
 *
 * Có cả khi khung hiện tại KHÔNG cần trượt (16:9 trên nguồn 16:9): lúc đó
 * `x` luôn là 0 và không ai suy lại được người nói đứng đâu, nên worker lấy
 * mẫu bằng cửa sổ 9:16 — khung mà người dùng gần như chắc sẽ đổi sang.
 */
function focusTrack(input: GenerateInput): Array<[number, number]> {
  const points = input.focus?.reframe ?? [];
  if (points.length < 2 || input.settings.layout === "manual") return [];
  return points.map(([time, focus]) => [time, round(focus)] as [number, number]);
}

/**
 * Một lớp chữ → node `text`.
 *
 * `style.x`/`style.y` là tâm chuẩn hoá trong khung an toàn (0.08–0.92). Hộp
 * chữ lấy TRỌN bề ngang scene và canh giữa thay vì bám theo `style.x`: chữ
 * xuống nhiều dòng thì một hộp hẹp đặt theo tâm sẽ tràn mép, và tràn mép là
 * lỗi đã gặp. `height` rộng gấp ba cỡ chữ để ba dòng vẫn nằm trong hộp —
 * thiếu `height` thì `textAlign` không có tác dụng (xem đầu file).
 *
 * Chữ đi nguyên văn vào document. Đường TSX cũ còn chạy chữ qua luật khoảng
 * trắng và entity của JSX, nên "a\nb" thành "a b" và "&amp;" thành "&".
 */
function textLayer(
  layer: { text: string; start: number; end: number; style: TextStyle },
  frame: { width: number; height: number },
  duration: number,
): Node | null {
  const text = layer.text.trim();
  if (!text) return null;

  const end = round(Math.min(layer.end, duration));
  const start = round(Math.max(0, layer.start));
  if (end <= start) return null;

  const height = Math.round(layer.style.size * 3);
  return {
    kind: "text",
    y: Math.round(clamp(layer.style.y * frame.height - height / 2, 0, frame.height - height)),
    width: frame.width,
    height,
    start,
    end,
    text,
    color: layer.style.color,
    fontFamily: FONT_FAMILY[layer.style.font] ?? "Inter",
    fontWeight: layer.style.bold ? 700 : 400,
    fontSize: Math.round(layer.style.size),
    textAlign: "center",
    // `textBaseline`, không phải `verticalAlign` — cái sau chỉ có trên
    // `captions`. Mặc định của text là "top", nên chữ một dòng sẽ dính đỉnh
    // hộp cao gấp ba cỡ chữ ở trên.
    textBaseline: "middle",
  };
}

/** Phần chiều cao khung nâng phụ đề lên khỏi mép dưới của DS. */
const CAPTION_LIFT = 0.12;

/**
 * Sinh document cho một clip.
 *
 * Người gọi đưa nó xuống `get_or_create_editor_project`, và từ đó database giữ
 * nó. Kết quả đã qua `validate()` của clip-doc — cùng cửa với mọi document khác.
 */
export function generateProject(input: GenerateInput): ClipDocument {
  const { settings, source, hasTranscript } = input;
  const frame = FRAMES[settings.aspect ?? "9:16"];

  // Độ dài clip, kẹp trong phần nguồn thật sự có. Một revision trỏ ra ngoài
  // file (job cũ, proxy cắt ngắn hơn) phải ra một project ngắn hơn chứ không
  // phải một project có khoảng trống đen ở cuối.
  const sourceIn = round(clamp(settings.source_start - source.offset, 0, source.duration));
  const sourceOut = round(
    clamp(settings.source_end - source.offset, sourceIn, source.duration),
  );
  const duration = round(sourceOut - sourceIn);

  const box = videoBox(settings, source, frame);
  const cameraMatrix = camera(frame.width, frame.height);

  const track = keyframes(input, frame, box);

  const children: Node[] = [
    {
      kind: "video",
      src: "assets/master.mp4",
      // `x` khớp keyframe đầu: DS đọc thuộc tính tĩnh cho tới lúc playhead chạm
      // mốc đầu tiên, và một giá trị khác ở đó là một cú giật khi bắt đầu phát.
      x: track.length ? track[0].value : box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      // `cover` không cắt gì ở đây: hộp giữ đúng tỉ lệ nguồn. Cắt là việc của
      // scene, và đó là chủ ý — xem ghi chú `scale` ở đầu file.
      objectFit: "cover",
      start: 0,
      sourceIn,
      sourceOut,
      ...(track.length
        ? {
            tracks: [
              {
                property: "x",
                keyframes: track.map((point) => ({ ...point, easing: "easeInOut" })),
              },
            ],
          }
        : {}),
    },
  ];

  if (settings.captions !== false && hasTranscript) {
    const style = CAPTION_STYLE;
    // `sourceIn`/`sourceOut` y như video: transcript lấy gốc 0 ở đầu FILE
    // master, và decoder phụ đề seek theo thời gian local của chính nó. Thiếu
    // hai trường này thì ở giây t của timeline, video phát giây `t + sourceIn`
    // của master còn phụ đề hiện chữ của giây t — chậm hơn tiếng đúng một
    // `sourceIn` (tới ~2s, vì master cắt ở keyframe trước mốc).
    // `bottom` của DS chỉ cách đáy 100px (~5% khung dọc): phụ đề rơi vào vùng chữ
    // mô tả của TikTok/Reels và đè lên watermark bản free (8% từ đáy,
    // `render.py::_watermark_filter`). Nâng 12% chiều cao để mép dưới ở ~83%,
    // khớp phụ đề của engine (18% từ đáy, `captions.py`). UAT 29/09.
    children.push({
      kind: "captions",
      src: "assets/transcript.json",
      preset: style.preset,
      colors: [...style.colors],
      verticalAlign: "bottom",
      offsetY: -Math.round(frame.height * CAPTION_LIFT),
      start: 0,
      sourceIn,
      sourceOut,
    });
  }

  for (const layer of settings.texts ?? []) {
    const rendered = textLayer(layer, frame, duration);
    if (rendered) children.push(rendered);
  }

  return validate({
    version: DOCUMENT_VERSION,
    stage: {
      background: "#000000",
      ...(cameraMatrix ? { camera: cameraMatrix } : {}),
      children: [
        {
          kind: "scene",
          name: "Clip",
          width: frame.width,
          height: frame.height,
          fill: "#000000",
          active: true,
          workarea: [0, duration],
          // Trạng thái khung cho top bar của editor: đổi 9:16 ↔ 16:9 không được
          // làm mất track bám mặt (xem `focusTrack`).
          marks: {
            reframe: {
              focus: round(settings.focus_x ?? 0.5),
              track: focusTrack(input),
              mode: settings.layout === "fit" ? "fit" : "fill",
            },
          },
          children,
        },
      ],
    },
  });
}
