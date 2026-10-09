/**
 * Hàng của timeline từ document (spec editor-rewrite B3, checklist TML-01).
 *
 * Luật hàng như fork cho người dùng thấy:
 * - Mỗi con của scene là một hàng; cột đọc từ trên xuống nhưng file đọc từ
 *   dưới lên (con cuối vẽ trên cùng), nên thứ tự hàng là thứ tự file ĐẢO.
 * - Mở một hàng ra: trước là các dòng keyframe của chính nó, rồi thành phần
 *   phụ (fill, stroke, shadow, effect) có keyframe, rồi các con, rồi mask.
 * - Sequence giữ mọi clip của nó trên MỘT hàng; mở ra chỉ hiện những con có
 *   keyframe (để có chỗ cho dòng keyframe của chúng) — trừ hàng cùng làn
 *   (b-roll, phụ đề…), mở ra là thấy mọi clip.
 * - Hàng clip cao theo `clipHeight` (28–116, mặc định 40); dòng keyframe 32.
 */

import type { ClipNode } from "@opencmo/clip-doc";
import type { TimeNode } from "@opencmo/clip-render";
import { laneOf, type Lane } from "@opencmo/editor-core";

type Entity = Record<string, unknown> & { id?: string };

export const CLIP_HEIGHT = { min: 28, max: 116, default: 40 } as const;
export const TRACK_HEIGHT = 32;

export type Row = {
  key: string;
  kind: "clip" | "part" | "track";
  /** Id của phần tử của hàng: node, thành phần phụ, hay track. */
  id: string;
  entity: Entity;
  /** Node sở hữu hàng (với dòng keyframe: node mà keyframe đo theo thời gian của nó). */
  owner: Entity;
  time: TimeNode | null;
  /** Cha của node (id), cho đổi chỗ lớp. Chỉ hàng clip. */
  parentId: string | null;
  depth: number;
  label: string;
  expandable: boolean;
  expanded: boolean;
  height: number;
};

const PARTS: [key: string, label: string][] = [
  ["paints", "Fill"],
  ["strokes", "Stroke"],
  ["shadows", "Shadow"],
  ["effects", "Effect"],
];

const KIND_LABEL: Record<string, string> = {
  video: "Video",
  audio: "Audio",
  image: "Image",
  text: "Text",
  rect: "Rectangle",
  captions: "Captions",
  group: "Group",
  sequence: "Sequence",
  adjustmentLayer: "Adjustment layer",
};

const list = (entity: Entity, key: string): Entity[] => (entity[key] as Entity[] | undefined) ?? [];

export function labelOf(entity: Entity): string {
  if (typeof entity.name === "string" && entity.name.trim()) return entity.name;
  if (entity.kind === "text" && typeof entity.text === "string" && entity.text.trim()) return entity.text.trim().slice(0, 40);
  return KIND_LABEL[entity.kind as string] ?? String(entity.kind ?? "Layer");
}

const titled = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** Có keyframe ở đâu đó trong cây con (của node hay của thành phần phụ của nó). */
export function hasKeyframes(entity: Entity): boolean {
  if (list(entity, "tracks").some((track) => list(track, "keyframes").length > 0)) return true;
  for (const [key] of PARTS) {
    for (const part of list(entity, key)) {
      if (hasKeyframes(part)) return true;
      for (const stop of list(part, "stops")) if (hasKeyframes(stop)) return true;
    }
  }
  return [...list(entity, "children"), ...list(entity, "masks")].some(hasKeyframes);
}

/**
 * Mọi hàng đang thấy, theo thứ tự từ trên xuống. `times` là thời gian đã giải
 * của scene (clip-render `resolveTimes`), tra theo chính object node.
 */
export function buildRows(scene: Entity, times: Map<ClipNode, TimeNode>): Row[] {
  const out: Row[] = [];
  const timeOf = (entity: Entity) => times.get(entity as unknown as ClipNode) ?? null;

  const under = (holder: Entity, owner: Entity, depth: number, sequence: boolean): Row[] => {
    const rows: Row[] = [];
    for (const track of [...list(holder, "tracks")].reverse()) {
      rows.push({
        key: `track:${track.id ?? ""}`,
        kind: "track",
        id: String(track.id ?? ""),
        entity: track,
        owner,
        time: timeOf(owner),
        parentId: null,
        depth,
        label: titled(String(track.property ?? "")),
        expandable: false,
        expanded: false,
        height: TRACK_HEIGHT,
      });
    }
    if (holder === owner) {
      for (const [key, name] of PARTS) {
        for (const part of [...list(holder, key)].reverse()) {
          if (!hasKeyframes(part)) continue;
          const expanded = part.expanded === true;
          const label = key === "effects" ? titled(String(part.type ?? name)) : name;
          const inner = expanded ? under(part, owner, depth + 1, false) : [];
          rows.push({
            key: `part:${part.id ?? ""}`,
            kind: "part",
            id: String(part.id ?? ""),
            entity: part,
            owner,
            time: timeOf(owner),
            parentId: null,
            depth,
            label,
            expandable: true,
            expanded,
            height: TRACK_HEIGHT,
          }, ...inner);
        }
      }
      const kids = [...list(holder, "children")].reverse().filter((child) => !sequence || hasKeyframes(child));
      for (const child of kids) rows.push(...clip(child, holder, depth));
      for (const mask of [...list(holder, "masks")].reverse()) rows.push(...clip(mask, holder, depth));
    }
    return rows;
  };

  const clip = (entity: Entity, parent: Entity, depth: number): Row[] => {
    // Hàng cùng làn (b-roll, phụ đề…: `tracks.ts`) mở ra liệt kê MỌI clip để chọn/kéo
    // từng cái; sequence khác (cắt bằng chữ) vẫn chỉ hiện con có keyframe.
    const sequence = entity.kind === "sequence" && !laneOf(entity);
    const expanded = entity.expanded === true;
    const inner = under(entity, entity, depth + 1, sequence);
    const height = typeof entity.clipHeight === "number"
      ? Math.min(CLIP_HEIGHT.max, Math.max(CLIP_HEIGHT.min, entity.clipHeight))
      : CLIP_HEIGHT.default;
    return [
      {
        key: `clip:${entity.id ?? ""}`,
        kind: "clip",
        id: String(entity.id ?? ""),
        entity,
        owner: entity,
        time: timeOf(entity),
        parentId: String(parent.id ?? ""),
        depth,
        label: labelOf(entity),
        expandable: inner.length > 0,
        expanded: expanded && inner.length > 0,
        height,
      },
      ...(expanded ? inner : []),
    ];
  };

  for (const child of [...list(scene, "children")].reverse()) out.push(...clip(child, scene, 0));
  for (const mask of [...list(scene, "masks")].reverse()) out.push(...clip(mask, scene, 0));
  return out;
}

/** Id của node và mọi con cháu của nó. */
export function subtreeIds(entity: Entity): Set<string> {
  const ids = new Set<string>();
  const visit = (item: Entity) => {
    if (item.id) ids.add(item.id);
    for (const child of [...list(item, "children"), ...list(item, "masks")]) visit(child);
  };
  visit(entity);
  return ids;
}

/**
 * Vai trò của một lớp, nói bằng chữ người không chuyên hiểu (design 06/10):
 * "Captions", "B-roll", "Voiceover" thay vì tên file hay loại node. Chỉ để
 * hiển thị — document vẫn là cây lớp như cũ, không gộp thành track cố định.
 */
export type LayerRole = "video" | "captions" | "broll" | "audio" | "voice" | "text" | "visual" | "group";

export const ROLE_LABEL: Record<LayerRole, string> = {
  video: "Video",
  captions: "Captions",
  broll: "B-roll",
  audio: "Audio",
  voice: "Voiceover",
  text: "Text",
  visual: "Visual",
  group: "Group",
};

const LANE_ROLE: Record<Lane, LayerRole> = { visual: "broll", captions: "captions", audio: "audio", text: "text", graphic: "visual" };

export function roleOf(node: object): LayerRole {
  const entity = node as { kind?: unknown; marks?: unknown };
  const lane = laneOf(node);
  switch (entity.kind) {
    case "video":
      return lane === "visual" ? "broll" : "video";
    case "captions":
      return "captions";
    case "image":
      return "broll";
    case "rect":
      return lane === "visual" ? "broll" : "visual";
    case "audio":
      return (entity.marks as Record<string, unknown> | undefined)?.voiceover ? "voice" : "audio";
    case "text":
      return "text";
    case "sequence":
      return lane ? LANE_ROLE[lane] : "group";
    case "group":
      return "group";
    default:
      return "visual";
  }
}
