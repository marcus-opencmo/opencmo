"use client";

/**
 * Bố cục editor theo Palmier Pro (`UI/WorkspaceLayout.swift`, `Editor/EditorView.swift`):
 * năm panel — Assistant, Media, Preview, Inspector, Timeline — xếp theo ba preset.
 *
 *   default   [Media | Preview | Inspector] / [Timeline]
 *   media     [Media] | ([Preview | Inspector] / [Timeline])
 *   vertical  ([Media | Inspector] / [Timeline]) | [Preview]
 *
 * Assistant luôn là cột riêng bên trái preset (Palmier để agent là anh em của cả
 * cây preset). Bật/tắt Assistant, Media, Inspector; phóng to một panel (phím `);
 * kéo mép đổi cỡ, cỡ nhớ RIÊNG theo preset như `SplitAutosave` của Palmier.
 *
 * Palmier dùng ⌘1/⌘2/⌘3 cho preset. Ở đây ⌘1/⌘2 đã là "Zoom to fit/selection"
 * (bảng phím của fork, KBD) nên preset là Alt+1/2/3 — dò theo `event.code` vì
 * Option+1 trên Mac ra ký tự "¡".
 *
 * Nhớ ở localStorage: thói quen của người ngồi trước máy, không phải dữ liệu clip.
 */

import { useCallback, useEffect, useState } from "react";

export type LayoutPreset = "default" | "media" | "vertical";
export type PanelName = "agent" | "media" | "preview" | "inspector" | "timeline";
/** Panel bật/tắt được. Preview và Timeline luôn có (tắt timeline vẫn ở menu View). */
export type ToggleablePanel = "agent" | "media" | "inspector";
export type SizeKey = "media" | "inspector" | "timeline" | "preview";

export const PRESETS: { id: LayoutPreset; label: string; key: string }[] = [
  { id: "default", label: "Default", key: "1" },
  { id: "media", label: "Media", key: "2" },
  { id: "vertical", label: "Vertical", key: "3" },
];

/** Cỡ tối thiểu của từng panel (px). Preview không xuống dưới mức còn xem được clip. */
export const MIN: Record<SizeKey | "agent", number> = { agent: 240, media: 200, inspector: 240, timeline: 120, preview: 320 };
const MAX_AGENT = 640;
/** Preview hẹp hơn mức này thì thanh khung và thanh công cụ chồng lên nhau. */
const PREVIEW_ROOM = 480;

type Sizes = Record<SizeKey, number>;
type Stored = {
  preset: LayoutPreset;
  visible: Record<ToggleablePanel, boolean>;
  agent: number;
  sizes: Partial<Record<LayoutPreset, Partial<Sizes>>>;
};

const KEY = "opencmo.editor.layout";

/** Cỡ mặc định theo preset, tính trên bề ngang cửa sổ — như `applyAfterLayout` của Palmier. */
export function defaultSizes(preset: LayoutPreset, width: number, height: number): Sizes {
  const timeline = Math.round(Math.max(MIN.timeline, height * 0.32));
  if (preset === "media") return { media: Math.round(Math.max(MIN.media, width * 0.26)), inspector: 300, timeline: Math.round(height * 0.42), preview: 0 };
  if (preset === "vertical") return { media: 250, inspector: 0, timeline: Math.round(height * 0.42), preview: Math.round(Math.max(MIN.preview, width * 0.4)) };
  return { media: 260, inspector: 300, timeline, preview: 0 };
}

function read(): Partial<Stored> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Stored>;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function write(value: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Storage bị chặn: lần sau mở về mặc định, không có gì hỏng.
  }
}

const isPreset = (value: unknown): value is LayoutPreset => value === "default" || value === "media" || value === "vertical";

export function useEditorLayout() {
  const [stored, setStored] = useState<Stored>({
    preset: "default",
    visible: { agent: false, media: true, inspector: true },
    agent: 380,
    sizes: {},
  });
  const [viewport, setViewport] = useState({ width: 1440, height: 900 });
  const [maximized, setMaximized] = useState<PanelName | null>(null);
  const [focused, setFocused] = useState<PanelName>("preview");
  // Bề ngang vùng editor (trừ rail): đo thật, không suy từ cửa sổ.
  const [body, setBody] = useState<HTMLElement | null>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
  useEffect(() => {
    if (!body) return;
    const observer = new ResizeObserver(() => setBodyWidth(body.clientWidth));
    observer.observe(body);
    setBodyWidth(body.clientWidth);
    return () => observer.disconnect();
  }, [body]);

  // Đọc sau khi mount: server không có localStorage (lệch hydrate nếu đọc lúc render).
  useEffect(() => {
    const saved = read();
    const wide = window.innerWidth >= 1500;
    setStored({
      preset: isPreset(saved.preset) ? saved.preset : "default",
      visible: {
        // Palmier mặc định ẩn agent; màn rộng thì đủ chỗ cho cả năm panel nên mở sẵn.
        agent: typeof saved.visible?.agent === "boolean" ? saved.visible.agent : wide,
        media: typeof saved.visible?.media === "boolean" ? saved.visible.media : true,
        inspector: typeof saved.visible?.inspector === "boolean" ? saved.visible.inspector : true,
      },
      agent: typeof saved.agent === "number" ? saved.agent : 380,
      sizes: saved.sizes && typeof saved.sizes === "object" ? saved.sizes : {},
    });
    const measure = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const update = useCallback((change: (value: Stored) => Stored, persist = true) => {
    setStored((value) => {
      const next = change(value);
      if (persist) write(next);
      return next;
    });
  }, []);

  const base = defaultSizes(stored.preset, viewport.width, viewport.height);
  const sizes: Sizes = { ...base, ...stored.sizes[stored.preset] };

  const setPreset = useCallback(
    (preset: LayoutPreset) => {
      setMaximized(null);
      update((value) => ({ ...value, preset }));
    },
    [update],
  );
  const agentWidth = Math.min(MAX_AGENT, Math.max(MIN.agent, stored.agent));
  // Màn hẹp mở Assistant: không đủ chỗ cho Media + Inspector + Preview dùng được thì
  // Media nhường chỗ (suy ra lúc vẽ, không ghi đè lựa chọn đã lưu — đủ chỗ là tự về).
  const squeezed =
    bodyWidth > 0 &&
    stored.visible.agent &&
    stored.visible.media &&
    bodyWidth - agentWidth < MIN.media + (stored.visible.inspector ? MIN.inspector : 0) + (stored.preset === "vertical" ? Math.max(PREVIEW_ROOM, sizes.preview) : PREVIEW_ROOM);
  const visible = { ...stored.visible, media: stored.visible.media && !squeezed };
  const toggle = useCallback(
    (panel: ToggleablePanel, force?: boolean) => {
      setMaximized(null);
      update((value) => {
        const show = force ?? (panel === "media" && squeezed ? true : !value.visible[panel]);
        // Bấm hiện Media khi nó đang nhường chỗ: đóng Assistant để có chỗ.
        if (panel === "media" && squeezed && show) return { ...value, visible: { ...value.visible, agent: false, media: true } };
        return { ...value, visible: { ...value.visible, [panel]: show } };
      });
    },
    [update, squeezed],
  );
  const resize = useCallback(
    (key: SizeKey | "agent", size: number, persist: boolean) =>
      update((value) => {
        if (key === "agent") return { ...value, agent: Math.round(Math.min(MAX_AGENT, Math.max(MIN.agent, size))) };
        const current = { ...value.sizes[value.preset] };
        current[key] = Math.round(Math.max(MIN[key], size));
        return { ...value, sizes: { ...value.sizes, [value.preset]: current } };
      }, persist),
    [update],
  );
  /** Về cỡ mặc định của preset đang dùng (nhấp đúp tay kéo). */
  const reset = useCallback(
    (key: SizeKey | "agent") =>
      update((value) => {
        if (key === "agent") return { ...value, agent: 380 };
        const current = { ...value.sizes[value.preset] };
        delete current[key];
        return { ...value, sizes: { ...value.sizes, [value.preset]: current } };
      }),
    [update],
  );
  const toggleMaximize = useCallback((panel?: PanelName) => {
    setMaximized((was) => (was ? null : (panel ?? "preview")));
  }, []);

  return {
    preset: stored.preset,
    visible,
    squeezed,
    agentWidth,
    bodyRef: setBody,
    sizes,
    maximized,
    focused,
    setFocused,
    setPreset,
    toggle,
    resize,
    reset,
    toggleMaximize,
    setMaximized,
  };
}

export type EditorLayout = ReturnType<typeof useEditorLayout>;

/**
 * Lưới của vùng preset. Cột/hàng cỡ cố định viết `minmax(MIN, cỡ)`: thiếu chỗ thì
 * panel bên co về MIN trước, Preview giữ đủ 320px (fr tính sau khi các cột kia
 * đã lấy phần của mình). Panel ẩn: cột 0.
 */
export function gridFor(layout: Pick<EditorLayout, "preset" | "visible" | "sizes">, timelineHidden: boolean) {
  const { preset, visible, sizes } = layout;
  const track = (show: boolean, min: number, size: number) => (show ? `minmax(${min}px, ${size}px)` : "0px");
  const rows = `minmax(240px, 1fr) ${timelineHidden ? "0px" : track(true, MIN.timeline, sizes.timeline)}`;
  if (preset === "media") {
    return {
      areas: `"media preview inspector" "media timeline timeline"`,
      columns: `${track(visible.media, MIN.media, sizes.media)} minmax(${MIN.preview}px, 1fr) ${track(visible.inspector, MIN.inspector, sizes.inspector)}`,
      rows,
    };
  }
  if (preset === "vertical") {
    // Bên trái: Media + Inspector chia nhau phần còn lại; Preview là cột phải cao hết.
    const left = visible.media && visible.inspector ? `${track(true, MIN.media, sizes.media)} minmax(${MIN.inspector}px, 1fr)` : visible.media ? `minmax(${MIN.media}px, 1fr) 0px` : visible.inspector ? `0px minmax(${MIN.inspector}px, 1fr)` : "0px 0px";
    const noTop = !visible.media && !visible.inspector;
    return {
      areas: noTop ? `"timeline timeline preview" "timeline timeline preview"` : `"media inspector preview" "timeline timeline preview"`,
      columns: noTop ? `0px minmax(240px, 1fr) minmax(${MIN.preview}px, ${sizes.preview}px)` : `${left} minmax(${MIN.preview}px, ${sizes.preview}px)`,
      rows,
    };
  }
  return {
    areas: `"media preview inspector" "timeline timeline timeline"`,
    columns: `${track(visible.media, MIN.media, sizes.media)} minmax(${MIN.preview}px, 1fr) ${track(visible.inspector, MIN.inspector, sizes.inspector)}`,
    rows,
  };
}

/** Tay kéo ở mép panel nào, kéo thì cỡ nào đổi và theo chiều nào. */
export function splitterFor(preset: LayoutPreset, panel: PanelName): { edge: "left" | "right" | "top"; key: SizeKey } | null {
  if (panel === "timeline") return { edge: "top", key: "timeline" };
  if (panel === "media") return { edge: "right", key: "media" };
  if (panel === "inspector") return preset === "vertical" ? null : { edge: "left", key: "inspector" };
  if (panel === "preview") return preset === "vertical" ? { edge: "left", key: "preview" } : null;
  return null;
}

/** Phím của bố cục: Alt+1/2/3 đổi preset, ` phóng to panel đang chọn, Esc thu lại. */
export function layoutKey(event: Pick<KeyboardEvent, "code" | "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">, maximized: boolean): { preset: LayoutPreset } | "maximize" | "restore" | null {
  const mod = event.ctrlKey || event.metaKey;
  if (event.altKey && !mod && !event.shiftKey && /^Digit[123]$/.test(event.code)) {
    return { preset: PRESETS[Number(event.code.slice(5)) - 1]!.id };
  }
  if (!event.altKey && !mod && !event.shiftKey && event.code === "Backquote") return "maximize";
  if (maximized && event.key === "Escape") return "restore";
  return null;
}
