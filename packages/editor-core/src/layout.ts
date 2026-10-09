/**
 * Bố cục người nói + visual (spec visuals-2 L4): chia đôi khung, người nói ở
 * một dải, nửa kia là panel nền cho visual; hoặc cảnh visual riêng (panel phủ
 * kín, tiếng người nói vẫn chạy như B-roll).
 *
 * ## Vì sao không đụng track của video master
 *
 * Track `x` bám mặt tính theo thời gian NGUỒN; cắt bằng chữ nhân bản video mẫu
 * thành từng đoạn (`captions.ts`, `segment`); đổi khung ghi đè x/y/w/h
 * (`reframe.ts`). Viết bố cục vào đó là để ba thứ giẫm lên nhau. Nên master
 * (video, hoặc sequence đã cắt) được bọc trong một group "Speaker" — group có
 * track `offsetY` theo thời gian CLIP, dời cả khung người nói vào dải. Một rect
 * "Layout panel" ngay trên nó che phần tràn: panel mọc ra cùng nhịp với cú dời
 * (cùng easing, và cao ≥ độ dời) nên không bao giờ lộ khoảng trống.
 *
 * ## Mark là nguồn sự thật
 *
 * Các khoảng nằm ở mark `layout` của scene (`{ ranges }`); `rebuildLayout` dựng
 * lại group + panel + mọi track từ đó, nên gọi bao nhiêu lần cũng ra một kết
 * quả — đổi khung gọi lại để dải tính theo kích thước mới.
 *
 * ## PiP và side-by-side (học Palmier §C3)
 *
 * Hai kiểu này phải THU NHỎ / CẮT khung người nói, mà pivot của group là tâm
 * hộp bao các con (video bám mặt rộng hơn khung, và hộp đổi theo track `x`) —
 * không tính trước được. Nên khi clip có một khoảng pip/side-by-side, Speaker
 * là một RECT trong suốt đúng bằng khung (pivot = tâm khung) mang một mask:
 * mask cắt ô vuông quanh mặt (pip, bo góc) hoặc một cột (side-by-side), rect
 * thu nhỏ/dời ô đó vào góc/nửa khung. PiP cần người nói NẰM TRÊN nền visual,
 * nên thêm rect "Layout backdrop" ở dưới Speaker; panel cũ (ở trên) vô hình
 * trong khoảng pip. Clip không có hai kiểu này giữ nguyên cấu trúc cũ (group).
 */

import { LAYOUT_ANCHORS, LAYOUT_MODES, type ClipDocument, type ClipNode, type LayoutRange as StoredRange } from '@opencmo/clip-doc';

import { clone, isMaster, nodes, sceneOf, type Entity } from './doc';
import { summarizeProject } from './summary';
import { round } from './transcript';

export { LAYOUT_ANCHORS, LAYOUT_MODES };
export type LayoutMode = (typeof LAYOUT_MODES)[number];
export type LayoutAnchor = (typeof LAYOUT_ANCHORS)[number];
/**
 * `cell` (E5, `apply_layout`): người nói nằm gọn trong một ô [x, y, w, h] 0–1 của bố cục nhiều
 * nguồn; `focus` [x, y] 0–1 chọn phần khung được giữ (vắng: giữa ngang, quanh mặt theo dọc).
 * Không có trong `set_layout` — chỉ `apply_layout` ghi.
 */
export type LayoutRange = StoredRange;

/** Mặc định của từng kiểu: tỉ lệ (dải / ô PiP theo bề ngang / cột) và góc. */
export function layoutDefaults(mode: LayoutMode): { ratio: number; anchor?: LayoutAnchor } {
  if (mode === 'pip') return { ratio: 0.36, anchor: 'bottom-right' };
  if (mode === 'side-by-side') return { ratio: 0.5, anchor: 'left' };
  return { ratio: 0.5 };
}

const PIP_CORNERS: LayoutAnchor[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const anchorFor = (range: LayoutRange): LayoutAnchor => {
  const fallback = layoutDefaults(range.mode === 'cell' ? 'full' : range.mode).anchor ?? 'left';
  if (!range.anchor) return fallback;
  if (range.mode === 'pip') return PIP_CORNERS.includes(range.anchor) ? range.anchor : fallback;
  return range.anchor === 'right' ? 'right' : 'left';
};
const FANCY = new Set<LayoutRange['mode']>(['pip', 'side-by-side', 'cell']);
const validRect = (rect: unknown): rect is [number, number, number, number] =>
  Array.isArray(rect) && rect.length === 4 && rect.every((value) => typeof value === 'number' && value >= 0 && value <= 1) && rect[2] > 0 && rect[3] > 0;
/** Lề PiP so với cạnh khung, phần bề ngang. */
const PIP_MARGIN = 0.04;
/** Bo góc ô PiP, phần cạnh ô. */
const PIP_RADIUS = 0.14;

const FRAME = 1 / 30;
/** Chuyển cảnh, giây — ngắn lại khi khoảng quá ngắn. */
const TRANSITION = 0.3;
/** Khoảng ngắn hơn thế này không đáng một lần chia khung. */
export const MIN_RANGE = 0.5;
/** Màu panel: nền tối của THEME visual (`visuals/common.ts`), đặc để che phần tràn. */
const PANEL_COLOR = '#0F172A';
/** Người nói thường có mặt quanh 35% chiều cao khung (khung dọc, bám mặt ngang). */
const FACE_Y = 0.35;

const SPEAKER = 'speaker';
const PANEL = 'panel';
const BACKDROP = 'backdrop';

export function readLayout(document: ClipDocument): LayoutRange[] {
  const scene = sceneOf(document);
  const ranges = (scene?.marks?.layout as { ranges?: unknown } | undefined)?.ranges;
  if (!Array.isArray(ranges)) return [];
  return ranges
    .filter(
      (item): item is LayoutRange =>
        !!item &&
        typeof item.start === 'number' &&
        typeof item.end === 'number' &&
        item.end > item.start &&
        ((LAYOUT_MODES as readonly string[]).includes(item.mode) ? item.mode !== ('full' as string) : item.mode === 'cell' && validRect(item.rect)),
    )
    .map((item) => {
      const out: LayoutRange = { ...item, ratio: typeof item.ratio === 'number' ? item.ratio : item.mode === 'cell' ? 1 : layoutDefaults(item.mode).ratio };
      if (item.mode === 'cell' || !FANCY.has(item.mode) || !LAYOUT_ANCHORS.includes(item.anchor as LayoutAnchor)) delete out.anchor;
      if (item.mode !== 'cell') delete out.rect, delete out.focus, delete out.fit;
      else if (item.fit !== 'fit') delete out.fit;
      return out;
    })
    .sort((a, b) => a.start - b.start);
}

/**
 * Ghi một khoảng lên danh sách: phần chồng của khoảng cũ bị cắt đi, `full` chỉ
 * xoá. Hai khoảng liền nhau cùng kiểu thì gộp.
 */
export function mergeLayout(
  ranges: LayoutRange[],
  next: { start: number; end: number; mode: LayoutMode | 'cell'; ratio: number; anchor?: LayoutAnchor; rect?: [number, number, number, number]; focus?: [number, number]; fit?: 'fit' },
): LayoutRange[] {
  const out: LayoutRange[] = [];
  for (const range of ranges) {
    if (range.end <= next.start || range.start >= next.end) out.push(range);
    else {
      if (range.start < next.start) out.push({ ...range, end: next.start });
      if (range.end > next.end) out.push({ ...range, start: next.end });
    }
  }
  if (next.mode !== 'full') {
    const range: LayoutRange = { start: next.start, end: next.end, mode: next.mode, ratio: next.ratio };
    if (next.mode !== 'cell' && FANCY.has(next.mode) && next.anchor) range.anchor = next.anchor;
    if (next.mode === 'cell' && next.rect) {
      range.rect = next.rect;
      if (next.focus) range.focus = next.focus;
      if (next.fit) range.fit = next.fit;
    }
    out.push(range);
  }
  out.sort((a, b) => a.start - b.start);
  const merged: LayoutRange[] = [];
  for (const range of out) {
    const last = merged.at(-1);
    const sameCell = JSON.stringify([last?.rect, last?.focus, last?.fit]) === JSON.stringify([range.rect, range.focus, range.fit]);
    if (last && Math.abs(last.end - range.start) < 1e-6 && last.mode === range.mode && last.ratio === range.ratio && last.anchor === range.anchor && sameCell) last.end = range.end;
    else merged.push({ ...range });
  }
  return merged.filter((range) => range.end - range.start >= MIN_RANGE).map((range) => ({ ...range, start: round(range.start), end: round(range.end) }));
}

type Geometry = {
  offset: number;
  panelY: number;
  panelHeight: number;
  opacity: number;
  // Chỉ dùng khi clip có pip/side-by-side (Speaker là rect có mask).
  offsetX: number;
  scale: number;
  maskX: number;
  maskY: number;
  maskW: number;
  maskH: number;
  radius: number;
  panelX: number;
  panelW: number;
  backdrop: number;
};

/** Người nói nguyên khung, không có panel: phần "tĩnh" của mọi hình. */
const rest = (W: number, H: number) => ({ offsetX: 0, scale: 1, maskX: 0, maskY: 0, maskW: W, maskH: H, radius: 0, panelX: 0, panelW: W, backdrop: 0 });

/** Hình học khi đã vào hẳn bố cục (`open`) và lúc panel còn gập (`closed`). */
function geometry(range: LayoutRange, W: number, H: number): { open: Geometry; closed: Geometry } {
  const base = rest(W, H);
  if (range.mode === 'visual-only') {
    return { open: { ...base, offset: 0, panelY: 0, panelHeight: H, opacity: 1 }, closed: { ...base, offset: 0, panelY: 0, panelHeight: H, opacity: 0 } };
  }
  if (range.mode === 'cell' && range.rect) {
    // Cửa sổ đúng tỉ lệ ô, lớn nhất vừa khung, quanh mặt (hoặc theo `focus`), thu/dời vào ô.
    const [rx, ry, rw, rh] = range.rect;
    const cellW = rw * W;
    const cellH = rh * H;
    const aspect = cellW / cellH;
    const fit = range.fit === 'fit';
    // fit: giữ nguyên khung, thu cho vừa ô; fill: cửa sổ đúng tỉ lệ ô, lớn nhất vừa khung.
    const maskW = fit || aspect < W / H ? (fit ? W : H * aspect) : W;
    const maskH = fit ? H : aspect >= W / H ? W / aspect : H;
    const [fx, fy] = range.focus ?? [0.5, NaN];
    const maskX = (W - maskW) * fx;
    const maskY = fit ? 0 : Number.isNaN(fy) ? Math.min(Math.max(FACE_Y * H - maskH * 0.4, 0), H - maskH) : (H - maskH) * fy;
    const scale = fit ? Math.min(cellW / W, cellH / H) : cellW / maskW;
    // fit có viền: dồn khung về điểm neo trong ô.
    const [px, py] = fit ? (range.focus ?? [0.5, 0.5]) : [0.5, 0.5];
    const targetX = rx * W + (fit ? (cellW - W * scale) * px + (W * scale) / 2 : cellW / 2);
    const targetY = ry * H + (fit ? (cellH - H * scale) * py + (H * scale) / 2 : cellH / 2);
    const open: Geometry = {
      ...base,
      offset: round(targetY - H / 2 - scale * (maskY + maskH / 2 - H / 2)),
      offsetX: round(targetX - W / 2 - scale * (maskX + maskW / 2 - W / 2)),
      scale: round(scale),
      maskX: round(maskX),
      maskY: round(maskY),
      maskW: round(maskW),
      maskH: round(maskH),
      radius: 0,
      panelY: 0,
      panelHeight: 0,
      opacity: 0,
      backdrop: 0,
    };
    return { open, closed: { ...base, offset: 0, panelY: 0, panelHeight: 0, opacity: 0 } };
  }
  if (range.mode === 'pip') {
    // Ô vuông quanh mặt (cạnh = cạnh ngắn của khung), thu nhỏ về góc; panel cũ vô hình, nền ở dưới.
    const anchor = anchorFor(range);
    const side = Math.min(W, H);
    const maskX = (W - side) / 2;
    const maskY = Math.min(Math.max(FACE_Y * H - side / 2, 0), H - side);
    const screen = range.ratio * W;
    const scale = screen / side;
    const margin = PIP_MARGIN * W;
    const targetX = anchor.endsWith('right') ? W - margin - screen / 2 : margin + screen / 2;
    const targetY = anchor.startsWith('bottom') ? H - margin - screen / 2 : margin + screen / 2;
    const open: Geometry = {
      ...base,
      offset: round(targetY - H / 2 - scale * (maskY + side / 2 - H / 2)),
      offsetX: round(targetX - W / 2 - scale * (maskX + side / 2 - W / 2)),
      scale: round(scale),
      maskX: round(maskX),
      maskY: round(maskY),
      maskW: round(side),
      maskH: round(side),
      radius: round(side * PIP_RADIUS),
      panelY: 0,
      panelHeight: 0,
      opacity: 0,
      backdrop: 1,
    };
    return { open, closed: { ...base, offset: 0, panelY: 0, panelHeight: 0, opacity: 0 } };
  }
  if (range.mode === 'side-by-side') {
    // Một cột người nói (cắt quanh giữa khung, nơi bám mặt đặt mặt), panel phủ phần còn lại.
    const column = range.ratio * W;
    const left = anchorFor(range) === 'left';
    const maskX = (W - column) / 2;
    const open: Geometry = {
      ...base,
      offset: 0,
      offsetX: round((left ? column / 2 : W - column / 2) - W / 2),
      maskX: round(maskX),
      maskW: round(column),
      panelX: round(left ? column : 0),
      panelW: round(W - column),
      panelY: 0,
      panelHeight: H,
      opacity: 1,
    };
    return { open, closed: { ...base, offset: 0, panelX: left ? W : 0, panelW: 0, panelY: 0, panelHeight: H, opacity: 1 } };
  }
  const band = H * range.ratio;
  // Cửa sổ dọc của khung người nói lọt vào dải: mặt ở ~40% dải.
  const window = Math.min(Math.max(FACE_Y * H - band * 0.4, 0), H - band);
  if (range.mode === 'split-bottom') {
    // Dải ở dưới: panel [0, H − band], khung người nói dời xuống.
    return {
      open: { ...base, offset: round(H - band - window), panelY: 0, panelHeight: round(H - band), opacity: 1 },
      closed: { ...base, offset: 0, panelY: 0, panelHeight: 0, opacity: 1 },
    };
  }
  return {
    open: { ...base, offset: round(-window), panelY: round(band), panelHeight: round(H - band), opacity: 1 },
    closed: { ...base, offset: 0, panelY: H, panelHeight: 0, opacity: 1 },
  };
}

type Key = { time: number; value: number; easing?: string };
const key = (time: number, value: number): Key => ({ time: round(time), value: round(value), easing: 'easeInOut' });

/** Keyframe của group + panel cho mọi khoảng; ngoài khoảng panel vô hình (opacity 0). */
function keyframes(ranges: LayoutRange[], W: number, H: number, duration: number) {
  const base = rest(W, H);
  const tracks = {
    offsetY: [key(0, 0)],
    y: [] as Key[],
    height: [] as Key[],
    opacity: [key(0, 0)],
    offsetX: [key(0, 0)],
    scale: [key(0, 1)],
    maskX: [key(0, base.maskX)],
    maskY: [key(0, base.maskY)],
    maskW: [key(0, base.maskW)],
    maskH: [key(0, base.maskH)],
    radius: [key(0, 0)],
    panelX: [key(0, 0)],
    panelW: [key(0, W)],
    backdrop: [key(0, 0)],
  };
  const push = (time: number, g: Geometry) => {
    const t = Math.min(Math.max(time, 0), duration);
    tracks.offsetY.push(key(t, g.offset));
    tracks.y.push(key(t, g.panelY));
    tracks.height.push(key(t, g.panelHeight));
    tracks.opacity.push(key(t, g.opacity));
    tracks.offsetX.push(key(t, g.offsetX));
    tracks.scale.push(key(t, g.scale));
    tracks.maskX.push(key(t, g.maskX));
    tracks.maskY.push(key(t, g.maskY));
    tracks.maskW.push(key(t, g.maskW));
    tracks.maskH.push(key(t, g.maskH));
    tracks.radius.push(key(t, g.radius));
    tracks.panelX.push(key(t, g.panelX));
    tracks.panelW.push(key(t, g.panelW));
    tracks.backdrop.push(key(t, g.backdrop));
  };
  let previous = -1;
  for (const [index, range] of ranges.entries()) {
    const next = ranges[index + 1];
    const { open, closed } = geometry(range, W, H);
    const T = Math.min(TRANSITION, (range.end - range.start) / 4);
    const hidden = { ...closed, opacity: 0 };
    // Một frame trước: panel đổi sang hình gập của khoảng này khi còn vô hình,
    // để không nội suy từ hình của khoảng trước qua khoảng hở.
    // Khoảng chạm đầu/cuối clip thì vào/ra thẳng, không có cú trượt ở khung đầu/cuối.
    const atStart = range.start < FRAME;
    const atEnd = range.end > duration - FRAME;
    if (!atStart && range.start - FRAME > previous) push(range.start - FRAME, hidden);
    // Sát khoảng trước: khoảng trước đã gập về hình của NÓ đúng lúc này; hình gập
    // của khoảng này đặt sau nửa frame (cả hai gập đều không phủ gì nên đổi ngầm).
    // Chung một mốc thì dedupe bỏ hình gập cũ và khoảng trước trượt thẳng sang
    // hình gập mới — panel hở ra một dải khi hai chế độ khác nhau.
    const joined = previous >= 0 && range.start - (previous - FRAME) < 2 * FRAME;
    if (atStart) push(0, open);
    else {
      push(joined ? Math.max(range.start, previous - FRAME) + FRAME / 2 : range.start, closed);
      push(range.start + T, open);
    }
    if (atEnd) push(duration, open);
    else {
      push(range.end - T, open);
      push(range.end, closed);
    }
    // Khoảng sau bắt đầu sát đây thì nó tự lo hình gập của nó.
    if (range.end + FRAME <= duration && !(next && next.start - range.end < 2 * FRAME)) push(range.end + FRAME, hidden);
    previous = range.end + FRAME;
  }
  // Mốc trùng thời gian (khoảng bắt đầu ở 0, hai khoảng sát nhau): giữ mốc sau.
  const dedupe = (list: Key[]) => list.filter((item, index) => list.findLastIndex((other) => other.time === item.time) === index).sort((a, b) => a.time - b.time);
  return Object.fromEntries(Object.entries(tracks).map(([name, list]) => [name, dedupe(list)])) as Record<keyof typeof tracks, Key[]>;
}

const layoutRole = (node: Entity): string | undefined => (node.marks as { layout?: string } | undefined)?.layout;

/** Node mà cắt bằng chữ thay: sequence có mark `text-cut`, hay video master đơn. */
function masterTarget(document: ClipDocument): ClipNode | undefined {
  const all = nodes(document);
  return all.find((node) => node.kind === 'sequence' && !!(node.marks as Record<string, unknown> | undefined)?.['text-cut']) ?? all.find(isMaster);
}

type Located = { list: Entity[]; index: number };
function locateIn(root: Entity, target: Entity): Located | null {
  for (const key of ['children', 'masks']) {
    const list = (root[key] as Entity[] | undefined) ?? [];
    const index = list.indexOf(target);
    if (index >= 0) return { list, index };
    for (const child of list) {
      const found = locateIn(child, target);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Dựng lại group Speaker + panel từ mark. Không còn khoảng nào thì gỡ group
 * (master về đúng chỗ cũ) và bỏ panel. Không đổi input.
 */
export function rebuildLayout(input: ClipDocument): ClipDocument {
  const document = clone(input);
  const scene = sceneOf(document) as unknown as Entity | undefined;
  if (!scene || !scene.width || !scene.height) return document;
  const W = scene.width as number;
  const H = scene.height as number;
  const ranges = readLayout(document);
  const target = masterTarget(document) as unknown as Entity | undefined;

  // Gỡ trạng thái cũ: panel bỏ đi, group Speaker trả con về chỗ. Giữ bản cũ
  // để dùng lại khi dựng ra y hệt — id giữ nguyên, op gọi lại là "không đổi".
  const previous: Record<string, Entity> = {};
  const unwrap = (holder: Entity) => {
    for (const key of ['children', 'masks']) {
      const list = holder[key] as Entity[] | undefined;
      if (!list) continue;
      for (let index = list.length - 1; index >= 0; index--) {
        const node = list[index]!;
        const role = layoutRole(node);
        if (role === PANEL || role === BACKDROP) (previous[role] = node), list.splice(index, 1);
        else if (role === SPEAKER) (previous[SPEAKER] = node), list.splice(index, 1, ...((node.children as Entity[] | undefined) ?? []));
        else unwrap(node);
      }
    }
  };
  unwrap(scene);
  if (!ranges.length || !target) {
    if (scene.marks && (scene.marks as Record<string, unknown>).layout) {
      const { layout: _layout, ...rest } = scene.marks as Record<string, unknown>;
      scene.marks = Object.keys(rest).length ? rest : undefined;
      if (scene.marks === undefined) delete scene.marks;
    }
    return document;
  }

  const where = locateIn(scene, target);
  if (!where) return document;
  const workarea = scene.workarea as [number, number] | undefined;
  // Không có workarea: lấy độ dài clip thật; lấy mốc cuối của khoảng thì khoảng
  // đó bị coi là "chạm cuối clip" và khung người nói giữ nguyên chỗ dời mãi.
  const duration = workarea?.[1] ?? summarizeProject(document as unknown as ClipDocument).duration ?? Math.max(...ranges.map((range) => range.end));
  // Cắt chữ làm clip ngắn lại: khoảng rơi ngoài clip bỏ đi, khoảng vắt qua cuối
  // thì cắt ngắn — không thì mọi mốc dồn về cuối và panel trượt dần cả clip.
  const live = ranges
    .map((range) => ({ ...range, end: Math.min(range.end, duration) }))
    .filter((range) => range.end - range.start >= MIN_RANGE);
  if (!live.length) return document;
  const tracks = keyframes(live, W, H, duration);
  const fancy = live.some((range) => FANCY.has(range.mode));
  const end = round(duration);
  // Track hằng thì ghi giá trị tĩnh: clip chỉ chia trên/dưới không mang track thừa.
  const animate = (entity: Entity, pairs: [string, Key[]][]) => {
    const list: { property: string; keyframes: Key[] }[] = [];
    for (const [property, keys] of pairs) {
      if (keys.every((item) => item.value === keys[0]!.value)) entity[property] = keys[0]?.value ?? 0;
      else list.push({ property, keyframes: keys }), (entity[property] = keys[0]!.value);
    }
    if (list.length) entity.tracks = list;
    return entity;
  };
  const group: Entity = fancy
    ? animate(
        {
          kind: 'rect',
          name: 'Speaker',
          marks: { layout: SPEAKER },
          // Rect sống 16 giây nếu không có `end` (mặc định renderer) — kể cả mask của nó.
          start: 0,
          end,
          width: W,
          height: H,
          masks: [
            animate({ kind: 'rect', name: 'Speaker mask', start: 0, end }, [
              ['x', tracks.maskX],
              ['y', tracks.maskY],
              ['width', tracks.maskW],
              ['height', tracks.maskH],
              ['cornerRadius', tracks.radius],
            ]),
          ],
          children: [target],
        },
        [
          ['offsetX', tracks.offsetX],
          ['offsetY', tracks.offsetY],
          ['scale', tracks.scale],
        ],
      )
    : {
        kind: 'group',
        name: 'Speaker',
        marks: { layout: SPEAKER },
        tracks: [{ property: 'offsetY', keyframes: tracks.offsetY }],
        children: [target],
      };
  const panel: Entity = {
    kind: 'rect',
    name: 'Layout panel',
    marks: { layout: PANEL },
    // Rect không có `end` chỉ sống 16 giây (mặc định của renderer): phải phủ cả clip.
    start: 0,
    end,
    x: 0,
    y: tracks.y[0]?.value ?? 0,
    width: W,
    height: tracks.height[0]?.value ?? 0,
    opacity: 0,
    paints: [{ type: 'solid', color: PANEL_COLOR }],
    tracks: [
      { property: 'y', keyframes: tracks.y },
      { property: 'height', keyframes: tracks.height },
      { property: 'opacity', keyframes: tracks.opacity },
    ],
  };
  if (fancy) {
    const sideways = animate({}, [
      ['x', tracks.panelX],
      ['width', tracks.panelW],
    ]);
    Object.assign(panel, { x: sideways.x, width: sideways.width });
    if (sideways.tracks) (panel.tracks as unknown[]).unshift(...(sideways.tracks as unknown[]));
  }
  const nodesOut: Entity[] = [reuse(previous[SPEAKER], group), reuse(previous[PANEL], panel)];
  if (live.some((range) => range.mode === 'pip')) {
    const backdrop = animate(
      {
        kind: 'rect',
        name: 'Layout backdrop',
        marks: { layout: BACKDROP },
        start: 0,
        end,
        x: 0,
        y: 0,
        width: W,
        height: H,
        paints: [{ type: 'solid', color: PANEL_COLOR }],
      },
      [['opacity', tracks.backdrop]],
    );
    nodesOut.unshift(reuse(previous[BACKDROP], backdrop));
  }
  where.list.splice(where.index, 1, ...nodesOut);
  return document;
}

/** Bỏ `id` ở mọi tầng — để so nội dung của hai bản dựng. */
function withoutIds(value: unknown, skip?: unknown): unknown {
  if (skip !== undefined && value === skip) return '§';
  if (Array.isArray(value)) return value.map((item) => withoutIds(item, skip));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'id').map(([key, item]) => [key, withoutIds(item, skip)]));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  // Khoá mang undefined bị bỏ như JSON.stringify.
  return `{${Object.keys(value)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

/** Bản cũ nếu nội dung (trừ id, và trừ master bên trong) y hệt bản mới. */
function reuse(old: Entity | undefined, fresh: Entity): Entity {
  if (!old) return fresh;
  const inner = (fresh.children as Entity[] | undefined)?.[0];
  // So theo khoá đã sắp: jsonb của Postgres đổi thứ tự khoá khi lưu.
  const same = stable(withoutIds({ ...old, children: fresh.children }, inner)) === stable(withoutIds(fresh, inner));
  return same ? { ...old, children: fresh.children } : fresh;
}

/** Ghi mark rồi dựng lại. */
export function writeLayout(input: ClipDocument, ranges: LayoutRange[]): ClipDocument {
  const document = clone(input);
  const scene = sceneOf(document);
  if (!scene) return document;
  scene.marks = { ...scene.marks, layout: { ranges } };
  return rebuildLayout(document);
}

/**
 * Vùng panel (chuẩn hoá 0–1, có lề) ở giây `time`, để visual thêm vào khoảng
 * chia đôi tự nằm trong panel; null khi lúc đó không chia.
 */
export function panelRegionAt(document: ClipDocument, time: number): { x: number; y: number; width: number; height: number } | null {
  const range = readLayout(document).find((item) => time >= item.start - 1e-6 && time < item.end);
  if (!range || range.mode === 'cell') return null;
  if (range.mode === 'visual-only') return { x: 0.06, y: 0.08, width: 0.88, height: 0.84 };
  const scene = sceneOf(document);
  const aspect = scene?.width && scene?.height ? (scene.width as number) / (scene.height as number) : 9 / 16;
  if (range.mode === 'pip') {
    // Visual nằm trên người nói trong z-order: chừa hẳn dải có ô PiP.
    const cell = round((range.ratio + PIP_MARGIN * 2) * aspect);
    return anchorFor(range).startsWith('bottom')
      ? { x: 0.06, y: 0.06, width: 0.88, height: round(Math.max(0.2, 1 - cell - 0.1)) }
      : { x: 0.06, y: round(cell + 0.04), width: 0.88, height: round(Math.max(0.2, 1 - cell - 0.1)) };
  }
  if (range.mode === 'side-by-side') {
    const rest = 1 - range.ratio;
    const left = anchorFor(range) === 'left' ? range.ratio : 0;
    return { x: round(left + rest * 0.06), y: 0.1, width: round(rest * 0.88), height: 0.8 };
  }
  const panel = 1 - range.ratio;
  const top = range.mode === 'split-bottom' ? 0 : range.ratio;
  return { x: 0.06, y: round(top + panel * 0.1), width: 0.88, height: round(panel * 0.8) };
}

/** Dải người nói (chuẩn hoá) ở giây `time`; null khi không chia hoặc cảnh visual riêng. */
export function speakerBandAt(document: ClipDocument, time: number): { y: number; height: number } | null {
  const range = readLayout(document).find((item) => time >= item.start - 1e-6 && time < item.end);
  if (!range || range.mode === 'visual-only' || range.mode === 'pip' || range.mode === 'side-by-side' || range.mode === 'cell') return null;
  return range.mode === 'split-bottom' ? { y: 1 - range.ratio, height: range.ratio } : { y: 0, height: range.ratio };
}
