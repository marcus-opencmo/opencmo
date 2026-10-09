/**
 * `<captions>`: 7 preset, giống hệt cái người dùng chọn trong fork (spec Q3).
 *
 * Mỗi khung, preset dựng một `<text>` ẢO (chữ của nhóm từ đang nói, kiểu chữ của
 * preset, range nhấn, bóng, paint) rồi đi đúng đường dàn dòng và vẽ của chữ.
 *
 * ## Nhóm từ
 *
 * Transcript chia thành NHÓM hiện cùng lúc. Không bao giờ gộp qua ranh giới
 * segment (câu). Nhóm đóng lại sau từ kết thúc bằng `. ! ? , ;`, và khi thêm từ
 * sẽ vượt giới hạn: tổng thời lượng từ (classic/stark 0.2 s, whisper 2 s) hoặc
 * tổng số ký tự (spotlight 10, paper/guinea 18, cascade 50). Nhóm đang hiện là
 * nhóm đầu tiên có `đầu ≤ t ≤ cuối`, với t là giây của transcript.
 *
 * ## Vị trí
 *
 * Hộp cố định theo preset (nhân `fontScale` nếu có), căn giữa ngang trong khung (cascade: x = 100). Theo
 * dọc: `top` cách mép trên 100, `bottom` cách mép dưới 100, `center` ở giữa.
 */

import type { CaptionsNode, Shadow, TextNode, TextRange } from '@opencmo/clip-doc';

export type TranscriptWord = { text: string; start: number; end: number };
export type Transcript = { text?: string; words: TranscriptWord[] }[];

type Limit = { duration: number } | { length: number };

type Preset = {
  box: [number, number];
  x?: number;
  align: 'top' | 'center' | 'bottom';
  limit: Limit;
  style: Pick<TextNode, 'fontFamily' | 'fontWeight' | 'fontSize' | 'textAlign' | 'textBaseline' | 'textCase' | 'leading'>;
  /** Màu chữ gốc; stark không có (chỉ vẽ bằng paint blend difference). */
  fill: string | null;
};

const PRESETS: Record<NonNullable<CaptionsNode['preset']>, Preset> = {
  classic: {
    box: [600, 100],
    align: 'center',
    limit: { duration: 0.2 },
    style: { fontFamily: 'Urbanist', fontWeight: 600, fontSize: 62, textAlign: 'center', textBaseline: 'middle', textCase: 'lower', leading: 1 },
    fill: '#FFFFFF',
  },
  whisper: {
    box: [1000, 100],
    align: 'bottom',
    limit: { duration: 2 },
    style: { fontFamily: 'Montserrat', fontWeight: 400, fontSize: 40, textAlign: 'center', textBaseline: 'middle', textCase: 'original', leading: 1.4 },
    fill: '#FFFFFF',
  },
  cascade: {
    box: [800, 200],
    x: 100,
    align: 'bottom',
    limit: { length: 50 },
    style: { fontFamily: 'Inter', fontWeight: 300, fontSize: 50, textAlign: 'left', textBaseline: 'top', textCase: 'original', leading: 1.2 },
    fill: '#FFFFFF',
  },
  spotlight: {
    box: [700, 100],
    align: 'center',
    limit: { length: 10 },
    style: { fontFamily: 'Montserrat', fontWeight: 900, fontSize: 70, textAlign: 'center', textBaseline: 'middle', textCase: 'original', leading: 1 },
    fill: '#FFFFFF',
  },
  paper: {
    box: [700, 200],
    align: 'center',
    limit: { length: 18 },
    style: { fontFamily: 'Montserrat', fontWeight: 300, fontSize: 50, textAlign: 'center', textBaseline: 'middle', textCase: 'original', leading: 0.9 },
    fill: '#FFFFFF',
  },
  guinea: {
    box: [700, 200],
    align: 'center',
    limit: { length: 18 },
    style: { fontFamily: 'Bangers', fontWeight: 400, fontSize: 62, textAlign: 'center', textBaseline: 'middle', textCase: 'upper', leading: 1 },
    fill: '#FFFFFF',
  },
  stark: {
    box: [700, 100],
    align: 'center',
    limit: { duration: 0.2 },
    style: { fontFamily: 'Figtree', fontWeight: 800, fontSize: 70, textAlign: 'center', textBaseline: 'middle', textCase: 'upper', leading: 1 },
    fill: null,
  },
};

const SPOTLIGHT = '#24D5FF';
const GUINEA = ['#F55353', '#FEB139', '#F6F54D'];
/** Thứ tự chọn màu của guinea mỗi lần dòng nhấn đổi — cố định, không ngẫu nhiên. */
const GUINEA_ORDER = [0, 1, 0, 2, 1, 1, 0, 0, 1, 0, 2, 1, 0, 2, 1, 0, 2, 1];
const MARGIN = 100;

export const presetOf = (node: CaptionsNode): Preset => PRESETS[node.preset ?? 'classic'];

/** Chữ mặc định của một preset — inspector hiện nó khi phụ đề chưa đè font/màu. `color` null: stark (blend difference). */
export function captionPresetText(preset: CaptionsNode['preset']): { fontFamily: string; fontWeight: number; color: string | null } {
  const entry = PRESETS[preset ?? 'classic'];
  return { fontFamily: String(entry.style.fontFamily), fontWeight: Number(entry.style.fontWeight ?? 400), color: entry.fill };
}

// ------------------------------------------------------------------ nhóm từ

const CLOSES = /[.!?,;]$/;

export function groupWords(transcript: Transcript, limit: Limit): TranscriptWord[][] {
  const groups: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [];
  const close = () => {
    if (current.length) groups.push(current);
    current = [];
  };
  for (const segment of transcript) {
    close();
    for (const word of segment.words) {
      const over =
        'duration' in limit
          ? current.reduce((sum, w) => sum + (w.end - w.start), 0) + (word.end - word.start) > limit.duration
          : current.reduce((sum, w) => sum + w.text.length, 0) + word.text.length > limit.length;
      if (over) close();
      current.push(word);
      if (CLOSES.test(word.text)) close();
    }
  }
  close();
  return groups;
}

// ------------------------------------------------------------------ ngắt câu theo trần (học Palmier §C1)

/** "U.S.", "e.g.", "Mr." không phải hết câu; "3.14" vốn không kết bằng dấu chấm. */
const ABBREVIATION = /^(?:(?:[A-Za-z]\.){2,}|(?:mr|mrs|ms|dr|st|vs|etc|inc|jr|sr)\.)$/i;
const sentenceEnd = (text: string) => /[.!?…]["')\]]?$/.test(text) && !ABBREVIATION.test(text);
const clauseEnd = (text: string) => /[,;:—–]["')\]]?$/.test(text);

export type PhraseLimit = { maxWords?: number; maxChars?: number };

const fits = (words: TranscriptWord[], limit: PhraseLimit) =>
  (!limit.maxWords || words.length <= limit.maxWords) && (!limit.maxChars || joined(words).length <= limit.maxChars);

/**
 * Chia một dòng transcript thành các cụm đủ ngắn: chỗ ngắt ưu tiên là hết câu,
 * rồi hết mệnh đề, rồi từ giữa — mỗi bậc chọn chỗ gần giữa nhất, rồi chia tiếp
 * hai nửa cho tới khi vừa trần. Một từ dài hơn trần vẫn đứng riêng một cụm.
 */
function splitPhrase(words: TranscriptWord[], limit: PhraseLimit): TranscriptWord[][] {
  if (words.length <= 1 || fits(words, limit)) return [words];
  const middle = words.length / 2;
  const best = (test: (text: string) => boolean): number | null => {
    let pick: number | null = null;
    // Ngắt SAU từ i (1 ≤ i+1 < length): hai nửa đều có chữ.
    for (let i = 0; i < words.length - 1; i++) {
      if (!test(words[i]!.text)) continue;
      if (pick === null || Math.abs(i + 1 - middle) < Math.abs(pick - middle)) pick = i + 1;
    }
    return pick;
  };
  const cut = best(sentenceEnd) ?? best(clauseEnd) ?? Math.ceil(middle);
  return [...splitPhrase(words.slice(0, cut), limit), ...splitPhrase(words.slice(cut), limit)];
}

export function groupPhrases(transcript: Transcript, limit: PhraseLimit): TranscriptWord[][] {
  return transcript.flatMap((segment) => (segment.words.length ? splitPhrase(segment.words, limit) : []));
}

/**
 * Nhóm đang hiện ở giây `t`. `hold`: nhóm ở lại qua khoảng lặng ngắn hơn chừng
 * đó (nhưng không đè lên nhóm sau) — hết nháy trống giữa hai câu.
 */
const activeGroup = (groups: TranscriptWord[][], t: number, hold = 0) =>
  groups.findIndex((group, index) => {
    const start = group[0]!.start;
    const end = group[group.length - 1]!.end;
    if (t >= start && t <= end) return true;
    if (hold <= 0 || t < end) return false;
    const next = groups[index + 1]?.[0]?.start ?? Infinity;
    return t < next && next - end <= hold ? true : next === Infinity ? t <= end + hold : false;
  });

const joined = (words: TranscriptWord[]) => words.map((word) => word.text).join(' ');

/**
 * Chia nhóm làm hai dòng tại dấu cách gần giữa nhất (paper, guinea). Tìm từ giữa
 * ra hai phía, bên trái được xét trước khi hai bên cách đều.
 */
export function splitLines(group: TranscriptWord[]): [TranscriptWord[], TranscriptWord[]] {
  const text = joined(group);
  const middle = Math.ceil(text.length / 2);
  let cut = text.length;
  for (let back = middle, ahead = middle; back > 0 && ahead < text.length - 1; back--, ahead++) {
    if (text[back] === ' ') {
      cut = back;
      break;
    }
    if (text[ahead] === ' ') {
      cut = ahead;
      break;
    }
  }
  const leftWords = text.slice(0, cut).trim().split(' ').length;
  return [group.slice(0, leftWords), group.slice(leftWords)];
}

// ------------------------------------------------------------------ một khung

export type CaptionFrame = {
  /** Chữ nền trước animation chữ. */
  text: string;
  /** `<text>` ảo đi vào dàn dòng và vẽ. */
  node: TextNode;
  /** Khoá trạng thái (nhóm + dòng nhấn) — guinea đếm số lần nó đổi. */
  state: string | null;
  /** `highlight: 'block'`: range (cùng tham chiếu trong `node.ranges`) của từ đang nói + màu hộp. */
  block?: { range: TextRange; color: string };
  /** `highlight: 'pop'` (E4): range của từ đang nói, phóng `scale` quanh tâm từ, chữ màu nhấn. */
  pop?: { range: TextRange; scale: number };
};

/** Màu hộp nhấn khi người dùng chưa chọn màu: vàng của preset spotlight. */
/** highlight 'pop': màu nhấn mặc định và độ phóng của từ đang nói. */
const POP_COLOR = '#FFD900';
const POP_SCALE = 0.15;
const BLOCK_COLOR = '#FFD400';
/** Chữ trên hộp: tối để đọc được trên màu nhấn sáng. */
const BLOCK_TEXT = '#111111';

type Split = { text: string; line: 'left' | 'right'; lineStart: number; lineEnd: number } | null;

function twoLines(group: TranscriptWord[], t: number): Split {
  const [left, right] = splitLines(group);
  const leftText = joined(left);
  const rightText = joined(right);
  const text = rightText ? `${leftText}\n${rightText}` : leftText;
  const line = right.length > 0 && t >= right[0]!.start ? 'right' : 'left';
  return {
    text,
    line,
    lineStart: line === 'left' ? 0 : leftText.length + 1,
    lineEnd: line === 'left' ? leftText.length : text.length,
  };
}

/** Khoá trạng thái tại giây `t` — rẻ, không dựng node: guinea gọi nó cho mọi khung đã qua. */
export function stateAt(node: CaptionsNode, groups: TranscriptWord[][], t: number): string | null {
  const index = activeGroup(groups, t, node.holdGap ?? 0);
  if (index < 0) return null;
  if (node.preset !== 'guinea') return String(index);
  return `${index}:${twoLines(groups[index]!, t)!.line}`;
}

/**
 * `guineaCount`: số lần dòng nhấn đã đổi tính tới khung này khi phát liên tục —
 * màu nhấn thứ `GUINEA_ORDER[count mod 18]`.
 */
export function captionFrame(node: CaptionsNode, groups: TranscriptWord[][], t: number, guineaCount: number): CaptionFrame {
  const preset = presetOf(node);
  const colors = node.colors ?? [];
  const scale = node.fontScale ?? 1;
  const base: TextNode = {
    kind: 'text',
    text: '',
    ...preset.style,
    ...(node.fontFamily ? { fontFamily: node.fontFamily } : {}),
    ...(node.fontWeight ? { fontWeight: node.fontWeight } : {}),
    fontSize: (preset.style.fontSize ?? 16) * scale,
    // stark không có màu chữ: vẽ bằng blend difference, `color` không áp.
    ...(preset.fill ? { color: node.color ?? preset.fill } : {}),
  };
  const index = activeGroup(groups, t, node.holdGap ?? 0);
  if (index < 0) return { text: '', node: base, state: null };
  const group = groups[index]!;
  const ranges: TextRange[] = [];
  let text = joined(group);
  let state = String(index);

  switch (node.preset ?? 'classic') {
    case 'classic':
      base.shadows = [{ color: '#000000', blur: 28, offsetX: 0, offsetY: 5, opacity: 1 } satisfies Shadow];
      break;
    case 'cascade':
      // Hiện dần: chỉ các từ đã bắt đầu.
      text = joined(group.filter((word) => word.start <= t));
      break;
    case 'spotlight': {
      const spoken = group.findIndex((word) => t >= word.start && t <= word.end);
      // Có hộp nhấn thì hộp là chỗ nhấn: tô màu chữ trùng màu hộp là mất chữ.
      if (group.length > 1 && spoken !== -1 && node.highlight !== 'block') {
        ranges.push({
          start: joined(group.slice(0, spoken)).length,
          end: joined(group.slice(0, spoken + 1)).length,
          paints: [{ type: 'solid', color: colors[0] ?? SPOTLIGHT }],
        });
      }
      break;
    }
    case 'paper':
    case 'guinea': {
      const split = twoLines(group, t)!;
      text = split.text;
      state = `${index}:${split.line}`;
      if (split.lineEnd > split.lineStart) {
        if (node.preset === 'paper') {
          // Dòng đang nói đậm hơn chữ thường 200 (preset: 300 → 500).
          ranges.push({ start: split.lineStart, end: split.lineEnd, fontWeight: Math.min(1000, (node.fontWeight ?? 300) + 200) });
        } else {
          const slot = GUINEA_ORDER[guineaCount % GUINEA_ORDER.length]!;
          ranges.push({
            start: split.lineStart,
            end: split.lineEnd,
            fontSize: Math.round((preset.style.fontSize ?? 62) * 1.1) * scale,
            paints: [{ type: 'solid', color: colors[slot] ?? GUINEA[slot]! }],
          });
        }
      }
      break;
    }
    case 'stark':
      base.paints = [{ type: 'solid', color: '#FFFFFF', blendMode: 'difference' }];
      break;
    case 'whisper':
      break;
  }
  if (ranges.length) base.ranges = ranges;
  base.text = text;
  const frame: CaptionFrame = { text, node: base, state };
  // Hộp nhấn chỉ khi chữ trên màn đúng là các từ của nhóm theo thứ tự (paper/guinea xuống dòng riêng).
  if (node.highlight === 'pop' && text === joined(group.filter((word) => word.start <= t || node.preset !== 'cascade'))) {
    const spoken = group.findIndex((word) => t >= word.start && t <= word.end);
    if (spoken !== -1) {
      const word = group[spoken]!;
      const range: TextRange = {
        start: joined(group.slice(0, spoken)).length + (spoken > 0 ? 1 : 0),
        end: joined(group.slice(0, spoken + 1)).length,
        paints: [{ type: 'solid', color: colors[0] ?? POP_COLOR }],
      };
      base.ranges = [...(base.ranges ?? []), range];
      // Bật lên trong 0.08 s đầu của từ rồi giữ — nhịp karaoke của short-form.
      const rise = Math.min(1, Math.max(0, (t - word.start) / 0.08));
      frame.pop = { range, scale: 1 + POP_SCALE * rise };
    }
  }
  if (node.highlight === 'block' && text === joined(group.filter((word) => word.start <= t || node.preset !== 'cascade'))) {
    const spoken = group.findIndex((word) => t >= word.start && t <= word.end);
    if (spoken !== -1) {
      const range: TextRange = { start: joined(group.slice(0, spoken)).length + (spoken > 0 ? 1 : 0), end: joined(group.slice(0, spoken + 1)).length, color: BLOCK_TEXT };
      base.ranges = [...(base.ranges ?? []), range];
      frame.block = { range, color: colors[0] ?? BLOCK_COLOR };
    }
  }
  return frame;
}

/** Hộp và vị trí của phụ đề trong khung cha. */
export function placeCaption(node: CaptionsNode, parent: { width: number; height: number }) {
  const preset = presetOf(node);
  const scale = node.fontScale ?? 1;
  const [width, height] = preset.box.map((side) => side * scale) as [number, number];
  const align = node.verticalAlign ?? preset.align;
  const y = align === 'top' ? MARGIN : align === 'bottom' ? parent.height - height - MARGIN : (parent.height - height) / 2;
  return { x: preset.x ?? (parent.width - width) / 2, y, width, height };
}

/** Giây cuối của transcript: độ dài tự nhiên của phụ đề khi không ghi `end`. */
export function transcriptEnd(transcript: Transcript): number | null {
  let end = 0;
  for (const segment of transcript) for (const word of segment.words) end = Math.max(end, word.end);
  return end > 0 ? end : null;
}

