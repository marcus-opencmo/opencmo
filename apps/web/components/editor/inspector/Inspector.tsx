"use client";

/**
 * Inspector của shell mới (spec editor-rewrite B4, checklist INS-01…07).
 *
 * Mục nào hiện là do SCHEMA của document quyết: một mục chỉ có mặt khi loại
 * node đó có khoá tương ứng (`NODE_SHAPES` của clip-doc). Nhờ vậy inspector
 * không bao giờ mời ghi thứ server sẽ trả 422, và thêm một prop vào schema là
 * nó có chỗ trong inspector.
 *
 * Ghi: `set_props` (prop), `set_keyframe` (ô có track keyframe thì ghi keyframe
 * ở playhead, như fork), `add_part`/`move_part`/`delete_element` (thành phần
 * phụ), `move_elements`/`trim_element` (thời gian — cùng luật với timeline).
 * Quy ước của fork: ghi giá trị mặc định là BỎ prop.
 */

import { useEffect, useState, type ReactNode } from "react";

import { CAPTION_PRESETS, CAPTION_SCALE_MAX, CAPTION_SCALE_MIN, NAMED_EASINGS, type ClipDocument, type ClipNode } from "@opencmo/clip-doc";
import { captionPresetText, FONTS, FPS, type TimeNode } from "@opencmo/clip-render";

import { CaptionStylePicker } from "@/components/brand/CaptionStylePicker";

import type { Manifest } from "../media";
import { labelOf, roleOf } from "../timeline/rows";
import { ColorField, NumberField, Row, Section, Segmented, SelectField, type Edit } from "./controls";
import { ArrangeSection } from "./layouts";
import { TextStyleSection } from "./textstyle";
import { GenerateCaptionsSection, mediaOf, TranslateCaptionsRow, VoiceoverCaptionsSection } from "./captions-ai";
import { AnimationsSection, EffectsSection, FillsSection, MasksSection, ShadowsSection, StrokesSection } from "./parts";
import {
  BLEND_OPTIONS,
  diamond,
  has,
  Num,
  setProps,
  shownNumber,
  title,
  write,
  type Entity,
  type InspectorContext,
} from "./shared";

type Props = {
  doc: ClipDocument;
  scene: Entity;
  selection: string[];
  byId: Map<string, { entity: Entity; tag: string; owner: Entity | null }>;
  times: Map<ClipNode, TimeNode>;
  frame: number;
  edit: Edit;
  select: (ids: string[]) => void;
  manifest: Manifest;
  /** Khung nhỏ đã vẽ ở frame `at` cho scopes (E3); không có thì ẩn scopes. */
  sample?: (at: number) => ImageData | null;
  /** Clip đang sửa — cho các việc tốn credit gọi API (phụ đề, dịch). */
  clipId?: string;
};

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
  scene: "Scene",
};

/**
 * Media (thư viện, Generate) là `rect` tô bằng paint video/ảnh — cùng cách DS
 * dựng. Gọi nó là "Rectangle" thì người dùng không nhận ra lớp video của mình.
 */
function kindLabel(node: Record<string, unknown>): string {
  if (node.kind === "rect" && Array.isArray(node.paints)) {
    const media = (node.paints as { type?: string }[]).find((paint) => paint.type === "video" || paint.type === "image");
    if (media) return KIND_LABEL[media.type!]!;
  }
  return KIND_LABEL[node.kind as string] ?? String(node.kind);
}

// ------------------------------------------------------------------ inspector

export function Inspector(props: Props) {
  const { selection, byId } = props;
  // Tab người dùng chọn lần cuối; phần tử mới không có tab đó thì về tab đầu (Palmier `preferredTab`).
  const [tab, setTab] = useState<InspectorTab>("video");
  const first = selection[0] ? byId.get(selection[0]) : undefined;

  let body: ReactNode;
  if (!first) {
    body = <StageSections {...props} />;
  } else if (first.tag === "keyframe") {
    body = <InterpolationSection {...props} keyframe={first.entity} owner={first.owner} />;
  } else if (selection.length > 1) {
    body = <AlignmentSection {...props} />;
  } else {
    const node = first.entity;
    const ctx: InspectorContext = {
      doc: props.doc,
      scene: props.scene,
      node,
      time: props.times.get(node as unknown as ClipNode) ?? null,
      local: 0,
      edit: props.edit,
      select: props.select,
      manifest: props.manifest,
      sample: props.sample ? () => props.sample!(props.frame) : undefined,
      frame: props.frame,
      clipId: props.clipId,
    };
    const t = ctx.time;
    ctx.local = t ? Math.round((props.frame - t.origin) * t.rate) : props.frame;
    body = <NodeSections ctx={ctx} parent={first.owner} tab={tab} onTab={setTab} />;
  }

  return (
    <aside className="ed2-inspector" data-testid="inspector">
      {body}
    </aside>
  );
}

const ADVANCED_KEY = "opencmo.editor.advanced";

/** "More options" mở hay đóng, nhớ qua các lần mở editor (mặc định đóng). */
function useAdvanced(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(ADVANCED_KEY) === "1");
    } catch {
      // Storage bị chặn: luôn bắt đầu ở bản gọn.
    }
  }, []);
  const set = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(ADVANCED_KEY, next ? "1" : "0");
    } catch {
      // Không nhớ được thì chỉ áp trong phiên này.
    }
  };
  return [open, set];
}

type InspectorTab = "content" | "animate" | "video" | "adjust" | "audio";
const TAB_LABEL: Record<InspectorTab, string> = { content: "Content", animate: "Animate", video: "Video", adjust: "Adjust", audio: "Audio" };

/**
 * Mục chia theo tab như inspector của Palmier: chữ có Content/Animate, hình có
 * Video/Adjust, có tiếng thì thêm Audio. Chỉ một tab có nội dung thì không vẽ thanh tab.
 */
function NodeSections({ ctx, parent, tab, onTab }: { ctx: InspectorContext; parent: Entity | null; tab: InspectorTab; onTab: (tab: InspectorTab) => void }) {
  const { node } = ctx;
  const [advanced, setAdvanced] = useAdvanced();
  const kind = node.kind as string;
  const textual = kind === "text" || kind === "captions";
  // Gọn mặc định cho người không chuyên (design 06/10): thời gian, vị trí và mục
  // chính của loại lớp. Kích thước, độ mờ/blend, fill/stroke/shadow/mask, điểm
  // path nằm sau "More options" — lựa chọn được nhớ (`useAdvanced`).
  const advancedSections = [
    has(kind, "width") && kind !== "scene" ? <LayoutSection key="layout" ctx={ctx} /> : null,
    has(kind, "opacity") || has(kind, "blendMode") ? <AppearanceSection key="appearance" ctx={ctx} /> : null,
    kind === "path" ? <PathSection key="path" ctx={ctx} /> : null,
    has(kind, "paints") ? <FillsSection key="fills" ctx={ctx} /> : null,
    has(kind, "strokes") ? <StrokesSection key="strokes" ctx={ctx} /> : null,
    has(kind, "shadows") ? <ShadowsSection key="shadows" ctx={ctx} /> : null,
    has(kind, "masks") && kind !== "scene" ? <MasksSection key="masks" ctx={ctx} /> : null,
  ].filter(Boolean);
  const place = (
    <>
      {kind !== "sequence" ? <TimeSection ctx={ctx} /> : null}
      {has(kind, "x") || has(kind, "rotation") ? <TransformSection ctx={ctx} /> : null}
    </>
  );
  const look = (
    <>
      {kind === "scene3d" ? <Scene3DSection ctx={ctx} /> : null}
      {kind === "lottie" ? <LottieSection ctx={ctx} /> : null}
      {mediaOf(node) && ctx.clipId ? <GenerateCaptionsSection ctx={ctx} parent={parent} clipId={ctx.clipId} /> : null}
      {kind === "audio" ? <VoiceoverCaptionsSection ctx={ctx} /> : null}
      {has(kind, "src") && kind !== "captions" ? <SourceSection ctx={ctx} /> : null}
      {parent?.kind === "sequence" && has(kind, "transition") ? <TransitionSection ctx={ctx} /> : null}
      {advancedSections.length ? (
        <>
          <button
            type="button"
            className="ed2-more-options"
            aria-expanded={advanced}
            data-testid="ins-more-options"
            onClick={() => setAdvanced(!advanced)}
          >
            {advanced ? "Fewer options" : "More options"}
            <span aria-hidden>{advanced ? "▴" : "▾"}</span>
          </button>
          {advanced ? advancedSections : null}
        </>
      ) : null}
    </>
  );
  const animations = has(kind, "animations") ? <AnimationsSection ctx={ctx} /> : null;
  const tabs: { id: InspectorTab; body: ReactNode }[] = [];
  if (textual) {
    tabs.push({
      id: "content",
      body: (
        <>
          {kind === "captions" ? <CaptionSection ctx={ctx} parent={parent} /> : <TextSection ctx={ctx} />}
          {kind === "text" ? <TextStyleSection ctx={ctx} /> : null}
          {place}
          {look}
        </>
      ),
    });
    if (animations) tabs.push({ id: "animate", body: animations });
  } else {
    tabs.push({
      id: "video",
      body: (
        <>
          {place}
          {look}
          {animations}
        </>
      ),
    });
  }
  if (has(kind, "effects")) tabs.push({ id: "adjust", body: <EffectsSection ctx={ctx} /> });
  if (has(kind, "volume") || has(kind, "muted")) tabs.push({ id: "audio", body: <AudioSection ctx={ctx} /> });
  const active = tabs.find((item) => item.id === tab) ?? tabs[0]!;
  return (
    <>
      <Header ctx={ctx} />
      {tabs.length > 1 ? (
        <div className="ed2-left-tabs ed2-ins-tabs" role="tablist" aria-label="Inspector">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className="ed2-tab"
              aria-selected={item.id === active.id}
              data-testid={`ins-tab-${item.id}`}
              onClick={() => onTab(item.id)}
            >
              {TAB_LABEL[item.id]}
            </button>
          ))}
        </div>
      ) : null}
      {active.body}
    </>
  );
}

function Header({ ctx }: { ctx: InspectorContext }) {
  const { node } = ctx;
  return (
    <header className="ed2-ins-header" data-testid="ins-header">
      <span className="ed2-kind-chip" data-role={roleOf(node)}>{kindLabel(node)}</span>
      <input
        className="ed2-ins-name"
        aria-label="Layer name"
        key={`${node.id}:${String(node.name ?? "")}`}
        defaultValue={labelOf(node)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
        onBlur={(event) => {
          const name = event.target.value.trim();
          if (name && name !== labelOf(node)) setProps(ctx, node, { name });
        }}
      />
    </header>
  );
}

// ------------------------------------------------------------------ thời gian

function TimeSection({ ctx }: { ctx: InspectorContext }) {
  const { node, time: t } = ctx;
  if (!t) return null;
  const id = node.id!;
  const kind = node.kind as string;
  const timed = has(kind, "start");
  return (
    <Section title="Time" testid="ins-time">
      <Row label="Start">
        <NumberField
          label="Start"
          value={t.start / FPS}
          step={0.01}
          unit="s"
          testid="ins-start"
          onCommit={(value) => timed && ctx.edit([{ op: "move_elements", element_ids: [id], by: value - t.start / FPS }])}
        />
      </Row>
      <Row label="End">
        <NumberField
          label="End"
          value={t.end / FPS}
          step={0.01}
          unit="s"
          testid="ins-end"
          onCommit={(value) => timed && ctx.edit([{ op: "trim_element", element_id: id, edge: "out", at: Math.max(0, value) }])}
        />
      </Row>
      <Row label="Duration">
        <NumberField
          label="Duration"
          value={(t.end - t.start) / FPS}
          step={0.01}
          min={1 / FPS}
          unit="s"
          testid="ins-duration"
          onCommit={(value) =>
            timed && ctx.edit([{ op: "trim_element", element_id: id, edge: "out", at: t.start / FPS + value }])
          }
        />
      </Row>
      {has(kind, "sourceIn") && (node.src !== undefined || kind === "captions") ? (
        <Row label="Source in">
          <NumberField
            label="Source in"
            value={typeof node.sourceIn === "number" ? node.sourceIn : 0}
            step={0.01}
            min={0}
            unit="s"
            testid="ins-sourceIn"
            onCommit={(value) => setProps(ctx, node, { sourceIn: value || null })}
          />
        </Row>
      ) : null}
      {has(kind, "playbackRate") ? (
        <Row label="Speed">
          <NumberField
            label="Speed"
            value={typeof node.playbackRate === "number" ? node.playbackRate : 1}
            scale={100}
            step={1}
            min={1}
            max={1000}
            unit="%"
            testid="ins-playbackRate"
            onCommit={(value) => setProps(ctx, node, { playbackRate: value === 1 ? null : value })}
          />
        </Row>
      ) : null}
      {has(kind, "animations") && kind !== "scene" ? (
        <>
          {/* Fade (học Palmier §B3): hình bằng animation fade, tiếng bằng gain — một op cho cả hai. */}
          <Row label="Fade in">
            <NumberField
              label="Fade in"
              value={fadeOf(node, "in")}
              step={0.1}
              min={0}
              max={10}
              unit="s"
              testid="ins-fadeIn"
              onCommit={(value) => ctx.edit([{ op: "set_fade", element_ids: [id], in: Math.max(0, value) }])}
            />
          </Row>
          <Row label="Fade out">
            <NumberField
              label="Fade out"
              value={fadeOf(node, "out")}
              step={0.1}
              min={0}
              max={10}
              unit="s"
              testid="ins-fadeOut"
              onCommit={(value) => ctx.edit([{ op: "set_fade", element_ids: [id], out: Math.max(0, value) }])}
            />
          </Row>
        </>
      ) : null}
    </Section>
  );
}

/** Độ dài fade đang có ở một phía (fade hình, hoặc gain với node chỉ có tiếng). */
function fadeOf(node: Entity, phase: "in" | "out"): number {
  const list = (node.animations as Array<{ type?: string; phase?: string; duration?: number }> | undefined) ?? [];
  const hit = list.find((animation) => (animation.type === "fade" || animation.type === "gain") && (animation.phase ?? "in") === phase);
  return typeof hit?.duration === "number" ? hit.duration : 0;
}

// ------------------------------------------------------------------ biến đổi, bố cục

function TransformSection({ ctx }: { ctx: InspectorContext }) {
  const { node } = ctx;
  const kind = node.kind as string;
  const uniform = typeof node.scaleX !== "number" && typeof node.scaleY !== "number";
  return (
    <Section title="Transform" testid="ins-transform">
      {has(kind, "x") ? (
        <Row label="Position">
          <Num ctx={ctx} holder={node} prop="x" label="X" fallback={0} />
          <Num ctx={ctx} holder={node} prop="y" label="Y" fallback={0} />
        </Row>
      ) : null}
      {has(kind, "offsetX") ? (
        <Row label="Offset">
          <Num ctx={ctx} holder={node} prop="offsetX" label="X" fallback={0} />
          <Num ctx={ctx} holder={node} prop="offsetY" label="Y" fallback={0} />
        </Row>
      ) : null}
      {has(kind, "rotation") ? (
        <Row label="Rotate">
          <Num ctx={ctx} holder={node} prop="rotation" label="°" fallback={0} />
        </Row>
      ) : null}
      {has(kind, "scale") ? (
        uniform ? (
          <Row label="Scale">
            <Num ctx={ctx} holder={node} prop="scale" label="%" fallback={1} scale={100} step={1} />
            <button type="button" className="ed2-link" onClick={() => setProps(ctx, node, { scale: null, scaleX: shownNumber(ctx, node, "scale", 1), scaleY: shownNumber(ctx, node, "scale", 1) })}>
              Per axis
            </button>
          </Row>
        ) : (
          <Row label="Scale">
            <Num ctx={ctx} holder={node} prop="scaleX" label="X%" fallback={1} scale={100} step={1} />
            <Num ctx={ctx} holder={node} prop="scaleY" label="Y%" fallback={1} scale={100} step={1} />
          </Row>
        )
      ) : null}
      {has(kind, "scale") ? (
        // Lật (E4, học Palmier flipHorizontal/Vertical): đổi dấu tỉ lệ theo trục, giữ độ lớn.
        <Row label="Flip">
          {(["x", "y"] as const).map((axis) => {
            const sx = uniform ? shownNumber(ctx, node, "scale", 1) : shownNumber(ctx, node, "scaleX", 1);
            const sy = uniform ? shownNumber(ctx, node, "scale", 1) : shownNumber(ctx, node, "scaleY", 1);
            const flipped = axis === "x" ? sx < 0 : sy < 0;
            return (
              <button
                key={axis}
                type="button"
                className="ed2-chip"
                aria-pressed={flipped}
                data-testid={`ins-flip-${axis}`}
                onClick={() => setProps(ctx, node, { scale: null, scaleX: axis === "x" ? -sx : sx, scaleY: axis === "y" ? -sy : sy })}
              >
                {axis === "x" ? "↔ Horizontal" : "↕ Vertical"}
              </button>
            );
          })}
        </Row>
      ) : null}
    </Section>
  );
}

const ALIGN_X = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
] as const;
const ALIGN_Y = [
  { value: "top", label: "Top" },
  { value: "middle", label: "Middle" },
  { value: "bottom", label: "Bottom" },
] as const;

/** Path: phần đường được vẽ (keyframe trimEnd 0 → 1 = vẽ nét) và nét đứt. */
function PathSection({ ctx }: { ctx: InspectorContext }) {
  const { node } = ctx;
  const dash = Array.isArray(node.dash) ? (node.dash as number[]) : [];
  return (
    <Section title="Path" testid="ins-path">
      <Row label="Draw">
        <Num ctx={ctx} holder={node} prop="trimStart" label="From" fallback={0} min={0} max={1} step={1} scale={100} unit="%" keyframes />
        <Num ctx={ctx} holder={node} prop="trimEnd" label="To" fallback={1} min={0} max={1} step={1} scale={100} unit="%" keyframes />
      </Row>
      <Row label="Dash">
        <NumberField
          label="Dash"
          value={dash[0] ?? 0}
          min={0}
          testid="ins-path-dash"
          onCommit={(value) => setProps(ctx, node, { dash: value > 0 ? [value, dash[1] ?? value] : undefined })}
        />
        <NumberField
          label="Gap"
          value={dash[1] ?? 0}
          min={0}
          testid="ins-path-gap"
          onCommit={(value) => setProps(ctx, node, { dash: dash[0] ? [dash[0], value] : undefined })}
        />
      </Row>
    </Section>
  );
}

/** Cảnh 3D: camera (vật thể sửa ở bảng Visuals). */
function Scene3DSection({ ctx }: { ctx: InspectorContext }) {
  const { node } = ctx;
  const camera = (node.camera as Record<string, number> | undefined) ?? {};
  const set = (key: string, value: number) => setProps(ctx, node, { camera: { ...camera, [key]: value } });
  return (
    <Section title="3D camera" testid="ins-scene3d">
      <Row label="Angle">
        <NumberField label="Tilt" value={camera.phi ?? 65} min={0} max={180} unit="°" testid="ins-3d-phi" onCommit={(value) => set("phi", value)} />
        <NumberField label="Turn" value={camera.theta ?? -50} unit="°" testid="ins-3d-theta" onCommit={(value) => set("theta", value)} />
      </Row>
      <Row label="View">
        <NumberField label="Dist" value={camera.distance ?? 12} min={1} step={0.5} testid="ins-3d-distance" onCommit={(value) => set("distance", value)} />
        <NumberField label="Orbit" value={camera.orbit ?? 0} unit="°/s" testid="ins-3d-orbit" onCommit={(value) => set("orbit", value)} />
      </Row>
    </Section>
  );
}

/** Lottie: tốc độ, lặp, giây bắt đầu của animation. */
function LottieSection({ ctx }: { ctx: InspectorContext }) {
  const { node } = ctx;
  return (
    <Section title="Animation playback" testid="ins-lottie">
      <Row label="Timing">
        <NumberField label="Speed" value={Number(node.speed ?? 1)} min={0.1} max={8} step={0.1} unit="×" testid="ins-lottie-speed" onCommit={(value) => setProps(ctx, node, { speed: value === 1 ? undefined : value })} />
        <NumberField label="Start" value={Number(node.offset ?? 0)} min={0} step={0.1} unit="s" testid="ins-lottie-offset" onCommit={(value) => setProps(ctx, node, { offset: value || undefined })} />
      </Row>
      <Row label="Loop">
        <label className="ed2-check">
          <input type="checkbox" data-testid="ins-lottie-loop" checked={node.loop !== false} onChange={(event) => setProps(ctx, node, { loop: event.target.checked ? undefined : false })} />
          Repeat
        </label>
      </Row>
    </Section>
  );
}

function LayoutSection({ ctx }: { ctx: InspectorContext }) {
  const { node, scene } = ctx;
  const kind = node.kind as string;
  const w = shownNumber(ctx, node, "width", 0);
  const h = shownNumber(ctx, node, "height", 0);
  const W = Number(scene.width) || 0;
  const H = Number(scene.height) || 0;
  const align = (axis: "x" | "y", where: string) => {
    const size = axis === "x" ? w : h;
    const frame = axis === "x" ? W : H;
    const value = where === "left" || where === "top" ? 0 : where === "right" || where === "bottom" ? frame - size : (frame - size) / 2;
    write(ctx, node, axis, Math.round(value * 100) / 100);
  };
  return (
    <Section title="Layout" testid="ins-layout">
      <Row label="Size">
        <Num ctx={ctx} holder={node} prop="width" label="W" fallback={0} min={0} keepDefault />
        <Num ctx={ctx} holder={node} prop="height" label="H" fallback={0} min={0} keepDefault />
      </Row>
      {has(kind, "keepAspectRatio") ? (
        <Row label="Aspect">
          <label className="ed2-check">
            <input
              type="checkbox"
              checked={node.keepAspectRatio === true}
              onChange={(event) => setProps(ctx, node, { keepAspectRatio: event.target.checked })}
            />
            Keep ratio
          </label>
        </Row>
      ) : null}
      {has(kind, "x") ? (
        <Row label="Align">
          <div className="ed2-align">
            {ALIGN_X.map((option) => (
              <button key={option.value} type="button" className="ed2-chip" data-testid={`align-${option.value}`} onClick={() => align("x", option.value)}>
                {option.label}
              </button>
            ))}
            {ALIGN_Y.map((option) => (
              <button key={option.value} type="button" className="ed2-chip" data-testid={`align-${option.value}`} onClick={() => align("y", option.value)}>
                {option.label}
              </button>
            ))}
          </div>
        </Row>
      ) : null}
      {has(kind, "constrainX") ? (
        <Row label="Constraints">
          <SelectField
            label="Horizontal constraint"
            value={(node.constrainX as string | undefined) ?? "left"}
            options={["left", "right", "center", "stretch", "scale"].map((value) => ({ value, label: title(value) }))}
            onChange={(value) => setProps(ctx, node, { constrainX: value === "left" ? null : value })}
          />
          <SelectField
            label="Vertical constraint"
            value={(node.constrainY as string | undefined) ?? "top"}
            options={["top", "bottom", "center", "stretch", "scale"].map((value) => ({ value, label: title(value) }))}
            onChange={(value) => setProps(ctx, node, { constrainY: value === "top" ? null : value })}
          />
        </Row>
      ) : null}
    </Section>
  );
}

function AppearanceSection({ ctx }: { ctx: InspectorContext }) {
  const { node } = ctx;
  const kind = node.kind as string;
  const corners = ["cornerRadiusTopLeft", "cornerRadiusTopRight", "cornerRadiusBottomRight", "cornerRadiusBottomLeft"];
  const separate = corners.some((key) => typeof node[key] === "number");
  return (
    <Section title="Appearance" testid="ins-appearance">
      {has(kind, "opacity") ? (
        <Row label="Opacity">
          <Num ctx={ctx} holder={node} prop="opacity" label="%" fallback={1} scale={100} step={1} min={0} max={100} />
        </Row>
      ) : null}
      {has(kind, "blendMode") ? (
        <Row label="Blend">
          <SelectField
            label="Blend mode"
            testid="ins-blendMode"
            value={(node.blendMode as string | undefined) ?? "sourceOver"}
            options={BLEND_OPTIONS}
            onChange={(value) => setProps(ctx, node, { blendMode: value === "sourceOver" ? null : value })}
          />
        </Row>
      ) : null}
      {has(kind, "cornerRadius") ? (
        <Row label="Radius">
          {separate ? (
            corners.map((key, index) => (
              <Num key={key} ctx={ctx} holder={node} prop={key} label={["TL", "TR", "BR", "BL"][index]!} fallback={shownNumber(ctx, node, "cornerRadius", 0)} min={0} keepDefault />
            ))
          ) : (
            <Num ctx={ctx} holder={node} prop="cornerRadius" label="R" fallback={0} min={0} />
          )}
          <button
            type="button"
            className="ed2-link"
            onClick={() =>
              setProps(
                ctx,
                node,
                separate
                  ? Object.fromEntries(corners.map((key) => [key, null]))
                  : Object.fromEntries(corners.map((key) => [key, shownNumber(ctx, node, "cornerRadius", 0)])),
              )
            }
          >
            {separate ? "One radius" : "Per corner"}
          </button>
        </Row>
      ) : null}
    </Section>
  );
}

// ------------------------------------------------------------------ chữ, phụ đề

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

function TextSection({ ctx }: { ctx: InspectorContext }) {
  const { node } = ctx;
  const family = (node.fontFamily as string | undefined) ?? "Inter";
  const font = FONTS[family as keyof typeof FONTS];
  const weights = WEIGHTS.filter((weight) => !font || (weight >= font.weights[0] && weight <= font.weights[1]));
  const weight = typeof node.fontWeight === "number" ? node.fontWeight : node.fontWeight === "bold" ? 700 : 400;
  return (
    <Section title="Typography" testid="ins-text">
      <textarea
        className="ed2-textarea"
        aria-label="Text"
        data-testid="ins-text-content"
        data-node={String(node.id)}
        key={`${node.id}:${String(node.text)}`}
        defaultValue={String(node.text ?? "")}
        rows={2}
        onKeyDown={(event) => event.stopPropagation()}
        onBlur={(event) => event.target.value !== node.text && setProps(ctx, node, { text: event.target.value })}
      />
      <Row label="Font">
        <SelectField
          label="Font family"
          testid="ins-fontFamily"
          value={family}
          options={Object.keys(FONTS).map((value) => ({ value, label: value }))}
          onChange={(value) => setProps(ctx, node, { fontFamily: value })}
        />
      </Row>
      <Row label="Weight">
        <SelectField
          label="Font weight"
          value={String(weight)}
          options={weights.map((value) => ({ value: String(value), label: String(value) }))}
          onChange={(value) => setProps(ctx, node, { fontWeight: Number(value) })}
        />
        <SelectField
          label="Font style"
          value={(node.fontStyle as string | undefined) ?? "normal"}
          options={[{ value: "normal", label: "Regular" }, { value: "italic", label: "Italic" }]}
          onChange={(value) => setProps(ctx, node, { fontStyle: value === "normal" ? null : value })}
        />
      </Row>
      <Row label="Size">
        <NumberField label="Size" value={Number(node.fontSize ?? 16)} min={1} testid="ins-fontSize" onCommit={(value) => setProps(ctx, node, { fontSize: value })} />
      </Row>
      <Row label="Spacing">
        <NumberField label="Letter" value={Number(node.letterSpacing ?? 0)} step={0.1} onCommit={(value) => setProps(ctx, node, { letterSpacing: value || null })} />
        <NumberField label="Line" value={Number(node.leading ?? 1)} scale={100} step={1} unit="%" onCommit={(value) => setProps(ctx, node, { leading: value === 1 ? null : value })} />
      </Row>
      <Row label="Align">
        <Segmented
          label="Text align"
          value={(node.textAlign as string | undefined) ?? "left"}
          options={[{ value: "left", label: "Left" }, { value: "center", label: "Center" }, { value: "right", label: "Right" }]}
          onChange={(value) => setProps(ctx, node, { textAlign: value === "left" ? null : value })}
        />
      </Row>
      <Row label="Baseline">
        <SelectField
          label="Text baseline"
          value={(node.textBaseline as string | undefined) ?? "top"}
          options={["top", "middle", "bottom", "alphabetic"].map((value) => ({ value, label: title(value) }))}
          onChange={(value) => setProps(ctx, node, { textBaseline: value === "top" ? null : value })}
        />
      </Row>
      <Row label="Case">
        <SelectField
          label="Text case"
          value={(node.textCase as string | undefined) ?? "original"}
          options={[{ value: "original", label: "Original" }, { value: "upper", label: "UPPER" }, { value: "lower", label: "lower" }]}
          onChange={(value) => setProps(ctx, node, { textCase: value === "original" ? null : value })}
        />
      </Row>
      <Row label="Color">
        <ColorField
          value={String(node.color ?? "#FFFFFF")}
          diamond={diamond(ctx, node, "color", String(node.color ?? "#FFFFFF"))}
          testid="ins-color"
          onCommit={(value) => write(ctx, node, "color", value)}
        />
      </Row>
    </Section>
  );
}

/** Màu nhấn bấm-một-lần cho preset có một ô Highlight (Gold, Coral, Laurel, Moon). */
const HIGHLIGHTS: [string, string][] = [
  ["Gold", "#F6C04A"],
  ["Coral", "#F2946F"],
  ["Laurel", "#7FE0A0"],
  ["Sky", "#24D5FF"],
  ["Moon", "#FFFFFF"],
];

/** Ô màu theo từng preset phụ đề, và màu preset tự dùng khi ô để trống. */
const CAPTION_SLOTS: Record<string, { label: string; color: string }[]> = {
  spotlight: [{ label: "Highlight", color: "#24D5FF" }],
  guinea: [
    { label: "Color 1", color: "#F55353" },
    { label: "Color 2", color: "#FEB139" },
    { label: "Color 3", color: "#F6F54D" },
  ],
};

/** Mọi lớp phụ đề của clip (phụ đề video, phụ đề voiceover…), kể cả nằm trong nhóm. */
function captionNodes(scene: Entity): Entity[] {
  const out: Entity[] = [];
  const visit = (list: unknown) => {
    for (const child of (list as Entity[] | undefined) ?? []) {
      if (child.kind === "captions") out.push(child);
      visit(child.children);
    }
  };
  visit(scene.children);
  return out;
}

/**
 * Kiểu chữ áp cho MỌI lớp phụ đề trong một bước undo: một clip một kiểu phụ đề
 * (người dùng 02/10: "caption phải đồng nhất"). Vị trí thì từng lớp riêng.
 */
const CAPTION_STYLE = ["preset", "colors", "color", "fontFamily", "fontWeight", "fontScale"] as const;

function setCaptionStyle(ctx: InspectorContext, props: Record<string, unknown>) {
  const targets = captionNodes(ctx.scene).filter((captions) => captions.id);
  const list = targets.some((captions) => captions.id === ctx.node.id) ? targets : [ctx.node];
  // Chép ĐỦ kiểu của lớp đang chọn, không chỉ ô vừa sửa: các lớp từng lệch nhau
  // (màu nhấn sửa riêng trước đây) khớp lại ngay lần sửa đầu.
  const style = { ...Object.fromEntries(CAPTION_STYLE.map((key) => [key, ctx.node[key] ?? null])), ...props };
  ctx.edit(list.map((captions) => ({ op: "set_props", element_id: captions.id, props: style })));
}

function CaptionSection({ ctx, parent }: { ctx: InspectorContext; parent: Entity | null }) {
  const { node } = ctx;
  const preset = (node.preset as string | undefined) ?? "classic";
  const slots = CAPTION_SLOTS[preset] ?? [];
  const colors = (node.colors as string[] | undefined) ?? [];
  const defaults = captionPresetText(preset as never);
  const family = (node.fontFamily as string | undefined) ?? defaults.fontFamily;
  const font = FONTS[family as keyof typeof FONTS];
  const weights = WEIGHTS.filter((weight) => !font || (weight >= font.weights[0] && weight <= font.weights[1]));
  const weight = typeof node.fontWeight === "number" ? node.fontWeight : defaults.fontWeight;
  const layers = captionNodes(ctx.scene).length;
  return (
    <Section title="Caption" testid="ins-caption">
      {layers > 1 && <p className="ed2-muted">Style applies to all {layers} caption layers. Position is per layer.</p>}
      {/* Chọn kiểu bằng ô xem trước (design 06/10) thay vì dropdown tên. Ô màu
          thuộc về preset: đổi preset thì màu đi theo preset cũ. Font/màu chữ đã
          chọn thì giữ — người dùng đổi kiểu hiệu ứng, không đổi chữ. */}
      <CaptionStylePicker
        value={preset}
        styles={CAPTION_PRESETS}
        accent={colors[0] ?? slots[0]?.color ?? "#24D5FF"}
        testId="ins-preset"
        onChange={(value) => setCaptionStyle(ctx, { preset: value === "classic" ? null : value, colors: null })}
      />
      <Row label="Font">
        <SelectField
          label="Caption font"
          testid="ins-caption-font"
          value={family}
          options={Object.keys(FONTS).map((value) => ({ value, label: value === defaults.fontFamily ? `${value} (preset)` : value }))}
          onChange={(value) => {
            const next = FONTS[value as keyof typeof FONTS];
            // Độ đậm ngoài dải của font mới thì kẹp vào dải, không để trình vẽ tự đoán.
            const fit = next ? Math.min(next.weights[1], Math.max(next.weights[0], weight)) : weight;
            setCaptionStyle(ctx, { fontFamily: value === defaults.fontFamily ? null : value, fontWeight: fit === defaults.fontWeight ? null : fit });
          }}
        />
      </Row>
      <Row label="Weight">
        <SelectField
          label="Caption weight"
          testid="ins-caption-weight"
          value={String(weight)}
          options={(weights.includes(weight) ? weights : [...weights, weight].sort((a, b) => a - b)).map((value) => ({ value: String(value), label: String(value) }))}
          onChange={(value) => setCaptionStyle(ctx, { fontWeight: Number(value) === defaults.fontWeight ? null : Number(value) })}
        />
      </Row>
      {defaults.color && (
        <Row label="Text">
          <ColorField
            label="Caption text color"
            value={(node.color as string | undefined) ?? defaults.color}
            testid="ins-caption-text-color"
            onCommit={(value) => setCaptionStyle(ctx, { color: value.toLowerCase() === defaults.color!.toLowerCase() ? null : value })}
          />
        </Row>
      )}
      {slots.length === 1 ? (
        <Row label="Quick">
          <span className="ed2-swatches" role="radiogroup" aria-label={`${slots[0]!.label} color`}>
            {HIGHLIGHTS.map(([name, color]) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-label={name}
                aria-checked={(colors[0] ?? slots[0]!.color).toLowerCase() === color.toLowerCase()}
                style={{ background: color }}
                onClick={() => setCaptionStyle(ctx, { colors: [color] })}
              />
            ))}
          </span>
        </Row>
      ) : null}
      {slots.map((slot, index) => (
        <Row key={slot.label} label={slot.label}>
          <ColorField
            value={colors[index] ?? slot.color}
            testid={`ins-caption-color-${index}`}
            // `colors` theo vị trí: ghi một ô là ghi đủ mọi ô của preset.
            onCommit={(value) =>
              setCaptionStyle(ctx, { colors: slots.map((other, at) => (at === index ? value : (colors[at] ?? other.color))) })
            }
          />
        </Row>
      ))}
      <Row label="Size">
        <NumberField
          label="Caption size"
          value={typeof node.fontScale === "number" ? node.fontScale : 1}
          scale={100}
          step={5}
          min={CAPTION_SCALE_MIN * 100}
          max={CAPTION_SCALE_MAX * 100}
          unit="%"
          testid="ins-caption-size"
          onCommit={(value) => setCaptionStyle(ctx, { fontScale: value === 1 ? null : value })}
        />
      </Row>
      <Row label="Position">
        <SelectField
          label="Vertical position"
          value={(node.verticalAlign as string | undefined) ?? "bottom"}
          options={[{ value: "top", label: "Top" }, { value: "center", label: "Center" }, { value: "bottom", label: "Bottom" }]}
          onChange={(value) => setProps(ctx, node, { verticalAlign: value })}
        />
      </Row>
      <Row label="Offset">
        <NumberField label="X" value={Number(node.offsetX ?? 0)} onCommit={(value) => setProps(ctx, node, { offsetX: value || null })} />
        <NumberField label="Y" value={Number(node.offsetY ?? 0)} onCommit={(value) => setProps(ctx, node, { offsetY: value || null })} />
      </Row>
      {/* Nhịp dòng (học Palmier §C1): 0 = theo preset. Áp cho mọi lớp phụ đề như kiểu chữ. */}
      <Row label="Max words">
        <NumberField
          label="Max words on screen"
          value={typeof node.maxWords === "number" ? node.maxWords : 0}
          step={1}
          min={0}
          max={20}
          testid="ins-caption-maxWords"
          onCommit={(value) => ctx.edit([{ op: "set_caption_breaks", max_words: Math.round(value) || null }])}
        />
      </Row>
      <Row label="Max chars">
        <NumberField
          label="Max characters on screen"
          value={typeof node.maxChars === "number" ? node.maxChars : 0}
          step={1}
          min={0}
          max={80}
          testid="ins-caption-maxChars"
          onCommit={(value) => ctx.edit([{ op: "set_caption_breaks", max_chars: value >= 4 ? Math.round(value) : null }])}
        />
      </Row>
      <Row label="Hold gaps">
        <NumberField
          label="Keep captions through pauses up to"
          value={typeof node.holdGap === "number" ? node.holdGap : 0}
          step={0.1}
          min={0}
          max={2}
          unit="s"
          testid="ins-caption-holdGap"
          onCommit={(value) => ctx.edit([{ op: "set_caption_breaks", hold_gap: value > 0 ? value : null }])}
        />
      </Row>
      {/* Học Palmier §C2: hộp màu nhấn sau từ đang nói (block), hoặc từ đang nói bật lên + đổi màu (pop, E4). */}
      <Row label="Highlight">
        <SelectField
          label="Caption highlight"
          testid="ins-caption-highlight"
          value={(node.highlight as string | undefined) ?? "off"}
          options={[
            { value: "off", label: "Off" },
            { value: "block", label: "Box behind the spoken word" },
            { value: "pop", label: "Pop the spoken word" },
          ]}
          onChange={(value) => setProps(ctx, node, { highlight: value === "off" ? null : value })}
        />
      </Row>
      {/* E4-e: che từ tục trên màn; transcript và file SRT xuất ra vẫn là lời gốc. */}
      <Row label="Profanity">
        <label className="ed2-check">
          <input type="checkbox" data-testid="ins-caption-censor" checked={node.censor === true} onChange={(event) => setProps(ctx, node, { censor: event.target.checked || null })} />
          Censor
        </label>
      </Row>
      {ctx.clipId ? <TranslateCaptionsRow ctx={ctx} parent={parent} clipId={ctx.clipId} /> : null}
    </Section>
  );
}

// ------------------------------------------------------------------ nguồn, tiếng, chuyển cảnh

function SourceSection({ ctx }: { ctx: InspectorContext }) {
  const { node, manifest } = ctx;
  const kind = node.kind as string;
  const src = node.src;
  const label = typeof src === "string" ? src.replace(/^assets\//, "") : src && typeof src === "object" ? `Generated ${String((src as Entity).generate ?? "media")}` : "None";
  // Loại asset của thư viện viết HOA (`VIDEO`…); `src` là `path` của asset.
  const type = kind === "audio" ? "AUDIO" : kind === "image" ? "IMAGE" : kind === "lottie" ? "LOTTIE" : "VIDEO";
  const choices = (manifest?.assets ?? []).filter(
    (asset) => typeof asset.path === "string" && asset.type === type && asset.state !== "pending" && asset.state !== "error",
  );
  return (
    <Section title="Source" testid="ins-source">
      <Row label="File">
        {choices.length ? (
          <SelectField
            label="Source file"
            value={typeof src === "string" ? src : ""}
            options={[
              ...(typeof src === "string" && !choices.some((asset) => asset.path === src) ? [{ value: src, label }] : []),
              ...(typeof src !== "string" ? [{ value: "", label }] : []),
              ...choices.map((asset) => ({ value: asset.path as string, label: asset.path as string })),
            ]}
            onChange={(value) => value && setProps(ctx, node, { src: value })}
          />
        ) : (
          <span className="ed2-muted ed2-ellipsis">{label}</span>
        )}
      </Row>
      {has(kind, "objectFit") ? (
        <Row label="Fit">
          <SelectField
            label="Object fit"
            value={(node.objectFit as string | undefined) ?? "cover"}
            options={[{ value: "cover", label: "Cover" }, { value: "contain", label: "Contain" }, { value: "fill", label: "Stretch" }]}
            onChange={(value) => setProps(ctx, node, { objectFit: value === "cover" ? null : value })}
          />
        </Row>
      ) : null}
    </Section>
  );
}

function AudioSection({ ctx }: { ctx: InspectorContext }) {
  const { node } = ctx;
  const kind = node.kind as string;
  const volume = node.volume === "-Infinity" ? -60 : shownNumber(ctx, node, "volume", 0);
  return (
    <Section title="Audio" testid="ins-audio">
      {has(kind, "volume") ? (
        <Row label="Volume">
          <NumberField
            label="dB"
            value={volume}
            step={0.5}
            min={-60}
            max={24}
            unit="dB"
            testid="ins-volume"
            diamond={diamond(ctx, node, "volume", volume)}
            onCommit={(value) => write(ctx, node, "volume", value, 0)}
          />
        </Row>
      ) : null}
      {has(kind, "muted") ? (
        <Row label="Mute">
          <label className="ed2-check">
            <input type="checkbox" data-testid="ins-muted" checked={node.muted === true} onChange={(event) => setProps(ctx, node, { muted: event.target.checked })} />
            Muted
          </label>
        </Row>
      ) : null}
      {/* Khử ồn (học Palmier §C7): chạy lúc export bằng ffmpeg — preview vẫn là tiếng gốc, nói thẳng ra. */}
      {kind === "video" || kind === "audio" ? (
        <Row label="Clean voice">
          <NumberField
            label="Background noise cleanup, applied when you export"
            value={Math.round(Number(node.denoise ?? 0) * 100)}
            step={10}
            min={0}
            max={100}
            unit="%"
            testid="ins-denoise"
            onCommit={(value) => ctx.edit([{ op: "clean_audio", amount: Math.min(100, Math.max(0, value)) / 100, element_id: node.id }])}
          />
        </Row>
      ) : null}
      {kind === "video" || kind === "audio" ? <p className="ed2-muted ed2-hint">Noise cleanup is applied when you export. The preview plays the original sound.</p> : null}
    </Section>
  );
}

const TRANSITIONS = [
  { value: "none", label: "None" },
  { value: "dissolve", label: "Dissolve" },
  { value: "slideFromRight", label: "Slide From Right" },
  { value: "slideFromLeft", label: "Slide From Left" },
  { value: "fadeToBlack", label: "Fade To Black" },
  { value: "fadeToWhite", label: "Fade To White" },
] as const;

function TransitionSection({ ctx }: { ctx: InspectorContext }) {
  const { node } = ctx;
  const transition = node.transition as { type?: string; duration?: number } | null | undefined;
  return (
    <Section title="Transition" testid="ins-transition">
      <Row label="Type">
        <SelectField
          label="Transition"
          testid="ins-transition-type"
          value={transition ? (transition.type ?? "dissolve") : "none"}
          options={TRANSITIONS}
          onChange={(value) =>
            setProps(ctx, node, { transition: value === "none" ? null : { type: value, duration: transition?.duration ?? 1 } })
          }
        />
      </Row>
      {transition ? (
        <Row label="Duration">
          <NumberField
            label="Duration"
            value={transition.duration ?? 1}
            step={0.1}
            min={0.1}
            unit="s"
            onCommit={(value) => setProps(ctx, node, { transition: { type: transition.type ?? "dissolve", duration: value } })}
          />
        </Row>
      ) : null}
    </Section>
  );
}

// ------------------------------------------------------------------ không chọn gì, chọn nhiều, keyframe

function StageSections(props: Props) {
  const stage = props.doc.stage as unknown as Entity;
  const scene = props.scene;
  const ctx: InspectorContext = { doc: props.doc, scene, node: scene, time: null, local: props.frame, edit: props.edit, select: props.select, manifest: props.manifest };
  return (
    <>
      <header className="ed2-ins-header">
        <span className="ed2-muted">Project</span>
        <span>{String(scene.name ?? "Clip")}</span>
      </header>
      <Section title="Background" testid="ins-background">
        <Row label="Canvas">
          <ColorField
            value={String(stage.background ?? "#000000")}
            testid="ins-stage-background"
            onCommit={(value) => props.edit([{ op: "set_props", element_id: stage.id ?? "", props: { background: value } }])}
          />
        </Row>
        <Row label="Clip">
          <ColorField value={String(scene.fill ?? "#000000")} testid="ins-scene-fill" onCommit={(value) => setProps(ctx, scene, { fill: value })} />
        </Row>
      </Section>
      <FillsSection ctx={ctx} />
      <AudioSection ctx={ctx} />
    </>
  );
}

function AlignmentSection(props: Props) {
  const nodes = props.selection
    .map((id) => props.byId.get(id))
    .filter((item): item is NonNullable<typeof item> => !!item && has(item.entity.kind, "x"))
    .map((item) => item.entity);
  const box = (node: Entity) => {
    const x = Number(node.x ?? 0);
    const y = Number(node.y ?? 0);
    return { x, y, w: Number(node.width ?? 0), h: Number(node.height ?? 0) };
  };
  const align = (where: string) => {
    if (nodes.length < 2) return;
    const boxes = nodes.map(box);
    const left = Math.min(...boxes.map((b) => b.x));
    const right = Math.max(...boxes.map((b) => b.x + b.w));
    const top = Math.min(...boxes.map((b) => b.y));
    const bottom = Math.max(...boxes.map((b) => b.y + b.h));
    const ops = nodes.map((node, index) => {
      const b = boxes[index]!;
      const props: Record<string, number> =
        where === "left" ? { x: left }
        : where === "right" ? { x: right - b.w }
        : where === "center" ? { x: (left + right) / 2 - b.w / 2 }
        : where === "top" ? { y: top }
        : where === "bottom" ? { y: bottom - b.h }
        : { y: (top + bottom) / 2 - b.h / 2 };
      return { op: "set_props", element_id: node.id, props };
    });
    props.edit(ops);
  };
  return (
    <>
      <header className="ed2-ins-header">
        <span className="ed2-muted">Selection</span>
        <span>{props.selection.length} layers</span>
      </header>
      <Section title="Alignment" testid="ins-alignment">
        <div className="ed2-align">
          {[...ALIGN_X, ...ALIGN_Y].map((option) => (
            <button key={option.value} type="button" className="ed2-chip" data-testid={`align-many-${option.value}`} disabled={nodes.length < 2} onClick={() => align(option.value)}>
              {option.label}
            </button>
          ))}
        </div>
      </Section>
      <ArrangeSection
        selection={props.selection}
        nodes={new Map(props.selection.flatMap((id) => { const item = props.byId.get(id); return item ? [[id, item.entity] as const] : []; }))}
        edit={props.edit}
      />
    </>
  );
}

const EASING_OPTIONS = NAMED_EASINGS.map((value) => ({ value, label: title(value) }));

function InterpolationSection(props: Props & { keyframe: Entity; owner: Entity | null }) {
  const { keyframe } = props;
  const easing = (keyframe.easing as string | undefined) ?? "linear";
  const named = (NAMED_EASINGS as readonly string[]).includes(easing);
  const edit = (values: Record<string, unknown>) =>
    props.edit([{ op: "set_props", element_id: keyframe.id!, props: values }]);
  return (
    <>
      <header className="ed2-ins-header">
        <span className="ed2-muted">Keyframe</span>
        <span>{props.owner ? labelOf(props.owner) : ""}</span>
      </header>
      <Section title="Interpolation" testid="ins-interpolation">
        <Row label="Easing">
          <SelectField
            label="Easing"
            testid="ins-easing"
            value={named ? easing : "custom"}
            options={[...EASING_OPTIONS, ...(named ? [] : [{ value: "custom", label: easing }])]}
            onChange={(value) => value !== "custom" && edit({ easing: value === "linear" ? null : value })}
          />
        </Row>
        <Row label="Time">
          <NumberField label="Time" value={Number(keyframe.time ?? 0)} step={0.01} unit="s" onCommit={(value) => props.edit([{ op: "move_keyframe", keyframe_id: keyframe.id, time: value }])} />
        </Row>
        {typeof keyframe.value === "number" ? (
          <Row label="Value">
            <NumberField label="Value" value={keyframe.value} step={0.01} onCommit={(value) => edit({ value })} />
          </Row>
        ) : (
          <Row label="Value">
            <ColorField value={String(keyframe.value ?? "#000000")} onCommit={(value) => edit({ value })} />
          </Row>
        )}
      </Section>
    </>
  );
}

export type { Props as InspectorProps };
