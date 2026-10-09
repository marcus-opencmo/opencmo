/**
 * Marker trên timeline (học Palmier §B6): điểm hoặc khoảng có tên, màu, ghi chú
 * và trạng thái duyệt (open / review / resolved) — chỗ người dùng và Assistant
 * để lại "sửa đoạn này". Nằm ở `marks.markers` của scene: không đổi schema
 * document, renderer bỏ qua, export không thấy.
 */

import { z } from 'zod';

import { MARKER_COLORS, MARKER_STATUSES, MarkerSchema, type ClipDocument, type Marker } from '@opencmo/clip-doc';

import { clone, type Entity } from '../doc';
import { OpFailure } from './context';
import { activeScene } from './timeline';

export { MARKER_COLORS, MARKER_STATUSES, type Marker };
const MAX_MARKERS = 200;

const r4 = (value: number) => Math.round(value * 1e4) / 1e4;

/** Marker của scene đang mở, theo thời gian; dữ liệu hỏng thì bỏ (không làm hỏng cả document). */
export function readMarkers(document: ClipDocument): Marker[] {
  const scene = activeScene(document) as unknown as Entity;
  const raw = (scene.marks as Record<string, unknown> | undefined)?.markers;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const parsed = MarkerSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function writeMarkers(document: ClipDocument, markers: Marker[]): void {
  const scene = activeScene(document) as unknown as Entity;
  const marks = { ...((scene.marks as Record<string, unknown> | undefined) ?? {}) };
  const sorted = [...markers].sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
  if (sorted.length) marks.markers = sorted;
  else delete marks.markers;
  if (Object.keys(marks).length) scene.marks = marks;
  else delete scene.marks;
}

function newId(taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const id = `m${n}`;
    if (!taken.has(id)) return id;
  }
}

type SetMarker = {
  marker_id?: string;
  time?: number;
  duration?: number;
  name?: string;
  color?: Marker['color'];
  comment?: string | null;
  status?: Marker['status'];
};

export const setMarker = {
  name: 'set_marker',
  input: z.object({
    op: z.literal('set_marker'),
    marker_id: z.string().min(1).max(40).optional().describe('Omit to add a new marker; give it to change an existing one.'),
    time: z.number().min(0).max(24 * 3600).optional().describe('Seconds on the clip timeline. Required for a new marker.'),
    duration: z.number().min(0).max(24 * 3600).optional().describe('0 for a point, more for a range.'),
    name: z.string().trim().min(1).max(120).optional(),
    color: z.enum(MARKER_COLORS).optional(),
    comment: z.string().max(4000).nullable().optional().describe('A note for this spot; null removes it.'),
    status: z.enum(MARKER_STATUSES).optional(),
  }),
  describe: (input: SetMarker) => (input.marker_id ? 'Change a marker' : 'Add a marker'),
  async apply(document: ClipDocument, input: SetMarker) {
    const next = clone(document);
    const markers = readMarkers(next);
    if (!input.marker_id) {
      if (input.time === undefined) throw new OpFailure('Give the time for the new marker.');
      if (markers.length >= MAX_MARKERS) throw new OpFailure(`A clip can have at most ${MAX_MARKERS} markers.`);
      const id = newId(new Set(markers.map((marker) => marker.id)));
      markers.push({
        id,
        name: input.name ?? `Marker ${markers.length + 1}`,
        time: r4(input.time),
        duration: r4(input.duration ?? 0),
        color: input.color ?? 'blue',
        ...(input.comment ? { comment: input.comment } : {}),
        status: input.status ?? 'open',
      });
    } else {
      const marker = markers.find((item) => item.id === input.marker_id);
      if (!marker) throw new OpFailure(`There is no marker "${input.marker_id}".`);
      if (input.time !== undefined) marker.time = r4(input.time);
      if (input.duration !== undefined) marker.duration = r4(input.duration);
      if (input.name !== undefined) marker.name = input.name;
      if (input.color !== undefined) marker.color = input.color;
      if (input.status !== undefined) marker.status = input.status;
      if (input.comment === null || input.comment === '') delete marker.comment;
      else if (input.comment !== undefined) marker.comment = input.comment;
    }
    writeMarkers(next, markers);
    return next;
  },
};

export const deleteMarker = {
  name: 'delete_marker',
  input: z.object({ op: z.literal('delete_marker'), marker_id: z.string().min(1).max(40) }),
  describe: () => 'Delete a marker',
  async apply(document: ClipDocument, input: { marker_id: string }) {
    const next = clone(document);
    const markers = readMarkers(next);
    const kept = markers.filter((marker) => marker.id !== input.marker_id);
    if (kept.length === markers.length) throw new OpFailure(`There is no marker "${input.marker_id}".`);
    writeMarkers(next, kept);
    return next;
  },
};
