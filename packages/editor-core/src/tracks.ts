/**
 * Hàng (track) của timeline: một `sequence` mà mọi con cùng một "làn" — b-roll
 * với b-roll, phụ đề với phụ đề, âm thanh với âm thanh. Không có mark riêng:
 * sequence nào toàn con cùng làn là một hàng, nên document cũ, worker export
 * và schema không phải biết gì thêm (một mark mới là đổi schema → worker trên
 * Modal cũ từ chối document).
 *
 * Trước đây mỗi b-roll chèn vào là một lớp con của scene → một hàng riêng; mười
 * b-roll là mười hàng, không gom lại được (UAT 09/10/2026).
 */

import type { ClipDocument, ClipNode } from '@opencmo/clip-doc';

import { clone, isMaster, isMasterSound, sceneOf, type Entity } from './doc';
import type { OpContext } from './ops/context';
import { nextName, timesOf } from './ops/timeline';

const FPS = 30;
/** Chồng ở đầu tới ngần này frame thì dời clip mới cho khít, không mở hàng mới. */
const NUDGE = 2;

export type Lane = 'visual' | 'captions' | 'audio' | 'text' | 'graphic';

export const LANE_NAME: Record<Lane, string> = {
  visual: 'B-roll',
  captions: 'Captions',
  audio: 'Audio',
  text: 'Text',
  graphic: 'Graphics',
};

const hasMediaPaint = (entity: Entity): boolean =>
  Array.isArray(entity.paints) && (entity.paints as Entity[]).some((paint) => paint.type === 'video' || paint.type === 'image');

/**
 * Làn của một node; null = không xếp chung hàng được (video gốc, nhóm, sequence
 * cắt bằng chữ, sequence lẫn làn).
 */
export function laneOf(node: object): Lane | null {
  const entity = node as Entity;
  switch (entity.kind) {
    case 'captions':
      return 'captions';
    case 'audio':
      return isMasterSound(node as ClipNode) ? null : 'audio';
    case 'video':
      return isMaster(node as ClipNode) ? null : 'visual';
    case 'image':
      return 'visual';
    case 'rect':
      return hasMediaPaint(entity) ? 'visual' : 'graphic';
    case 'text':
      return 'text';
    case 'path':
    case 'lottie':
    case 'scene3d':
      return 'graphic';
    case 'sequence': {
      if ((entity.marks as Entity | undefined)?.['text-cut']) return null;
      const children = (entity.children as Entity[] | undefined) ?? [];
      const lanes = new Set(children.map(laneOf));
      return lanes.size === 1 ? [...lanes][0]! : null;
    }
    default:
      return null;
  }
}

/** Sequence là một hàng của làn `lane`. */
export const isRow = (node: object, lane?: Lane): boolean =>
  (node as Entity).kind === 'sequence' && laneOf(node) !== null && (lane === undefined || laneOf(node) === lane);

/** Vị trí ngay dưới lớp chữ/phụ đề đầu tiên của scene — hình không che chữ. */
export function belowText(children: ClipNode[]): number {
  const at = children.findIndex((child) => {
    const lane = laneOf(child);
    return lane === 'captions' || lane === 'text';
  });
  return at < 0 ? children.length : at;
}

/** Tên hàng mới: "B-roll 1", "B-roll 2"… */
export const rowName = (document: ClipDocument, lane: Lane): string => nextName(document, LANE_NAME[lane]);

/**
 * Thêm `node` vào scene đang mở, vào hàng cùng làn còn trống chỗ (không chồng
 * giờ với clip nào trong hàng); không có thì mở một hàng mới. Chỉ b-roll và âm
 * thanh tự gom — chữ, phụ đề, hình vẽ vẫn là lớp riêng như trước. Hình (b-roll)
 * nằm dưới chữ/phụ đề, không che tiêu đề.
 */
export function placeInRow(document: ClipDocument, input: ClipNode, ctx: Pick<OpContext, 'media'>): ClipDocument {
  const next = clone(document);
  const scene = sceneOf(next)!;
  const children = [...(scene.children ?? [])];
  const node = structuredClone(input);
  const lane = laneOf(node);
  const voiceover = Boolean((node as { marks?: Entity }).marks?.voiceover);
  if (lane !== 'visual' && lane !== 'audio') {
    children.push(node);
    scene.children = children;
    return next;
  }
  // Giải thời gian với node đã nằm trong scene: độ dài media chỉ biết sau khi giải.
  children.push(node);
  scene.children = children;
  const times = timesOf(next, ctx);
  const own = times.get(node);
  children.pop();
  if (own && !voiceover) {
    // Frame phải dời node để vào hàng này; null = hàng không còn chỗ. Playhead kẹp ở
    // frame CUỐI của nội dung, nên "thêm nối đuôi" luôn chồng clip trước đúng một frame
    // (e2e 09/10) — chồng ở đầu tới NUDGE frame thì dời node tới mép clip đó.
    const shiftFor = (row: ClipNode): number | null => {
      let shift = 0;
      for (const child of (row as { children?: ClipNode[] }).children ?? []) {
        const t = times.get(child);
        if (!t || t.end <= own.start || t.start >= own.end) continue;
        if (t.start < own.start && t.end - own.start <= NUDGE) shift = Math.max(shift, t.end - own.start);
        else return null;
      }
      if (!shift) return 0;
      const moved = { start: own.start + shift, end: own.end + shift };
      const clear = ((row as { children?: ClipNode[] }).children ?? []).every((child) => {
        const t = times.get(child);
        return !t || t.end <= moved.start || t.start >= moved.end;
      });
      return clear ? shift : null;
    };
    // Hàng trên cùng trước: thứ người dùng vừa thêm thường thuộc hàng gần nhất.
    for (const row of [...children].reverse()) {
      if (!isRow(row, lane)) continue;
      const shift = shiftFor(row);
      if (shift === null) continue;
      if (shift) {
        const entity = node as unknown as Entity;
        const seconds = (value: number) => Math.round(value * 1e4) / 1e4;
        entity.start = seconds((typeof entity.start === 'number' ? entity.start : 0) + shift / FPS);
        if (typeof entity.end === 'number') entity.end = seconds(entity.end + shift / FPS);
      }
      (row as { children: ClipNode[] }).children.push(node);
      scene.children = children;
      return next;
    }
  }
  const wrapped = voiceover ? node : ({ kind: 'sequence', name: rowName(next, lane), children: [node] } as ClipNode);
  children.splice(lane === 'visual' ? belowText(children) : children.length, 0, wrapped);
  scene.children = children;
  return next;
}
