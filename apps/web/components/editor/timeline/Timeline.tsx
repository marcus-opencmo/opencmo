"use client";

/**
 * Timeline của shell mới (spec editor-rewrite B3, checklist TML-01…06).
 *
 * Một vùng cuộn duy nhất: cột lớp dính bên trái (`sticky`), thước dính bên
 * trên, hàng clip bên dưới — cuộn dọc thì nhãn và clip đi cùng nhau, không phải
 * đồng bộ hai thanh cuộn.
 *
 * Mọi thao tác kéo là MỘT op của editor-core (`move_elements`, `trim_element`,
 * `move_keyframe`, `set_workarea`, `move_layer`): trong lúc kéo, op chạy lại
 * trên bản gốc của cử chỉ và kết quả chỉ là bản XEM TRƯỚC (canvas + timeline
 * vẽ nó); thả tay mới commit, nên một cú kéo là một bước Undo.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AssetInput, ClipDocument, ClipNode } from "@opencmo/clip-doc";
import { FPS, type TimeNode, type Transcript } from "@opencmo/clip-render";
import { activeScene, applyOps, laneOf, MARKER_COLORS, readMarkers, timelinesOf, timesOf, type Marker, type OpContext } from "@opencmo/editor-core";

import { useThemePref } from "@/components/theme";

import { clock } from "../clock";
import type { BrowserMedia } from "../media";
import type { AiState } from "../generate/useGenerations";
import { beatsOf, drawBeats, drawPeaks, knownBeats, loadPeaks, type Peaks } from "./peaks";
import { buildRows, CLIP_HEIGHT, ROLE_LABEL, roleOf, subtreeIds, type Row } from "./rows";
import { rulerStep, snapDelta, snapFrame, snapTargets } from "./snap";
import { NewTimeline, TimelineTabs } from "./TimelineTabs";

type Entity = Record<string, unknown> & { id?: string };

const LABEL_WIDTH = 232;
const RULER_HEIGHT = 36;
const PAD = 8;
const SNAP_PX = 10;
const HANDLE_PX = 8;
const ZOOM = { min: 0.03, max: 120, initial: 1 / 0.7 };

export type TimelineProps = {
  /** Document đang hiện (bản xem trước khi đang kéo). */
  doc: ClipDocument;
  /** Bản đã commit — gốc của mọi cử chỉ. */
  base: () => ClipDocument;
  media: BrowserMedia;
  /** Đổi khi độ dài/transcript về: thời gian phải giải lại. */
  generation: number;
  frame: number;
  playing: boolean;
  onSeek: (frame: number) => void;
  onToggle: () => void;
  context: () => OpContext;
  run: (ops: unknown[], options?: { history?: boolean }) => Promise<unknown>;
  onPreview: (doc: ClipDocument | null) => void;
  selection: string[];
  onSelect: (ids: string[]) => void;
  solo: string | null;
  onSolo: (id: string | null) => void;
  onSplit: () => void;
  /** Thả asset/file lên timeline: `frame` là chỗ thả. */
  onDropMedia: (event: React.DragEvent, frame: number) => void;
  /** Lớp Assistant vừa đổi — nháy một lúc để người dùng thấy agent làm gì ở đâu. */
  flash?: string[];
  /** Phần tử có nguồn AI đang sinh / đã hỏng: nhãn ngay trên thanh clip (G1). */
  aiState?: (entity: Entity) => AiState | null;
  /** Bấm Retry trên thanh clip hỏng. */
  onRetry?: (entity: Entity) => void;
};

type Gesture =
  | { kind: "move"; ids: string[]; x: number; y: number; edges: number[]; moved: boolean; op: unknown | null; row: string | null }
  | { kind: "trim"; id: string; edge: "in" | "out"; x: number; from: number; moved: boolean; op: unknown | null }
  | { kind: "slip"; id: string; x: number; moved: boolean; op: unknown | null }
  | { kind: "marker"; id: string; x: number; from: number; moved: boolean; op: unknown | null }
  | { kind: "keyframe"; id: string; x: number; frame: number; origin: number; rate: number; moved: boolean; op: unknown | null }
  | { kind: "workarea"; edge: 0 | 1; x: number; range: [number, number]; moved: boolean; op: unknown | null }
  | { kind: "scrub" }
  | { kind: "layer"; id: string; y: number; moved: boolean; drop: Drop | null }
  | { kind: "height"; id: string; y: number; from: number; moved: boolean; height: number };

type Drop = { parent: string; before: string | null; line: number | null; into: string | null; depth: number };

const BAR_CLASS: Record<string, string> = {
  video: "ed2-bar-video",
  audio: "ed2-bar-audio",
  captions: "ed2-bar-captions",
  text: "ed2-bar-text",
  image: "ed2-bar-image",
  rect: "ed2-bar-shape",
  group: "ed2-bar-group",
  adjustmentLayer: "ed2-bar-group",
};

export function Timeline(props: TimelineProps) {
  const { doc, media, generation, frame } = props;
  const [ppf, setPpf] = useState(ZOOM.initial);
  const scroller = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  // Snap mặc định bật; tắt khi muốn đặt clip lệch vài khung so với mép khác.
  const [snap, setSnap] = useState(true);
  const snapOn = useRef(snap);
  snapOn.current = snap;
  const [drop, setDrop] = useState<Drop | null>(null);
  /** Hàng đích khi kéo bar lên/xuống: id hàng, hay `scene` = ra một hàng riêng. */
  const [rowTarget, setRowTarget] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftHeight, setDraftHeight] = useState<{ id: string; height: number } | null>(null);
  // Marker (học Palmier §B6): đọc từ marks của scene; bấm một cái mở ô sửa.
  const markers = useMemo(() => readMarkers(doc), [doc]);
  const [markerOpen, setMarkerOpen] = useState<string | null>(null);
  const openMarker = markers.find((marker) => marker.id === markerOpen) ?? null;

  // `generation` đổi khi độ dài nguồn/transcript về: thời gian phải giải lại.
  const times = useMemo(
    () => timesOf(doc, { media }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, media, generation],
  );
  const scene = useMemo(() => activeScene(doc) as unknown as Entity, [doc]);
  const sceneTime = times.get(scene as unknown as ClipNode);
  const rows = useMemo(() => buildRows(scene, times), [scene, times]);
  const byId = useMemo(() => {
    const map = new Map<string, Entity>();
    const visit = (entity: Entity) => {
      if (entity.id) map.set(entity.id, entity);
      for (const key of ["children", "masks"]) for (const child of (entity[key] as Entity[] | undefined) ?? []) visit(child);
    };
    visit(scene);
    return map;
  }, [scene]);

  const workarea = (scene.workarea as [number, number] | null | undefined) ?? null;
  const end = Math.max(sceneTime?.end ?? 0, workarea ? Math.round(workarea[1] * FPS) : 0);
  const contentWidth = PAD * 2 + (end + 5 * FPS) * ppf;
  const x = useCallback((f: number) => PAD + f * ppf, [ppf]);
  const frameAt = useCallback(
    (clientX: number) => {
      const box = scroller.current!.getBoundingClientRect();
      return Math.max(0, Math.round((clientX - box.left - LABEL_WIDTH + scroller.current!.scrollLeft - PAD) / ppf));
    },
    [ppf],
  );

  // Zoom quanh con trỏ: giây dưới con trỏ đứng yên.
  const zoomTo = useCallback(
    (next: number, anchorClientX?: number) => {
      const element = scroller.current;
      const clamped = Math.min(ZOOM.max, Math.max(ZOOM.min, next));
      if (!element) return setPpf(clamped);
      const box = element.getBoundingClientRect();
      const px = (anchorClientX ?? box.left + LABEL_WIDTH + (box.width - LABEL_WIDTH) / 2) - box.left - LABEL_WIDTH;
      const at = (px + element.scrollLeft - PAD) / ppf;
      setPpf(clamped);
      requestAnimationFrame(() => {
        element.scrollLeft = Math.max(0, PAD + at * clamped - px);
      });
    },
    [ppf],
  );
  // Không đi qua `zoomTo`: rAF của nó neo theo giây giữa khung và ghi đè scrollLeft = 0,
  // nên mở editor (và bấm Fit) từng thấy timeline lệch vài giây.
  const fit = useCallback(() => {
    const element = scroller.current;
    if (!element || !end) return;
    setPpf(Math.min(ZOOM.max, Math.max(ZOOM.min, (element.clientWidth - LABEL_WIDTH - PAD * 4) / end)));
    requestAnimationFrame(() => {
      element.scrollLeft = 0;
    });
  }, [end]);
  // Vừa khung một lần khi đã biết độ dài scene.
  const fitted = useRef(false);
  useEffect(() => {
    if (!fitted.current && end > 0 && scroller.current) {
      fitted.current = true;
      fit();
    }
  }, [end, fit]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomTo(ppf * Math.exp(-Math.max(-50, Math.min(50, event.deltaY)) * 0.01), event.clientX);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [ppf, zoomTo]);

  // ------------------------------------------------------------ cử chỉ

  const preview = useCallback(
    async (op: unknown) => {
      try {
        const applied = await applyOps(props.base(), [op], props.context());
        props.onPreview(applied.document);
      } catch {
        // Bước trung gian không hợp lệ (vd kéo qua mép): giữ bản xem trước cũ.
      }
    },
    [props],
  );

  const targets = useCallback(
    (moving: Entity[]) => {
      const extra = [0, props.frame];
      if (workarea) extra.push(Math.round(workarea[0] * FPS), Math.round(workarea[1] * FPS));
      const committed = timesOf(props.base(), { media });
      const nodes = new Set<ClipNode>();
      const baseScene = activeScene(props.base()) as unknown as Entity;
      const lookup = (id: string): Entity | null => {
        let found: Entity | null = null;
        const visit = (entity: Entity) => {
          if (entity.id === id) found = entity;
          for (const key of ["children", "masks"]) for (const child of (entity[key] as Entity[] | undefined) ?? []) visit(child);
        };
        visit(baseScene);
        return found;
      };
      for (const entity of moving) {
        const found = entity.id ? lookup(entity.id) : null;
        if (found) nodes.add(found as unknown as ClipNode);
      }
      // Beat của nhạc không đang bị kéo (học Palmier §B7), theo frame của timeline.
      for (const [node, t] of committed) {
        if (node.kind !== "audio" || nodes.has(node)) continue;
        const src = (node as { src?: AssetInput }).src;
        if (src === undefined) continue;
        for (const beat of knownBeats(typeof src === "string" ? src : JSON.stringify(src))) {
          const frame = Math.round(t.origin + (beat * FPS) / t.rate);
          if (frame >= t.start && frame <= t.end) extra.push(frame);
        }
      }
      return { list: snapTargets(committed, nodes, extra), committed, lookup };
    },
    [media, props, workarea],
  );

  const onMove = useCallback(
    (event: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      if (g.kind === "scrub") return props.onSeek(frameAt(event.clientX));
      if (g.kind === "layer" || g.kind === "height") {
        const dy = event.clientY - g.y;
        if (!g.moved && Math.abs(dy) < 4) return;
        g.moved = true;
        if (g.kind === "height") {
          g.height = Math.min(CLIP_HEIGHT.max, Math.max(CLIP_HEIGHT.min, Math.round(g.from + dy)));
          setDraftHeight({ id: g.id, height: g.height });
        } else {
          g.drop = dropAt(event.clientY);
          setDrop(g.drop);
        }
        return;
      }
      const dx = event.clientX - g.x;
      const dy = g.kind === "move" ? event.clientY - g.y : 0;
      if (!g.moved && Math.abs(dx) < 4 && Math.abs(dy) < 8) return;
      g.moved = true;
      const frames = Math.round(dx / ppf);
      // Snap tắt: ngưỡng 0, chỉ dính khi trùng đúng khung.
      const threshold = snapOn.current ? SNAP_PX / ppf : 0;
      if (g.kind === "move") {
        const { list } = targets(g.ids.map((id) => byId.get(id)).filter(Boolean) as Entity[]);
        const snap = snapDelta(g.edges, frames, list, threshold);
        setSnapAt(snap?.at ?? null);
        g.op = { op: "move_elements", element_ids: g.ids, by: (snap?.delta ?? frames) / FPS };
        g.row = rowFor(g.ids, event.clientY);
        setRowTarget(g.row);
      } else if (g.kind === "trim") {
        const entity = byId.get(g.id);
        const { list } = targets(entity ? [entity] : []);
        const wanted = g.from + frames;
        const snapped = snapFrame(wanted, list, threshold);
        setSnapAt(snapped);
        g.op = { op: "trim_element", element_id: g.id, edge: g.edge, at: Math.max(0, snapped ?? wanted) / FPS };
      } else if (g.kind === "marker") {
        const wanted = Math.max(0, g.from + frames);
        const snapped = snapFrame(wanted, [props.frame], threshold);
        setSnapAt(snapped);
        g.op = { op: "set_marker", marker_id: g.id, time: (snapped ?? wanted) / FPS };
      } else if (g.kind === "slip") {
        // Kéo phải = footage trước đó lùi vào khung (như slip của NLE): cửa sổ nguồn lùi.
        g.op = { op: "slip_element", element_id: g.id, by: -frames / FPS };
      } else if (g.kind === "keyframe") {
        const wanted = g.frame + frames;
        const snapped = snapFrame(wanted, [props.frame], threshold);
        setSnapAt(snapped);
        const scene = snapped ?? wanted;
        g.op = { op: "move_keyframe", keyframe_id: g.id, time: ((scene - g.origin) * g.rate) / FPS };
      } else if (g.kind === "workarea") {
        const range: [number, number] = [...g.range];
        range[g.edge] = Math.max(0, g.range[g.edge] + frames);
        if (range[1] - range[0] < 1) return;
        g.op = { op: "set_workarea", start: range[0] / FPS, end: range[1] / FPS };
      }
      if (g.op) void preview(g.op);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byId, frameAt, ppf, preview, props, targets],
  );

  const onUp = useCallback(async () => {
    const g = gesture.current;
    gesture.current = null;
    setSnapAt(null);
    setDrop(null);
    setRowTarget(null);
    if (!g) return;
    if (g.kind === "layer") {
      if (g.moved && g.drop) {
        await props.run([{ op: "move_layer", element_id: g.id, parent_id: g.drop.parent, before_id: g.drop.before }]);
      }
      return;
    }
    if (g.kind === "height") {
      setDraftHeight(null);
      if (g.moved) {
        await props.run([{ op: "update_element", element_id: g.id, props: { clipHeight: g.height } }], { history: false });
      }
      return;
    }
    if (g.kind === "scrub") return;
    // Bấm vào keyframe mà không kéo là chọn nó: inspector mở phần nội suy.
    if (g.kind === "keyframe" && !g.moved) return props.onSelect([g.id]);
    if (g.kind === "marker" && !g.moved) return setMarkerOpen(g.id);
    props.onPreview(null);
    if (g.kind === "move" && g.moved && g.row) {
      // Dời giờ trước, rồi sang hàng mới: hàng đích dàn chỗ theo giờ đã dời (`move_to_row`).
      const by = (g.op as { by?: number } | null)?.by ?? 0;
      const ops: unknown[] = by ? [g.op] : [];
      ops.push({ op: "move_to_row", element_ids: g.ids, target_id: g.row === "scene" ? String(scene.id) : g.row });
      await props.run(ops);
      return;
    }
    if (g.moved && g.op) await props.run([g.op]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props]);

  // Listener gắn vào window sống qua nhiều lượt render (bản xem trước vẽ lại
  // timeline mỗi bước kéo): nó gọi bản MỚI NHẤT của hai hàm qua ref, và gỡ
  // đúng chính nó khi thả tay.
  const moveRef = useRef(onMove);
  moveRef.current = onMove;
  const upRef = useRef(onUp);
  upRef.current = onUp;
  const begin = (next: Gesture, event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    gesture.current = next;
    const move = (pointer: PointerEvent) => moveRef.current(pointer);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      void upRef.current();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ------------------------------------------------------------ vị trí hàng

  const rowTops = useMemo(() => {
    const tops: number[] = [];
    let top = 0;
    for (const row of rows) {
      tops.push(top);
      top += draftHeight?.id === row.id && row.kind === "clip" ? draftHeight.height : row.height;
    }
    return { tops, total: top };
  }, [rows, draftHeight]);

  /**
   * Hàng đích khi kéo bar theo chiều dọc (UAT 09/10: b-roll phải xếp chung hàng
   * được): hàng clip cùng làn dưới con trỏ (không phải hàng đang chứa nó), hay
   * `scene` khi thả xuống dưới mọi hàng để clip trong một hàng ra hàng riêng.
   */
  function rowFor(ids: string[], clientY: number): string | null {
    const element = scroller.current;
    const entities = ids.map((id) => byId.get(id)).filter(Boolean) as Entity[];
    if (!element || !entities.length) return null;
    const lane = laneOf(entities[0]!);
    if (!lane || entities.some((entity) => laneOf(entity) !== lane)) return null;
    const y = clientY - element.getBoundingClientRect().top + element.scrollTop - RULER_HEIGHT;
    const homes = new Set(entities.map((entity) => (rows.find((row) => row.kind === "clip" && (row.entity === entity || ((row.entity.children as Entity[] | undefined) ?? []).includes(entity)))?.id) ?? ""));
    if (y >= rowTops.total) {
      // Ra hàng riêng chỉ có nghĩa khi clip đang nằm trong một hàng chung.
      return entities.some((entity) => rows.some((row) => row.kind === "clip" && row.entity.kind === "sequence" && ((row.entity.children as Entity[] | undefined) ?? []).includes(entity)))
        ? "scene"
        : null;
    }
    const index = rows.findIndex((row, i) => y >= rowTops.tops[i]! && y < rowTops.tops[i]! + row.height);
    const row = rows[index];
    if (!row || row.kind !== "clip" || homes.has(row.id) || row.depth > 0) return null;
    return laneOf(row.entity) === lane ? row.id : null;
  }

  /**
   * Chỗ thả một lớp theo luật Figma-style của fork: hàng container chia ba —
   * hai dải mép là "cạnh nó", giữa là "vào trong nó"; hàng thường chia đôi ở
   * giữa. Cột đọc trên xuống còn file dưới lên, nên "trên hàng R" là SAU R
   * trong file.
   */
  function dropAt(clientY: number): Drop | null {
    const element = scroller.current;
    if (!element) return null;
    const y = clientY - element.getBoundingClientRect().top + element.scrollTop - RULER_HEIGHT;
    let index = rows.findIndex((row, i) => y >= rowTops.tops[i]! && y < rowTops.tops[i]! + row.height);
    if (index < 0) index = y < 0 ? 0 : rows.length - 1;
    while (index > 0 && rows[index]!.kind !== "clip") index--;
    const row = rows[index];
    if (!row || row.kind !== "clip" || !row.parentId) return null;
    const top = rowTops.tops[index]!;
    const within = (y - top) / row.height;
    const container = row.entity.kind === "group" || row.entity.kind === "sequence";
    if (container && within > 0.25 && within < 0.75) {
      return { parent: row.id, before: null, line: null, into: row.id, depth: row.depth };
    }
    const parent = byId.get(row.parentId) ?? scene;
    const siblings = (parent.children as Entity[] | undefined) ?? [];
    const at = siblings.findIndex((sibling) => sibling.id === row.id);
    if (within < 0.5) {
      const after = siblings[at + 1];
      return { parent: row.parentId, before: after?.id ?? null, line: top, into: null, depth: row.depth };
    }
    return { parent: row.parentId, before: row.id, line: top + row.height, into: null, depth: row.depth };
  }

  // ------------------------------------------------------------ lệnh trên hàng

  const toggle = (row: Row, prop: "hidden" | "muted" | "expanded") =>
    void props.run(
      [{ op: "update_element", element_id: row.id, props: { [prop]: !(row.entity[prop] === true) } }],
      { history: prop !== "expanded" },
    );

  const select = (id: string, event: React.PointerEvent | React.MouseEvent) => {
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      props.onSelect(props.selection.includes(id) ? props.selection.filter((item) => item !== id) : [...props.selection, id]);
    } else if (!props.selection.includes(id)) {
      props.onSelect([id]);
    }
  };

  const startMove = (id: string, event: React.PointerEvent) => {
    select(id, event);
    const ids = props.selection.includes(id) && !(event.shiftKey || event.metaKey || event.ctrlKey) ? props.selection : [id];
    // Con của một clip cũng đang chọn đi theo cha của nó: dời hai lần là sai.
    const covered = new Set<string>();
    for (const other of ids) {
      const entity = byId.get(other);
      if (entity) for (const inner of subtreeIds(entity)) if (inner !== other) covered.add(inner);
    }
    const moving = ids.filter((item) => !covered.has(item));
    const edges = moving.flatMap((item) => {
      const t = byId.get(item) ? times.get(byId.get(item) as unknown as ClipNode) : undefined;
      return t ? [t.start, t.end] : [];
    });
    begin({ kind: "move", ids: moving, x: event.clientX, y: event.clientY, edges, moved: false, op: null, row: null }, event);
  };

  const onBarDown = (entity: Entity, t: TimeNode, event: React.PointerEvent) => {
    if (event.button !== 0 || !entity.id) return;
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const local = event.clientX - box.left;
    const trimmable = entity.kind !== "sequence";
    if (trimmable && local <= HANDLE_PX && box.width > HANDLE_PX * 3) {
      select(entity.id, event);
      return begin({ kind: "trim", id: entity.id, edge: "in", x: event.clientX, from: t.start, moved: false, op: null }, event);
    }
    if (trimmable && local >= box.width - HANDLE_PX && box.width > HANDLE_PX * 3) {
      select(entity.id, event);
      return begin({ kind: "trim", id: entity.id, edge: "out", x: event.clientX, from: t.end, moved: false, op: null }, event);
    }
    // Alt+kéo thân clip có nguồn (học Palmier §B5): slip — đổi đoạn footage, giữ chỗ trên timeline.
    if (event.altKey && (entity.kind === "video" || entity.kind === "audio") && entity.src !== "assets/master.mp4") {
      select(entity.id, event);
      return begin({ kind: "slip", id: entity.id, x: event.clientX, moved: false, op: null }, event);
    }
    startMove(entity.id, event);
  };

  // ------------------------------------------------------------ vẽ

  const ticks = useMemo(() => {
    const step = rulerStep(ppf);
    const out: { frame: number; major: boolean }[] = [];
    const minor = step / 5;
    const limit = (contentWidth - PAD) / ppf;
    for (let f = 0; f <= limit; f += minor >= 1 ? minor : step) {
      const rounded = Math.round(f);
      out.push({ frame: rounded, major: rounded % step === 0 });
    }
    return out;
  }, [ppf, contentWidth]);

  const range: [number, number] = workarea
    ? [Math.round(workarea[0] * FPS), Math.round(workarea[1] * FPS)]
    : [0, sceneTime?.end ?? 0];

  return (
    <section className="ed2-tl" data-testid="timeline" style={timelinesOf(doc).length > 1 ? { gridTemplateRows: "40px 32px minmax(0, 1fr)" } : undefined}>
      <div className="ed2-tl-head">
        <button
          type="button"
          className="ed2-icon"
          data-testid="play-toggle"
          aria-label={props.playing ? "Pause" : "Play"}
          title={props.playing ? "Pause (Space)" : "Play (Space)"}
          onClick={props.onToggle}
        >
          {props.playing ? "❚❚" : "▶"}
        </button>
        <span className="ed2-time" data-testid="playhead-time">
          {clock(frame)} / {clock(sceneTime?.end ?? 0)}
        </span>
        <button type="button" className="ed2-btn" data-testid="split" title="Split at playhead (Ctrl+B)" onClick={props.onSplit}>
          Split
        </button>
        <button
          type="button"
          className="ed2-btn ed2-snap"
          data-testid="timeline-snap"
          aria-pressed={snap}
          title="Snap clips to edges, markers and the playhead"
          onClick={() => setSnap((on) => !on)}
        >
          Snap
        </button>
        <NewTimeline doc={doc} run={(ops) => props.run(ops)} />
        <span className="ed2-grow" />
        <button type="button" className="ed2-icon" aria-label="Zoom out timeline" onClick={() => zoomTo(ppf / 1.5)}>
          −
        </button>
        <input
          type="range"
          className="ed2-zoom-slider"
          aria-label="Timeline zoom"
          data-testid="timeline-zoom"
          min={Math.log(ZOOM.min)}
          max={Math.log(ZOOM.max)}
          step={0.01}
          value={Math.log(ppf)}
          onChange={(event) => zoomTo(Math.exp(Number(event.target.value)))}
        />
        <button type="button" className="ed2-icon" aria-label="Zoom in timeline" onClick={() => zoomTo(ppf * 1.5)}>
          +
        </button>
        <button type="button" className="ed2-btn" data-testid="timeline-fit" onClick={fit}>
          Fit
        </button>
      </div>

      <TimelineTabs doc={doc} run={(ops) => props.run(ops)} />
      <div
        ref={scroller}
        className="ed2-tl-scroll"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) props.onSelect([]);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onDropMedia(event, frameAt(event.clientX));
        }}
      >
        <div style={{ width: LABEL_WIDTH + contentWidth, position: "relative" }}>
          {/* Thước: tua, vùng làm việc. */}
          <div className="ed2-tl-rulerrow" style={{ height: RULER_HEIGHT }}>
            <div className="ed2-tl-corner" style={{ width: LABEL_WIDTH }} />
            <div
              className="ed2-tl-ruler"
              data-testid="timeline-ruler"
              style={{ width: contentWidth }}
              onPointerDown={(event) => {
                props.onSeek(frameAt(event.clientX));
                begin({ kind: "scrub" }, event);
              }}
            >
              {ticks.map((tick) => (
                <div
                  key={tick.frame}
                  className={tick.major ? "ed2-tick ed2-tick-major" : "ed2-tick"}
                  style={{ left: x(tick.frame) }}
                >
                  {tick.major ? <span>{rulerLabel(tick.frame)}</span> : null}
                </div>
              ))}
              <div
                className={workarea ? "ed2-workarea is-set" : "ed2-workarea"}
                data-testid="workarea"
                style={{ left: x(range[0]), width: Math.max(0, (range[1] - range[0]) * ppf) }}
              >
                {([0, 1] as const).map((edge) => (
                  <span
                    key={edge}
                    className={edge === 0 ? "ed2-workarea-handle is-start" : "ed2-workarea-handle is-end"}
                    data-testid={edge === 0 ? "workarea-start" : "workarea-end"}
                    onPointerDown={(event) =>
                      begin({ kind: "workarea", edge, x: event.clientX, range, moved: false, op: null }, event)
                    }
                  />
                ))}
              </div>
              {markers.map((marker) => (
                <div
                  key={marker.id}
                  className={`ed2-marker is-${marker.color}${marker.status === "resolved" ? " is-resolved" : ""}${markerOpen === marker.id ? " is-open" : ""}`}
                  data-testid={`marker-${marker.id}`}
                  title={marker.comment ? `${marker.name}: ${marker.comment}` : marker.name}
                  style={{ left: x(Math.round(marker.time * FPS)), width: marker.duration > 0 ? Math.max(6, marker.duration * FPS * ppf) : undefined }}
                  onPointerDown={(event) =>
                    begin({ kind: "marker", id: marker.id, x: event.clientX, from: Math.round(marker.time * FPS), moved: false, op: null }, event)
                  }
                />
              ))}
            </div>
          </div>
          {openMarker ? (
            <MarkerEditor
              key={openMarker.id}
              marker={openMarker}
              left={Math.max(0, x(Math.round(openMarker.time * FPS)) - 8)}
              onClose={() => setMarkerOpen(null)}
              onChange={(patch) => void props.run([{ op: "set_marker", marker_id: openMarker.id, ...patch }])}
              onDelete={() => {
                setMarkerOpen(null);
                void props.run([{ op: "delete_marker", marker_id: openMarker.id }]);
              }}
            />
          ) : null}

          {/* Hàng. */}
          <div style={{ position: "relative", height: rowTops.total }}>
            {rows.map((row, index) => {
              const height = draftHeight?.id === row.id && row.kind === "clip" ? draftHeight.height : row.height;
              return (
                <div
                  key={row.key}
                  className={`ed2-tl-row is-${row.kind}${rowTarget === row.id ? " is-row-target" : ""}`}
                  data-testid={row.kind === "clip" ? `row-${row.id}` : undefined}
                  style={{ top: rowTops.tops[index], height }}
                >
                  <LayerCell
                    row={row}
                    solo={props.solo}
                    renaming={renaming === row.id}
                    onRename={(name) => {
                      setRenaming(null);
                      if (name !== null && name.trim() && name !== row.entity.name) {
                        void props.run([{ op: "update_element", element_id: row.id, props: { name: name.trim() } }]);
                      }
                    }}
                    onStartRename={() => row.kind === "clip" && setRenaming(row.id)}
                    onToggle={(prop) => toggle(row, prop)}
                    onSolo={() => props.onSolo(props.solo === row.id ? null : row.id)}
                    onPress={(event) => {
                      if (row.kind !== "clip") return;
                      select(row.id, event);
                      begin({ kind: "layer", id: row.id, y: event.clientY, moved: false, drop: null }, event);
                    }}
                    onResize={(event) =>
                      begin({ kind: "height", id: row.id, y: event.clientY, from: row.height, moved: false, height: row.height }, event)
                    }
                    selected={props.selection.includes(row.id)}
                  />
                  <div className="ed2-tl-lane" style={{ width: contentWidth }}>
                    <Lane
                      row={row}
                      times={times}
                      media={media}
                      ppf={ppf}
                      x={x}
                      height={height}
                      selection={props.selection}
                      flash={props.flash ?? NO_FLASH}
                      aiState={props.aiState}
                      onRetry={props.onRetry}
                      onBarDown={onBarDown}
                      onKeyframeDown={(keyframe, event) => {
                        const t = row.time;
                        if (!t || !keyframe.id) return;
                        const at = t.origin + (Number(keyframe.time) * FPS) / t.rate;
                        begin(
                          { kind: "keyframe", id: keyframe.id, x: event.clientX, frame: Math.round(at), origin: t.origin, rate: t.rate, moved: false, op: null },
                          event,
                        );
                      }}
                    />
                  </div>
                </div>
              );
            })}
            {rowTarget === "scene" ? (
              <div className="ed2-row-new" style={{ top: rowTops.total }}>
                New row
              </div>
            ) : null}
            {drop ? (
              drop.into ? (
                <div
                  className="ed2-drop-into"
                  style={{ top: rowTops.tops[rows.findIndex((row) => row.id === drop.into && row.kind === "clip")] ?? 0, height: rows.find((row) => row.id === drop.into)?.height ?? 0, width: LABEL_WIDTH }}
                />
              ) : (
                <div className="ed2-drop-line" style={{ top: drop.line ?? 0, left: 12 + drop.depth * 14, width: LABEL_WIDTH - 12 - drop.depth * 14 }} />
              )
            ) : null}
          </div>

          {/* Playhead và đường gióng. */}
          <div className="ed2-playhead" data-testid="timeline-playhead" style={{ left: LABEL_WIDTH + x(frame) }} />
          {snapAt !== null ? <div className="ed2-snapline" style={{ left: LABEL_WIDTH + x(snapAt) }} /> : null}
        </div>
      </div>
    </section>
  );
}

function rulerLabel(frame: number): string {
  const total = frame / FPS;
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  const rest = frame % FPS;
  return rest ? `${minutes}:${String(seconds).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ cột lớp

function LayerCell({
  row,
  solo,
  renaming,
  selected,
  onRename,
  onStartRename,
  onToggle,
  onSolo,
  onPress,
  onResize,
}: {
  row: Row;
  solo: string | null;
  renaming: boolean;
  selected: boolean;
  onRename: (name: string | null) => void;
  onStartRename: () => void;
  onToggle: (prop: "hidden" | "muted" | "expanded") => void;
  onSolo: () => void;
  onPress: (event: React.PointerEvent) => void;
  onResize: (event: React.PointerEvent) => void;
}) {
  // Mute/solo trên thứ có tiếng hoặc chứa thứ có tiếng; `muted` của cha tắt
  // cả cây con (clip-render `audio.ts`).
  const audible = ["video", "audio", "group", "sequence"].includes(row.entity.kind as string);
  const mutable = audible;
  return (
    <div
      className={selected ? "ed2-tl-label is-selected" : "ed2-tl-label"}
      style={{ width: LABEL_WIDTH, paddingLeft: 8 + row.depth * 14 }}
      onPointerDown={onPress}
      data-testid={row.kind === "clip" ? `layer-${row.id}` : undefined}
    >
      {row.expandable ? (
        <button
          type="button"
          className="ed2-chevron"
          aria-label={row.expanded ? "Collapse" : "Expand"}
          aria-expanded={row.expanded}
          data-testid={`expand-${row.id}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onToggle("expanded")}
        >
          {row.expanded ? "▾" : "▸"}
        </button>
      ) : (
        <span className="ed2-chevron" />
      )}
      {renaming ? (
        <input
          className="ed2-rename"
          autoFocus
          defaultValue={row.label}
          aria-label="Layer name"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") onRename((event.target as HTMLInputElement).value);
            if (event.key === "Escape") onRename(null);
          }}
          onBlur={(event) => onRename(event.target.value)}
        />
      ) : (
        <span className={row.kind === "clip" ? "ed2-tl-name" : "ed2-tl-name ed2-muted"} onDoubleClick={onStartRename} title={row.label}>
          {row.kind === "clip" && row.depth === 0 ? (
            <span className="ed2-role" data-role={roleOf(row.entity)}>
              <i aria-hidden />
              {ROLE_LABEL[roleOf(row.entity)]}
            </span>
          ) : null}
          {row.label}
        </span>
      )}
      {row.kind === "clip" ? (
        <span className="ed2-tl-toggles" onPointerDown={(event) => event.stopPropagation()}>
          {mutable ? (
            <button
              type="button"
              className="ed2-toggle"
              aria-pressed={row.entity.muted === true}
              aria-label={row.entity.muted === true ? "Unmute" : "Mute"}
              data-testid={`mute-${row.id}`}
              onClick={() => onToggle("muted")}
            >
              M
            </button>
          ) : null}
          {audible ? (
            <>
              <button
                type="button"
                className="ed2-toggle"
                aria-pressed={solo === row.id}
                aria-label="Solo"
                data-testid={`solo-${row.id}`}
                onClick={onSolo}
              >
                S
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="ed2-toggle"
            aria-pressed={row.entity.hidden === true}
            aria-label={row.entity.hidden === true ? "Show" : "Hide"}
            data-testid={`hide-${row.id}`}
            onClick={() => onToggle("hidden")}
          >
            {row.entity.hidden === true ? "◌" : "◉"}
          </button>
        </span>
      ) : null}
      {row.kind === "clip" ? <span className="ed2-row-resize" onPointerDown={onResize} aria-hidden /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ làn clip

const NO_FLASH: string[] = [];

function Lane({
  row,
  times,
  media,
  ppf,
  x,
  height,
  selection,
  flash,
  aiState,
  onRetry,
  onBarDown,
  onKeyframeDown,
}: {
  row: Row;
  times: Map<ClipNode, TimeNode>;
  media: BrowserMedia;
  ppf: number;
  x: (frame: number) => number;
  height: number;
  selection: string[];
  flash: string[];
  aiState?: (entity: Entity) => AiState | null;
  onRetry?: (entity: Entity) => void;
  onBarDown: (entity: Entity, t: TimeNode, event: React.PointerEvent) => void;
  onKeyframeDown: (keyframe: Entity, event: React.PointerEvent) => void;
}) {
  if (row.kind === "track") {
    const t = row.time;
    if (!t) return null;
    const keyframes = ((row.entity.keyframes as Entity[] | undefined) ?? []).filter((keyframe) => keyframe.id);
    return (
      <>
        {keyframes.map((keyframe) => (
          <span
            key={keyframe.id}
            className={selection.includes(String(keyframe.id)) ? "ed2-keyframe is-selected" : "ed2-keyframe"}
            data-testid={`keyframe-${keyframe.id}`}
            title={`${row.label} · ${String(keyframe.value)}`}
            style={{ left: x(t.origin + (Number(keyframe.time) * FPS) / t.rate) }}
            onPointerDown={(event) => onKeyframeDown(keyframe, event)}
          />
        ))}
      </>
    );
  }
  if (row.kind !== "clip" || !row.time) return null;
  // Sequence giữ mọi clip trên một hàng.
  const bars: TimeNode[] = row.entity.kind === "sequence" ? row.time.children : [row.time];
  return (
    <>
      {bars.map((t) => (
        <Bar
          key={String((t.node as Entity).id ?? "")}
          t={t}
          media={media}
          ppf={ppf}
          x={x}
          height={height}
          selected={selection.includes(String((t.node as Entity).id ?? ""))}
          flashed={flash.includes(String((t.node as Entity).id ?? ""))}
          ai={aiState?.(t.node as unknown as Entity) ?? null}
          onRetry={onRetry}
          onDown={onBarDown}
        />
      ))}
    </>
  );
}

function Bar({
  t,
  media,
  ppf,
  x,
  height,
  selected,
  flashed,
  ai,
  onRetry,
  onDown,
}: {
  t: TimeNode;
  media: BrowserMedia;
  ppf: number;
  x: (frame: number) => number;
  height: number;
  selected: boolean;
  flashed: boolean;
  ai: AiState | null;
  onRetry?: (entity: Entity) => void;
  onDown: (entity: Entity, t: TimeNode, event: React.PointerEvent) => void;
}) {
  const entity = t.node as unknown as Entity;
  const width = Math.max(2, (t.end - t.start) * ppf);
  const kind = entity.kind as string;
  const src = (kind === "video" || kind === "audio") && !entity.muted ? (entity.src as AssetInput | undefined) : undefined;
  // B-roll (rect tô bằng video/ảnh thư viện) có màu riêng, không lẫn với chữ/hình vẽ.
  const barClass = kind !== "captions" && laneOf(entity) === "visual" && kind !== "video" ? "ed2-bar-broll" : (BAR_CLASS[kind] ?? "ed2-bar-group");
  const label = kind === "captions" ? String(entity.name ?? "Captions") : String(entity.name ?? kind);
  const slip = src !== undefined && entity.src !== "assets/master.mp4";
  return (
    <div
      className={`ed2-bar ${barClass}${selected ? " is-selected" : ""}${flashed ? " is-agent-touched" : ""}${entity.hidden ? " is-hidden" : ""}${ai ? ` is-ai-${ai.state}` : ""}`}
      data-testid={`clip-${entity.id ?? ""}`}
      data-start={t.start}
      data-end={t.end}
      style={{ left: x(t.start), width, height: height - 6 }}
      title={slip ? `${label} · Alt-drag to slip the footage inside this clip` : `${label} · Drag up or down to move it to another row`}
      onPointerDown={(event) => onDown(entity, t, event)}
    >
      {src !== undefined ? <Wave src={src} t={t} media={media} width={width} height={height - 6} /> : null}
      {kind === "captions" && typeof entity.src === "string" ? (
        <Words transcript={media.transcript(entity.src)} t={t} ppf={ppf} />
      ) : null}
      <FadeShades entity={entity} ppf={ppf} width={width} />
      <span className="ed2-bar-label">{label}</span>
      {ai?.state === "pending" ? (
        <span className="ed2-bar-ai" data-testid={`clip-ai-pending-${entity.id ?? ""}`} role="status">
          {ai.label}
        </span>
      ) : null}
      {ai?.state === "error" ? (
        <button
          type="button"
          className="ed2-bar-ai is-error"
          data-testid={`clip-ai-retry-${entity.id ?? ""}`}
          title={`${ai.message} Click to try again.`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onRetry?.(entity)}
        >
          Failed · Retry
        </button>
      ) : null}
    </div>
  );
}

/** Ô sửa một marker: tên, màu, trạng thái, ghi chú. Mỗi lần đổi là một op (một bước undo). */
function MarkerEditor({
  marker,
  left,
  onClose,
  onChange,
  onDelete,
}: {
  marker: Marker;
  left: number;
  onClose: () => void;
  onChange: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="ed2-marker-editor"
      role="dialog"
      aria-label="Marker"
      data-testid="marker-editor"
      style={{ left: LABEL_WIDTH + left }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onClose();
      }}
    >
      <input
        className="ed2-rename"
        aria-label="Marker name"
        defaultValue={marker.name}
        maxLength={120}
        onBlur={(event) => event.target.value.trim() && event.target.value !== marker.name && onChange({ name: event.target.value.trim() })}
      />
      <div className="ed2-row ed2-wrap">
        <select aria-label="Marker color" value={marker.color} onChange={(event) => onChange({ color: event.target.value })}>
          {MARKER_COLORS.map((color) => (
            <option key={color} value={color}>{color[0]!.toUpperCase() + color.slice(1)}</option>
          ))}
        </select>
        <select aria-label="Marker status" value={marker.status} onChange={(event) => onChange({ status: event.target.value })}>
          <option value="open">Open</option>
          <option value="review">In review</option>
          <option value="resolved">Resolved</option>
        </select>
      </div>
      <textarea
        aria-label="Marker note"
        placeholder="Note"
        rows={3}
        maxLength={4000}
        defaultValue={marker.comment ?? ""}
        onBlur={(event) => event.target.value !== (marker.comment ?? "") && onChange({ comment: event.target.value || null })}
      />
      <div className="ed2-row">
        <button type="button" className="ed2-link ed2-danger" onClick={onDelete}>Delete</button>
        <span className="ed2-grow" />
        <button type="button" className="ed2-btn" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/** Vệt fade ở hai đầu clip (học Palmier §B3): thấy ngay clip nào đang mờ vào/ra, dài bao nhiêu. */
function FadeShades({ entity, ppf, width }: { entity: Entity; ppf: number; width: number }) {
  const list = (entity.animations as Array<{ type?: string; phase?: string; duration?: number }> | undefined) ?? [];
  const px = (phase: "in" | "out") => {
    const hit = list.find((animation) => (animation.type === "fade" || animation.type === "gain") && (animation.phase ?? "in") === phase);
    return typeof hit?.duration === "number" ? Math.min(width / 2, hit.duration * FPS * ppf) : 0;
  };
  const fadeIn = px("in");
  const fadeOut = px("out");
  return (
    <>
      {fadeIn > 1 ? <span className="ed2-bar-fade is-in" style={{ width: fadeIn }} aria-hidden /> : null}
      {fadeOut > 1 ? <span className="ed2-bar-fade is-out" style={{ width: fadeOut }} aria-hidden /> : null}
    </>
  );
}

function Wave({ src, t, media, width, height }: { src: AssetInput; t: TimeNode; media: BrowserMedia; width: number; height: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const key = typeof src === "string" ? src : JSON.stringify(src);
  useEffect(() => {
    let live = true;
    void loadPeaks(key, () => media.bytesOf(src)).then((found) => live && setPeaks(found));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, media]);
  // Canvas không rộng quá vùng thấy được nhiều lần: vẽ theo pixel thật, có trần.
  const pixels = Math.min(8192, Math.max(1, Math.round(width)));
  const theme = useThemePref();
  useEffect(() => {
    const element = canvas.current;
    if (!element || !peaks) return;
    element.width = pixels;
    element.height = Math.max(1, Math.round(height));
    const from = ((t.start - t.origin) * t.rate) / FPS;
    const to = ((t.end - t.origin) * t.rate) / FPS;
    // Màu sóng theo theme (token --ds-wave); thiếu token thì giữ màu cũ.
    const wave = getComputedStyle(element).getPropertyValue("--ds-wave").trim() || "rgba(255,255,255,0.35)";
    drawPeaks(element, peaks, from, to, wave);
    // Nhạc (lớp audio): vạch beat — cũng là điểm dính khi kéo clip (`targets`).
    if (t.node.kind === "audio") {
      const grid = beatsOf(key, peaks);
      if (grid) drawBeats(element, grid.beats, from, to, "rgba(255,214,0,0.8)");
    }
  }, [peaks, pixels, height, t.start, t.end, t.origin, t.rate, key, t.node.kind, theme]);
  if (!peaks) return null;
  return <canvas ref={canvas} className="ed2-wave" data-testid="waveform" />;
}

function Words({ transcript, t, ppf }: { transcript: Transcript | null; t: TimeNode; ppf: number }) {
  if (!transcript) return null;
  const words = transcript.flatMap((segment) => segment.words);
  return (
    <>
      {words.map((word, index) => {
        const start = t.origin + (word.start * FPS) / t.rate;
        const end = t.origin + (word.end * FPS) / t.rate;
        if (end <= t.start || start >= t.end) return null;
        const left = (Math.max(start, t.start) - t.start) * ppf;
        const width = (Math.min(end, t.end) - Math.max(start, t.start)) * ppf;
        if (width < 3) return null;
        return (
          <span key={index} className="ed2-word" style={{ left, width }}>
            {width > 14 ? word.text : ""}
          </span>
        );
      })}
    </>
  );
}
