/**
 * 13 bố cục nhiều nguồn (E5, học hành vi `VideoLayout` của Palmier — số liệu tự viết lại):
 * mỗi bố cục là các ô chuẩn hoá 0–1 của khung, có `z` (ô PiP nằm trên ô chính).
 *
 * Khác `layout.ts` (người nói + panel visual theo khoảng thời gian): ở đây mỗi ô nhận một
 * phần tử media có sẵn — B-roll, ảnh, hay chính video của clip.
 */

export const VIDEO_LAYOUTS = [
  'full',
  'side_by_side',
  'top_bottom',
  'pip_bottom_right',
  'pip_bottom_left',
  'pip_top_right',
  'pip_top_left',
  'grid_2x2',
  'grid_3x3',
  'grid_4x4',
  'main_sidebar',
  'three_up',
  'three_stack',
] as const;
export type VideoLayout = (typeof VIDEO_LAYOUTS)[number];

/** [x, y, w, h] chuẩn hoá theo khung. */
export type SlotRect = [number, number, number, number];
export type LayoutSlot = { id: string; rect: SlotRect; z: number };

export const LAYOUT_LABEL: Record<VideoLayout, string> = {
  full: 'Full Frame',
  side_by_side: 'Side by Side',
  top_bottom: 'Top / Bottom',
  pip_bottom_right: 'PiP Bottom Right',
  pip_bottom_left: 'PiP Bottom Left',
  pip_top_right: 'PiP Top Right',
  pip_top_left: 'PiP Top Left',
  grid_2x2: 'Grid 2×2',
  grid_3x3: 'Grid 3×3',
  grid_4x4: 'Grid 4×4',
  main_sidebar: 'Main + Sidebar',
  three_up: 'Three-Up',
  three_stack: 'Three-Stack',
};

/** Ô PiP: cạnh theo phần khung, lề tới mép. */
const PIP_SIZE = 0.28;
const PIP_MARGIN = 0.035;
const THIRD = 1 / 3;

const slot = (id: string, rect: SlotRect, z = 0): LayoutSlot => ({ id, rect, z });

function grid(size: number): LayoutSlot[] {
  const cell = 1 / size;
  const out: LayoutSlot[] = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) out.push(slot(`r${row + 1}c${column + 1}`, [column * cell, row * cell, cell, cell]));
  }
  return out;
}

function pip(right: boolean, bottom: boolean): LayoutSlot[] {
  const x = right ? 1 - PIP_MARGIN - PIP_SIZE : PIP_MARGIN;
  const y = bottom ? 1 - PIP_MARGIN - PIP_SIZE : PIP_MARGIN;
  return [slot('main', [0, 0, 1, 1]), slot('inset', [x, y, PIP_SIZE, PIP_SIZE], 1)];
}

export function layoutSlots(layout: VideoLayout): LayoutSlot[] {
  switch (layout) {
    case 'full':
      return [slot('main', [0, 0, 1, 1])];
    case 'side_by_side':
      return [slot('left', [0, 0, 0.5, 1]), slot('right', [0.5, 0, 0.5, 1])];
    case 'top_bottom':
      return [slot('top', [0, 0, 1, 0.5]), slot('bottom', [0, 0.5, 1, 0.5])];
    case 'pip_bottom_right':
      return pip(true, true);
    case 'pip_bottom_left':
      return pip(false, true);
    case 'pip_top_right':
      return pip(true, false);
    case 'pip_top_left':
      return pip(false, false);
    case 'grid_2x2':
      return grid(2);
    case 'grid_3x3':
      return grid(3);
    case 'grid_4x4':
      return grid(4);
    case 'main_sidebar':
      return [slot('main', [0, 0, 0.7, 1]), slot('sidebar', [0.7, 0, 0.3, 1])];
    case 'three_up':
      return [slot('left', [0, 0, THIRD, 1]), slot('center', [THIRD, 0, THIRD, 1]), slot('right', [2 * THIRD, 0, THIRD, 1])];
    case 'three_stack':
      return [slot('top', [0, 0, 1, THIRD]), slot('middle', [0, THIRD, 1, THIRD]), slot('bottom', [0, 2 * THIRD, 1, THIRD])];
  }
}

/** Bố cục có đúng `count` ô — UI chỉ đưa những kiểu dùng hết các phần tử đang chọn. */
export const layoutsFor = (count: number): VideoLayout[] => VIDEO_LAYOUTS.filter((layout) => layoutSlots(layout).length === count);

export const LAYOUT_ANCHOR_NAMES = ['center', 'top', 'bottom', 'left', 'right', 'top_left', 'top_right', 'bottom_left', 'bottom_right'] as const;
export type AnchorName = (typeof LAYOUT_ANCHOR_NAMES)[number];

/** Điểm neo [x, y] 0–1: phần nào của media được giữ khi bị cắt (fill) hay dồn về đâu (fit). */
export function anchorPoint(name: AnchorName | undefined, x?: number, y?: number): [number, number] {
  const base: Record<AnchorName, [number, number]> = {
    center: [0.5, 0.5],
    top: [0.5, 0],
    bottom: [0.5, 1],
    left: [0, 0.5],
    right: [1, 0.5],
    top_left: [0, 0],
    top_right: [1, 0],
    bottom_left: [0, 1],
    bottom_right: [1, 1],
  };
  const [ax, ay] = base[name ?? 'center'];
  return [x ?? ax, y ?? ay];
}

/** Ô ra pixel của khung W×H (làm tròn 2 chữ số như mọi toạ độ document). */
export function slotBox([x, y, w, h]: SlotRect, W: number, H: number): { x: number; y: number; width: number; height: number } {
  const round = (value: number) => Math.round(value * 100) / 100;
  return { x: round(x * W), y: round(y * H), width: round(w * W), height: round(h * H) };
}
