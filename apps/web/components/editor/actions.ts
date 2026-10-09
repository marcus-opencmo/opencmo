/**
 * Mọi lệnh của editor có tên (spec editor-rewrite B7): phím tắt, menu dự án và
 * menu chuột phải cùng gọi ở đây, nên một lệnh làm cùng một việc ở mọi lối vào.
 *
 * Lệnh sửa document đi qua op của editor-core (một lượt = một bước Undo); lệnh
 * xem (zoom, tua, công cụ, chọn) chỉ đổi trạng thái của tab.
 *
 * Luật lấy từ hành vi của fork:
 * - Chọn hết: những gì scene chứa trực tiếp, đang hiện ở khung này.
 * - Chọn cha / chọn con: đi xuyên qua sequence (timeline vẽ nó, canvas không chọn nó).
 * - Đưa lên trên / xuống dưới: trong từng cha, giữ thứ tự của các node được chọn.
 * - Ẩn/hiện: ẩn hết nếu có cái đang hiện, không thì hiện lại hết.
 * - Nhích: 1 px (Shift 10 px) tính từ chỗ node ĐANG vẽ; có track x/y thì ghi
 *   keyframe ở playhead, không thì ghi prop.
 * - Tới đầu/cuối timeline: là mép vùng làm việc khi có.
 */

import type { ClipDocument } from "@opencmo/clip-doc";
import type { LayoutBox, Renderer } from "@opencmo/clip-render";
import { activeScene, laneOf, walk, type Entity } from "@opencmo/editor-core";

import type { Playback } from "./playback";
import type { ActionName } from "./shortcuts";

export type Tool = "move" | "hand" | "scene" | "text" | "rect";

const FPS = 30;
const NODE_KINDS = new Set(["rect", "text", "video", "image", "audio", "group", "sequence", "captions", "adjustmentLayer", "scene"]);
const CONTAINERS = new Set(["scene", "group", "sequence"]);

/** Clipboard của tab: cây con đã copy và cha nơi copy (để dán lại không chồng lên chính nó). */
let clipboard: { nodes: Entity[]; from: string | null } | null = null;

export type ActionDeps = {
  document: ClipDocument;
  selection: string[];
  setSelection: (ids: string[]) => void;
  run: (ops: unknown[]) => Promise<ClipDocument | null>;
  undo: () => void;
  redo: () => void;
  playback: Playback;
  renderer: Renderer | null;
  split: () => void;
  exportClip: () => void;
  camera: { zoom: (factor: number) => void; actual: () => void; fit: () => void; fitBox: (box: Box) => void };
  tool: Tool;
  setTool: (tool: Tool) => void;
  back: () => void;
  importFiles: () => void;
};

export type Box = { minX: number; minY: number; maxX: number; maxY: number };

type Place = { entity: Entity; parent: Entity | null; list: Entity[] | null };

function places(document: ClipDocument): Map<string, Place> {
  const map = new Map<string, Place>();
  walk(document, ({ entity, tag, parent, list }) => {
    if (typeof entity.id === "string" && entity.kind === tag && NODE_KINDS.has(tag)) map.set(entity.id, { entity, parent, list });
  });
  return map;
}

/** Id mới xuất hiện ở `after` mà cha của chúng không mới — đỉnh các cây vừa thêm. */
function addedRoots(before: ClipDocument, after: ClipDocument): string[] {
  const old = places(before);
  const out: string[] = [];
  for (const [id, place] of places(after)) {
    if (old.has(id)) continue;
    const parentId = place.parent?.id;
    if (typeof parentId === "string" && !old.has(parentId) && places(after).has(parentId)) continue;
    out.push(id);
  }
  return out;
}

/** Hộp trục của một node trên scene. */
export function boxOf(box: LayoutBox): Box {
  const [ox, oy, w, h] = box.box;
  const m = box.matrix;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [ox, oy],
    [ox + w, oy],
    [ox, oy + h],
    [ox + w, oy + h],
  ] as const) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

export function createActions(deps: ActionDeps): Record<ActionName, () => void> & { enabled: (name: ActionName) => boolean } {
  const { document, selection, setSelection, run, playback, renderer } = deps;
  const scene = activeScene(document) as unknown as Entity;
  const index = places(document);
  const chosen = selection.filter((id) => index.has(id));
  const nodes = chosen.filter((id) => id !== scene.id);
  const layout = () => new Map((renderer?.layout(playback.frame) ?? []).map((box) => [box.node as unknown as Entity, box]));

  const apply = async (ops: unknown[], select?: (after: ClipDocument) => string[]) => {
    const after = await run(ops);
    if (after && select) setSelection(select(after));
  };

  const copy = () => {
    if (!nodes.length) return;
    const roots = nodes.filter((id) => {
      for (let at = index.get(id)?.parent; at; at = typeof at.id === "string" ? index.get(at.id)?.parent : null) {
        if (typeof at.id === "string" && nodes.includes(at.id)) return false;
      }
      return true;
    });
    const from = index.get(roots[0]!)?.parent?.id;
    clipboard = { nodes: roots.map((id) => structuredClone(index.get(id)!.entity)), from: typeof from === "string" ? from : null };
  };
  const remove = () => {
    if (!nodes.length) return;
    void apply(nodes.map((id) => ({ op: "delete_element", element_id: id })), () => []);
  };

  const seek = (frame: number) => playback.seek(frame);
  const nudge = (dx: number, dy: number) => () => {
    if (!nodes.length) return;
    const boxes = layout();
    const ops: unknown[] = [];
    for (const id of nodes) {
      const entity = index.get(id)!.entity;
      const box = boxes.get(entity);
      if (!box || entity.kind === "sequence") continue;
      const tracks = (entity.tracks as Entity[] | undefined) ?? [];
      // Phụ đề không có x/y: vị trí của nó là preset + `verticalAlign` + offset.
      const caption = entity.kind === "captions";
      for (const [axis, delta] of [
        [caption ? "offsetX" : "x", dx],
        [caption ? "offsetY" : "y", dy],
      ] as const) {
        if (!delta) continue;
        const value = Math.round(box.values[axis] + delta);
        if (tracks.some((track) => track.property === axis)) {
          ops.push({ op: "set_keyframe", element_id: id, property: axis, time: box.localFrame / FPS, value });
        } else {
          ops.push({ op: "set_props", element_id: id, props: { [axis]: value || null } });
        }
      }
    }
    if (ops.length) void run(ops);
  };

  const restack = (to: "front" | "back") => () => {
    const byParent = new Map<Entity, string[]>();
    for (const id of nodes) {
      const parent = index.get(id)?.parent;
      if (parent) byParent.set(parent, [...(byParent.get(parent) ?? []), id]);
    }
    const ops: unknown[] = [];
    for (const [parent, ids] of byParent) {
      const siblings = ((parent.children as Entity[] | undefined) ?? []).map((child) => child.id as string);
      const moving = siblings.filter((id) => ids.includes(id));
      const anchor = siblings.find((id) => !ids.includes(id));
      for (const id of moving) {
        if (to === "front") ops.push({ op: "move_layer", element_id: id, parent_id: parent.id });
        else if (anchor) ops.push({ op: "move_layer", element_id: id, parent_id: parent.id, before_id: anchor });
      }
    }
    if (ops.length) void run(ops);
  };

  /** Con nhìn thấy được của một node, xuyên qua sequence. */
  const visibleChildren = (entity: Entity, boxes: Map<Entity, LayoutBox>): string[] =>
    ((entity.children as Entity[] | undefined) ?? []).flatMap((child) => {
      if (child.hidden || !boxes.get(child)?.visible) return [];
      if (child.kind === "sequence") return visibleChildren(child, boxes);
      return typeof child.id === "string" ? [child.id] : [];
    });

  const edgeOfSelection = (edge: "start" | "end") => () => {
    const boxes = [...layout().values()].filter((box) => typeof box.node.id === "string" && nodes.includes(box.node.id));
    if (!boxes.length) return;
    seek(edge === "start" ? Math.min(...boxes.map((box) => box.start)) : Math.max(...boxes.map((box) => box.end)));
  };
  const workarea = (scene.workarea as [number, number] | null | undefined) ?? null;

  /**
   * Nhảy tới điểm cắt trước/sau (học Palmier/NLE: ↑/↓ khi không chọn gì): mép đầu/cuối
   * của mọi lớp đang có — gồm từng đoạn video chính sau cắt chữ, nên đúng chỗ cắt.
   */
  const editPoint = (direction: -1 | 1) => () => {
    const points = new Set<number>();
    for (const box of layout().values()) {
      points.add(box.start);
      points.add(box.end);
    }
    const sorted = [...points].sort((a, b) => a - b);
    const target = direction > 0 ? sorted.find((frame) => frame > playback.frame) : sorted.reverse().find((frame) => frame < playback.frame);
    if (target !== undefined) seek(target);
  };

  const actions: Record<ActionName, () => void> = {
    undo: deps.undo,
    redo: deps.redo,
    delete: remove,
    addMarker: () => void apply([{ op: "set_marker", time: playback.frame / FPS }]),
    rippleDelete: () => nodes.length && void apply(nodes.map((id) => ({ op: "ripple_delete", element_id: id })), () => []),
    duplicate: () => nodes.length && void apply([{ op: "duplicate_elements", element_ids: nodes }], (after) => addedRoots(document, after)),
    copy,
    cut: () => {
      copy();
      remove();
    },
    paste: () => {
      if (!clipboard) return;
      const target = chosen[0] ? index.get(chosen[0]) : null;
      let parentId: string | undefined;
      let beforeId: string | null = null;
      if (target && CONTAINERS.has(target.entity.kind as string)) parentId = target.entity.id as string;
      else if (target?.parent && target.list) {
        parentId = target.parent.id as string;
        const next = target.list[target.list.indexOf(target.entity) + 1];
        beforeId = typeof next?.id === "string" ? next.id : null;
      }
      void apply(
        [{ op: "paste_nodes", ...(parentId ? { parent_id: parentId } : {}), before_id: beforeId, nodes: clipboard.nodes, copied_from: clipboard.from }],
        (after) => addedRoots(document, after),
      );
    },
    selectAll: () => {
      const boxes = layout();
      setSelection(
        ((scene.children as Entity[] | undefined) ?? [])
          .filter((child) => !child.hidden && boxes.get(child)?.visible && typeof child.id === "string")
          .map((child) => child.id as string),
      );
    },
    group: () => nodes.length && void apply([{ op: "group_elements", element_ids: nodes, into: "group", frame: playback.frame }], (after) => addedRoots(document, after)),
    wrapSequence: () => nodes.length && void apply([{ op: "group_elements", element_ids: nodes, into: "sequence", frame: playback.frame }], (after) => addedRoots(document, after)),
    wrapScene: () => nodes.length && void apply([{ op: "group_elements", element_ids: nodes, into: "scene", frame: playback.frame }], (after) => addedRoots(document, after)),
    ungroup: () => {
      const released = nodes.flatMap((id) => {
        const entity = index.get(id)!.entity;
        return entity.kind === "group" || entity.kind === "scene" ? ((entity.children as Entity[] | undefined) ?? []).map((child) => child.id as string) : [];
      });
      if (released.length || nodes.length) void apply([{ op: "ungroup_elements", element_ids: nodes, frame: playback.frame }], () => released);
    },
    // Gom các clip cùng làn đang chọn vào hàng của clip đầu tiên (`move_to_row`).
    oneRow: () => {
      const [target, ...rest] = nodes;
      if (target && rest.length) void apply([{ op: "move_to_row", element_ids: rest, target_id: target }], () => nodes);
    },
    unwrapSequence: () => {
      const released = nodes.flatMap((id) => {
        const entity = index.get(id)!.entity;
        return entity.kind === "sequence" ? ((entity.children as Entity[] | undefined) ?? []).map((child) => child.id as string) : [];
      });
      void apply([{ op: "ungroup_elements", element_ids: nodes, only: "sequence", frame: playback.frame }], () => released);
    },
    split: deps.split,
    toggleHidden: () => {
      const targets = nodes.map((id) => index.get(id)!.entity);
      if (!targets.length) return;
      const hide = targets.some((entity) => !entity.hidden);
      void run(targets.map((entity) => ({ op: "set_props", element_id: entity.id, props: { hidden: hide ? true : null } })));
    },
    zoomIn: () => deps.camera.zoom(1.25),
    zoomOut: () => deps.camera.zoom(1 / 1.25),
    zoomActual: deps.camera.actual,
    zoomFit: deps.camera.fit,
    zoomSelection: () => {
      const boxes = [...layout().values()].filter((box) => typeof box.node.id === "string" && nodes.includes(box.node.id)).map(boxOf);
      if (!boxes.length) return deps.camera.fit();
      deps.camera.fitBox({
        minX: Math.min(...boxes.map((box) => box.minX)),
        minY: Math.min(...boxes.map((box) => box.minY)),
        maxX: Math.max(...boxes.map((box) => box.maxX)),
        maxY: Math.max(...boxes.map((box) => box.maxY)),
      });
    },
    toolMove: () => deps.setTool("move"),
    toolHand: () => deps.setTool("hand"),
    toolScene: () => deps.setTool("scene"),
    toolText: () => deps.setTool("text"),
    toolRect: () => deps.setTool("rect"),
    frameBack: () => seek(playback.frame - 1),
    frameForward: () => seek(playback.frame + 1),
    secondBack: () => seek(playback.frame - FPS),
    secondForward: () => seek(playback.frame + FPS),
    selectionStart: edgeOfSelection("start"),
    selectionEnd: edgeOfSelection("end"),
    timelineStart: () => seek(workarea ? Math.round(workarea[0] * FPS) : 0),
    timelineEnd: () => seek(workarea ? Math.round(workarea[1] * FPS) : (renderer?.end ?? 0)),
    shuttleBack: () => playback.shuttle(-1),
    stop: () => playback.pause(),
    shuttleForward: () => playback.shuttle(1),
    bringFront: restack("front"),
    sendBack: restack("back"),
    selectParent: () => {
      const parents = new Set<string>();
      for (const id of nodes) {
        let parent = index.get(id)?.parent ?? null;
        while (parent && parent.kind === "sequence") parent = typeof parent.id === "string" ? (index.get(parent.id)?.parent ?? null) : null;
        if (parent && typeof parent.id === "string" && NODE_KINDS.has(parent.kind as string)) parents.add(parent.id);
      }
      if (parents.size) setSelection([...parents]);
    },
    selectChildren: () => {
      const boxes = layout();
      const children = chosen.flatMap((id) => visibleChildren(index.get(id)!.entity, boxes));
      if (children.length) setSelection([...new Set(children)]);
    },
    deselect: () => {
      setSelection([]);
      if (deps.tool !== "move" && deps.tool !== "hand") deps.setTool("move");
    },
    nudgeLeft: nudge(-1, 0),
    nudgeRight: nudge(1, 0),
    // Không chọn gì thì ↑/↓ là điểm cắt trước/sau; có chọn thì dời lớp như cũ.
    nudgeUp: () => (nodes.length ? nudge(0, -1)() : editPoint(-1)()),
    nudgeDown: () => (nodes.length ? nudge(0, 1)() : editPoint(1)()),
    nudgeLeftFast: nudge(-10, 0),
    nudgeRightFast: nudge(10, 0),
    nudgeUpFast: nudge(0, -10),
    nudgeDownFast: nudge(0, 10),
    export: deps.exportClip,
    back: deps.back,
    import: deps.importFiles,
  };

  const enabled = (name: ActionName): boolean => {
    switch (name) {
      case "delete":
      case "rippleDelete":
      case "duplicate":
      case "copy":
      case "cut":
      case "group":
      case "wrapScene":
      case "wrapSequence":
      case "toggleHidden":
      case "bringFront":
      case "sendBack":
      case "selectParent":
      case "zoomSelection":
      case "selectionStart":
      case "selectionEnd":
        return nodes.length > 0;
      case "paste":
        return clipboard !== null;
      case "ungroup":
        return nodes.some((id) => ["group", "scene"].includes(index.get(id)!.entity.kind as string));
      case "unwrapSequence":
        return nodes.some((id) => index.get(id)!.entity.kind === "sequence");
      case "oneRow": {
        const lanes = new Set(nodes.map((id) => laneOf(index.get(id)!.entity)));
        return nodes.length > 1 && lanes.size === 1 && !lanes.has(null);
      }
      case "selectChildren":
        return chosen.some((id) => ((index.get(id)!.entity.children as unknown[] | undefined) ?? []).length > 0);
      default:
        return true;
    }
  };

  return Object.assign(actions, { enabled });
}
