/**
 * Op của thư viện media (spec editor-rewrite B5): chèn một asset thành node, và
 * đổi `src` theo khi asset đổi tên/dời thư mục trong thư viện.
 *
 * `insert_node` Assistant gọi thẳng được (thêm chữ/hình/B-roll với đủ prop).
 * `replace_src` thì không: thư viện (manifest) do UI sửa bằng
 * `@opencmo/clip-assets`, và lượt lưu gửi manifest cùng document — nên đổi tên
 * asset và đổi `src` của element là MỘT lượt ghi, một bước Undo.
 */

import { z } from 'zod';

import type { AssetInput, ClipDocument } from '@opencmo/clip-doc';

import { byId, clone, walk, type Entity } from '../doc';
import { OpFailure } from './context';
import { checked } from './project';

const CONTAINERS = new Set(['scene', 'group', 'sequence']);

type InsertNode = { parent_id: string; node: Record<string, unknown>; index?: number };

export const insertNode = {
  name: 'insert_node',
  input: z.object({
    op: z.literal('insert_node'),
    parent_id: z.string().min(1).max(64),
    node: z.record(z.string(), z.unknown()).refine((node) => typeof node.kind === 'string', 'A node needs a kind.'),
    index: z.number().int().min(0).optional(),
  }),
  describe: () => 'Add media to the clip',
  async apply(document: ClipDocument, input: InsertNode) {
    const next = clone(document);
    const parent = byId(next, input.parent_id);
    if (!parent || !CONTAINERS.has(parent.tag) || parent.entity.kind !== parent.tag) {
      throw new OpFailure('Media can only be added to the scene, a group or a sequence.');
    }
    const node = structuredClone(input.node) as Entity;
    delete node.id;
    const children = ((parent.entity.children as Entity[] | undefined) ??= []);
    // Cuối mảng là lớp trên cùng — thứ vừa thả phải nhìn thấy được.
    children.splice(Math.min(input.index ?? children.length, children.length), 0, node);
    return checked(next, 'That media cannot be added here');
  },
};

/** Đổi mọi chỗ `from` xuất hiện làm nguồn — kể cả làm đầu vào của khai báo `generate`/`transform`. */
function renamed(input: AssetInput, from: string, to: string): AssetInput {
  if (typeof input === 'string') return input === from ? to : input;
  const out = { ...input } as Record<string, unknown>;
  for (const key of ['input', 'startFrame', 'endFrame']) {
    if (out[key] !== undefined) out[key] = renamed(out[key] as AssetInput, from, to);
  }
  if (Array.isArray(out.refs)) out.refs = (out.refs as AssetInput[]).map((ref) => renamed(ref, from, to));
  return out as AssetInput;
}

type ReplaceSrc = { renames: { from: string; to: string }[] };

export const replaceSrc = {
  name: 'replace_src',
  agent: false,
  input: z.object({
    op: z.literal('replace_src'),
    renames: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).min(1).max(500),
  }),
  describe: () => 'Follow a renamed file',
  async apply(document: ClipDocument, input: ReplaceSrc) {
    const next = clone(document);
    let touched = false;
    walk(next, ({ entity }) => {
      if (entity.src === undefined) return;
      let src = entity.src as AssetInput;
      for (const { from, to } of input.renames) src = renamed(src, from, to);
      if (JSON.stringify(src) !== JSON.stringify(entity.src)) {
        entity.src = src;
        touched = true;
      }
    });
    return touched ? next : document;
  },
};
