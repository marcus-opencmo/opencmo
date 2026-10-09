"use client";

/**
 * Phần dùng chung của inspector: kiểu ngữ cảnh, đọc/ghi giá trị có keyframe,
 * ô số gắn kim cương. Tách khỏi `Inspector.tsx` để `parts.tsx` không import
 * vòng (hằng số cấp module của nó gọi `title` lúc nạp).
 */

import { BLEND_MODES, NODE_SHAPES, TRACK_PROPERTIES, type ClipDocument } from "@opencmo/clip-doc";
import { FPS, sampleTrack, type TimeNode } from "@opencmo/clip-render";

import type { Manifest } from "../media";
import { NumberField, type Diamond, type Edit } from "./controls";

export type Entity = Record<string, unknown> & { id?: string };

export type InspectorContext = {
  doc: ClipDocument;
  scene: Entity;
  /** Node đang chọn (với thành phần phụ: node sở hữu nó). */
  node: Entity;
  time: TimeNode | null;
  /** Frame cục bộ của node ở playhead — `keyframe.time` đo theo nó. */
  local: number;
  edit: Edit;
  select: (ids: string[]) => void;
  manifest: Manifest;
  /** Khung playhead đã vẽ nhỏ, cho scopes ở tab Adjust (E3). */
  sample?: () => ImageData | null;
  /** Frame playhead của scene — scopes vẽ lại khi nó đổi. */
  frame?: number;
  /** Clip đang sửa, cho việc tốn credit gọi API (E4-e). */
  clipId?: string;
};

/** Loại node này có khoá `key` trong schema không. */
export function has(kind: unknown, key: string): boolean {
  const shape = NODE_SHAPES[kind as keyof typeof NODE_SHAPES];
  if (!shape) return false;
  if (key in shape.shape) return true;
  // `masks`/`children` gắn thêm ngoài schema gốc.
  return key === "masks" && ["rect", "path", "scene3d", "text", "video", "image", "group", "scene"].includes(kind as string);
}

const TRACKABLE = new Set<string>(TRACK_PROPERTIES);

// ------------------------------------------------------------------ ghi giá trị

export const setProps = (ctx: InspectorContext, holder: Entity, props: Record<string, unknown>, preview = false) =>
  holder.id && ctx.edit([{ op: "set_props", element_id: holder.id, props }], { preview });

function trackOf(holder: Entity, key: string): Entity | undefined {
  return ((holder.tracks as Entity[] | undefined) ?? []).find((track) => track.property === key);
}

/** Giá trị đang hiện của một ô: có track thì là giá trị ở playhead. */
export function shownNumber(ctx: InspectorContext, holder: Entity, key: string, fallback: number): number {
  const track = trackOf(holder, key);
  if (track && key !== "color") {
    const value = sampleTrack(track as never, ctx.local);
    if (value !== null) return value;
  }
  return typeof holder[key] === "number" ? (holder[key] as number) : fallback;
}

/** Ghi một ô có thể keyframe: có track thì ghi keyframe ở playhead, như fork. */
export function write(ctx: InspectorContext, holder: Entity, key: string, value: unknown, fallback?: unknown, preview = false) {
  if (!holder.id) return;
  if (TRACKABLE.has(key) && trackOf(holder, key) && (typeof value === "number" || typeof value === "string")) {
    ctx.edit([{ op: "set_keyframe", element_id: holder.id, property: key, time: ctx.local / FPS, value }], { preview });
    return;
  }
  setProps(ctx, holder, { [key]: value === fallback ? null : value }, preview);
}

export function diamond(ctx: InspectorContext, holder: Entity, key: string, current: number | string): Diamond | undefined {
  if (!TRACKABLE.has(key) || !holder.id) return undefined;
  const track = trackOf(holder, key);
  const on = !!track && ((track.keyframes as Entity[]) ?? []).some((keyframe) => Math.round(Number(keyframe.time) * FPS) === ctx.local);
  return {
    state: on ? "on" : track ? "track" : "off",
    toggle: () =>
      ctx.edit([
        on
          ? { op: "set_keyframe", element_id: holder.id, property: key, time: ctx.local / FPS, remove: true }
          : { op: "set_keyframe", element_id: holder.id, property: key, time: ctx.local / FPS, value: current },
      ]),
  };
}

/** Ô số gắn sẵn keyframe + mặc định-là-bỏ. */
export function Num(props: {
  ctx: InspectorContext;
  holder: Entity;
  prop: string;
  label: string;
  fallback: number;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  scale?: number;
  keyframes?: boolean;
  keepDefault?: boolean;
}) {
  const { ctx, holder, prop, fallback } = props;
  const value = shownNumber(ctx, holder, prop, fallback);
  const drop = props.keepDefault ? undefined : fallback;
  return (
    <NumberField
      label={props.label}
      value={value}
      step={props.step}
      min={props.min}
      max={props.max}
      unit={props.unit}
      scale={props.scale}
      testid={`ins-${prop}`}
      diamond={props.keyframes === false ? undefined : diamond(ctx, holder, prop, value)}
      onCommit={(next) => write(ctx, holder, prop, next, drop)}
      onPreview={(next) => write(ctx, holder, prop, next, drop, true)}
    />
  );
}

export const title = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).replace(/([A-Z])/g, " $1").toLowerCase();

export const BLEND_OPTIONS = BLEND_MODES.map((value) => ({ value, label: value === "sourceOver" ? "Normal" : title(value) }));

