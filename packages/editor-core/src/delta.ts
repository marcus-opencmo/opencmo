/**
 * Phần đổi giữa hai bản document — thứ agent nhận sau mỗi lần ghi thay cho việc
 * đọc lại cả project (học từ "mutation delta" của Palmier Pro, spec
 * docs/specs/2026-10-03-hoc-palmier.md §A1). Agent tự cập nhật hình dung của nó
 * từ đây; đọc lại chỉ khi `reread` bật.
 *
 * Chỉ ở mức node: đổi keyframe/effect/paint của một node hiện thành tên khoá
 * (`tracks`, `effects`…) trên chính node đó. Nhiều node cùng dời một khoảng gộp
 * thành một luật `shift` thay vì liệt kê từng cái.
 */

import type { ClipDocument } from '@opencmo/clip-doc';

import { same, walk, type Entity } from './doc';
import { summarizeProject, type ProjectSummary } from './summary';

/** Liệt kê tối đa ngần này node đổi; còn lại chỉ đếm. */
export const DELTA_LIMIT = 30;
/** Từ ngần này node dời cùng khoảng trở lên thì gộp thành một luật. */
const SHIFT_MIN = 3;

/** Khoá không phải dữ liệu dựng (trạng thái editor) — không báo. */
const EDITOR_STATE = new Set(['selected', 'expanded', 'clipHeight', 'timeline', 'playhead']);
/** Khoá chứa node con: con có mục riêng, không báo trên cha. */
const NESTED = new Set(['children', 'masks']);
const TIMING = new Set(['start', 'end']);

const r3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Giá trị ngắn gọn cho agent: số làm tròn, chữ cắt, mảng/object thành "changed". */
function brief(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'number') return r3(value);
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  if (value === null || typeof value === 'boolean') return value;
  return 'changed';
}

type NodeInfo = { entity: Entity; tag: string; parent: string | null };

function nodeMap(document: ClipDocument): Map<string, NodeInfo> {
  const out = new Map<string, NodeInfo>();
  walk(document, ({ entity, tag, parent }) => {
    if (entity.kind !== tag || typeof entity.id !== 'string') return;
    // Stage không phải node (không có `kind`) và có thể được stamp id ở lần ghi đầu: không tính là cha.
    const owner = parent && typeof parent.kind === 'string' && typeof parent.id === 'string' ? parent.id : null;
    out.set(entity.id, { entity, tag, parent: owner });
  });
  return out;
}

function label(entity: Entity, tag: string): string | null {
  if (tag === 'text' && typeof entity.text === 'string') return brief(entity.text.trim()) as string;
  if (tag === 'scene' && typeof entity.name === 'string') return entity.name;
  if (typeof entity.src === 'string') return entity.src;
  if (typeof entity.name === 'string') return entity.name;
  return null;
}

export type AddedNode = { id: string; tag: string; parent: string | null; start?: number; end?: number; label?: string };
export type ChangedNode = { id: string; tag: string; set: Record<string, unknown> };
export type ShiftRule = { by: number; count: number; ids: string[] };

export type DocumentDelta = {
  added: AddedNode[];
  removed: Array<{ id: string; tag: string }>;
  changed: ChangedNode[];
  /** Node chỉ dời start/end cùng một khoảng (giây). */
  shifted: ShiftRule[];
  /** Thông tin cấp project đổi: độ dài sau cắt, khung, phụ đề, vùng cắt. */
  project: Partial<Pick<ProjectSummary, 'duration' | 'frame' | 'captions' | 'cut'>>;
  /** Số mục bị bỏ vì quá `DELTA_LIMIT`. */
  omitted: number;
  /** Đổi lớn (đổi thứ tự lớp, nhiều node) — nên đọc lại trước khi sửa tiếp. */
  reread: boolean;
};

/** Khoá đổi của một node (bỏ con và trạng thái editor). */
function changedKeys(before: Entity, after: Entity): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !NESTED.has(key) && !EDITOR_STATE.has(key) && key !== 'id' && !same(before[key], after[key])).sort();
}

const childIds = (entity: Entity): string[] =>
  ((entity.children as Entity[] | undefined) ?? []).map((child) => (typeof child.id === 'string' ? child.id : '?'));

export function diffDocuments(before: ClipDocument, after: ClipDocument): DocumentDelta {
  const left = nodeMap(before);
  const right = nodeMap(after);
  const added: AddedNode[] = [];
  const removed: Array<{ id: string; tag: string }> = [];
  const changed: ChangedNode[] = [];
  const shifts = new Map<number, string[]>();
  let reordered = false;

  for (const [id, info] of right) {
    const old = left.get(id);
    if (!old) {
      const { entity, tag, parent } = info;
      const item: AddedNode = { id, tag, parent };
      if (typeof entity.start === 'number') item.start = r3(entity.start);
      if (typeof entity.end === 'number') item.end = r3(entity.end);
      const name = label(entity, tag);
      if (name) item.label = name;
      added.push(item);
      continue;
    }
    // Đổi cha, hoặc cùng tập con nhưng khác thứ tự (move_layer): thứ tự vẽ đổi, agent nên đọc lại.
    const was = childIds(old.entity);
    const now = childIds(info.entity);
    if (old.parent !== info.parent || (was.length === now.length && !same(was, now) && same([...was].sort(), [...now].sort()))) reordered = true;
    const keys = changedKeys(old.entity, info.entity);
    if (!keys.length) continue;
    // Chỉ dời thời gian (start/end cùng lệch một khoảng) → gộp vào luật shift.
    const a = old.entity;
    const b = info.entity;
    if (
      keys.every((key) => TIMING.has(key)) &&
      typeof a.start === 'number' &&
      typeof b.start === 'number' &&
      (a.end === undefined || (typeof a.end === 'number' && typeof b.end === 'number' && r3(b.end - a.end) === r3(b.start - a.start)))
    ) {
      const by = r3(b.start - a.start);
      shifts.set(by, [...(shifts.get(by) ?? []), id]);
      continue;
    }
    const set: Record<string, unknown> = {};
    for (const key of keys) set[key] = brief(info.entity[key]);
    changed.push({ id, tag: info.tag, set });
  }
  for (const [id, info] of left) if (!right.has(id)) removed.push({ id, tag: info.tag });

  const shifted: ShiftRule[] = [];
  for (const [by, ids] of shifts) {
    if (ids.length >= SHIFT_MIN) shifted.push({ by, count: ids.length, ids });
    else for (const id of ids) changed.push({ id, tag: right.get(id)!.tag, set: { start: brief(right.get(id)!.entity.start), end: brief(right.get(id)!.entity.end) } });
  }

  const project: DocumentDelta['project'] = {};
  const was = summarizeProject(before);
  const now = summarizeProject(after);
  for (const key of ['duration', 'frame', 'captions', 'cut'] as const) {
    if (!same(was[key], now[key])) (project as Record<string, unknown>)[key] = now[key];
  }

  const total = added.length + removed.length + changed.length;
  const over = Math.max(0, total - DELTA_LIMIT);
  // Cắt theo thứ tự ưu tiên: thêm → xoá → đổi.
  let room = DELTA_LIMIT;
  const take = <T>(list: T[]): T[] => {
    const kept = list.slice(0, Math.max(0, room));
    room -= kept.length;
    return kept;
  };
  return {
    added: take(added),
    removed: take(removed),
    changed: take(changed),
    shifted,
    project,
    omitted: over,
    reread: reordered || over > 0,
  };
}

/** Delta rỗng: op không đổi gì. */
export const emptyDelta = (delta: DocumentDelta): boolean =>
  !delta.added.length && !delta.removed.length && !delta.changed.length && !delta.shifted.length && !Object.keys(delta.project).length;
