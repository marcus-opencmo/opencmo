/**
 * Nhiều timeline (E2-a, học Palmier `create_timeline` / `set_active_timeline`):
 * mỗi timeline là một scene cấp stage của cùng document. Nhân bản là cách làm
 * phiên bản — "bản cắt gọn hơn", "bản 9:16" — mà bản gốc giữ nguyên.
 *
 * Các op ở đây chạy trên CẢ document (applyOps không thu về timeline đang mở như
 * op thường), vì chính chúng chọn timeline.
 */

import { z } from 'zod';

import type { ClipDocument, SceneNode } from '@opencmo/clip-doc';

import { clone, timelineLabel, timelinesOf, type Entity } from '../doc';
import { OpFailure } from './context';
import { copyOf } from './timeline';

const timelineId = z.string().min(1).max(64);
const timelineName = z.string().trim().min(1).max(60);
/** Khoảng trống giữa hai timeline đặt cạnh nhau trên canvas. */
const GAP = 200;


function find(document: ClipDocument, id: string): SceneNode {
  const scene = timelinesOf(document).find((candidate) => candidate.id === id);
  if (!scene) throw new OpFailure('That timeline is not in this project.');
  return scene;
}

function activate(document: ClipDocument, target: Entity): void {
  for (const scene of timelinesOf(document)) delete (scene as unknown as Entity).active;
  target.active = true;
}

type CreateTimeline = { name?: string; from?: string };

export const createTimeline = {
  name: 'create_timeline',
  input: z.object({ op: z.literal('create_timeline'), name: timelineName.optional(), from: timelineId.optional() }),
  describe: (input: CreateTimeline) => (input.from ? `Duplicate a timeline${input.name ? ` as "${input.name}"` : ''}` : `New timeline${input.name ? ` "${input.name}"` : ''}`),
  async apply(document: ClipDocument, input: CreateTimeline) {
    const scenes = timelinesOf(document);
    const active = scenes.find((scene) => scene.active) ?? scenes[0];
    if (!active) throw new OpFailure('This project has no timeline to copy.');
    const source = input.from ? find(document, input.from) : active;
    const index = scenes.indexOf(source);
    const right = Math.max(...scenes.map((scene) => (scene.x ?? 0) + scene.width));
    let node: Entity;
    if (input.from) {
      node = copyOf(source as unknown as Entity);
      node.name = input.name ?? `${timelineLabel(source, index)} copy`;
    } else {
      // Timeline trống thừa hưởng cỡ khung của timeline đang mở, như Palmier.
      node = { kind: 'scene', name: input.name ?? `Timeline ${scenes.length + 1}`, width: source.width, height: source.height, fill: source.fill ?? '#000000', workarea: [0, 10] };
    }
    node.x = right + GAP;
    node.y = source.y ?? 0;
    delete node.playhead;
    const next = clone(document);
    activate(next, node);
    (next.stage.children as unknown as Entity[]).push(node);
    return next;
  },
};

type SetActiveTimeline = { timeline_id: string };

export const setActiveTimeline = {
  name: 'set_active_timeline',
  input: z.object({ op: z.literal('set_active_timeline'), timeline_id: timelineId }),
  describe: () => 'Switch timeline',
  async apply(document: ClipDocument, input: SetActiveTimeline) {
    const target = find(document, input.timeline_id);
    const scenes = timelinesOf(document);
    if ((scenes.find((scene) => scene.active) ?? scenes[0]) === target) return document;
    const next = clone(document);
    activate(next, find(next, input.timeline_id) as unknown as Entity);
    return next;
  },
};

type RenameTimeline = { timeline_id: string; name: string };

export const renameTimeline = {
  name: 'rename_timeline',
  input: z.object({ op: z.literal('rename_timeline'), timeline_id: timelineId, name: timelineName }),
  describe: (input: RenameTimeline) => `Rename timeline to "${input.name}"`,
  async apply(document: ClipDocument, input: RenameTimeline) {
    find(document, input.timeline_id);
    const next = clone(document);
    (find(next, input.timeline_id) as unknown as Entity).name = input.name;
    return next;
  },
};

type DeleteTimeline = { timeline_id: string };

export const deleteTimeline = {
  name: 'delete_timeline',
  input: z.object({ op: z.literal('delete_timeline'), timeline_id: timelineId }),
  describe: () => 'Delete a timeline',
  async apply(document: ClipDocument, input: DeleteTimeline) {
    const target = find(document, input.timeline_id);
    const scenes = timelinesOf(document);
    if (scenes.length < 2) throw new OpFailure('A project keeps at least one timeline.');
    const next = clone(document);
    const index = next.stage.children.findIndex((node) => node.id === target.id);
    const [removed] = next.stage.children.splice(index, 1);
    // Xoá timeline đang mở: mở timeline đứng trước nó (hoặc timeline đầu).
    if ((removed as SceneNode).active || !timelinesOf(next).some((scene) => scene.active)) {
      const remaining = timelinesOf(next);
      activate(next, remaining[Math.max(0, scenes.indexOf(target) - 1)] as unknown as Entity);
    }
    return next;
  },
};

/** Op chọn/tạo/xoá timeline: chạy trên cả document, không thu về timeline đang mở. */
export const STAGE_OPS = new Set(['insert_scene', 'activate_scene', 'create_timeline', 'set_active_timeline', 'rename_timeline', 'delete_timeline']);
