"use client";

/**
 * Mục có danh sách thành phần phụ: fill, stroke, shadow, effect, animation,
 * mask. Thêm = `add_part` với đúng giá trị mặc định fork viết; xoá =
 * `delete_element`; lên/xuống = `move_part`.
 */

import { ANIMATION_TYPES } from "@opencmo/clip-doc";

import { EffectParams, ScopesPanel } from "./adjust";
import {
  AddButton,
  ColorField,
  EyeButton,
  NumberField,
  RemoveButton,
  Row,
  Section,
  SelectField,
} from "./controls";
import { BLEND_OPTIONS, diamond, Num, setProps, title, write, type Entity, type InspectorContext } from "./shared";

const list = (entity: Entity, key: string): Entity[] => (entity[key] as Entity[] | undefined) ?? [];

function add(ctx: InspectorContext, key: string, part: Record<string, unknown>) {
  ctx.edit([{ op: "add_part", element_id: ctx.node.id, key, part }]);
}
const remove = (ctx: InspectorContext, part: Entity) => ctx.edit([{ op: "delete_element", element_id: part.id }]);

function PartHead({
  ctx,
  part,
  index,
  count,
  children,
  testid,
  hideable = true,
  reversed = false,
}: {
  ctx: InspectorContext;
  part: Entity;
  index: number;
  count: number;
  children: React.ReactNode;
  testid: string;
  /** Fill, stroke, shadow, effect có `hidden`; animation thì không. */
  hideable?: boolean;
  /** Danh sách hiện ngược thứ tự file (`index` là vị trí trên màn hình). */
  reversed?: boolean;
}) {
  const moveTo = (row: number) => ctx.edit([{ op: "move_part", part_id: part.id, to: reversed ? count - 1 - row : row }]);
  return (
    <div className="ed2-part-head">
      <div className="ed2-part-main">{children}</div>
      {hideable ? (
        <EyeButton hidden={part.hidden === true} testid={`${testid}-hide`} onToggle={() => setProps(ctx, part, { hidden: !(part.hidden === true) })} />
      ) : null}
      <button
        type="button"
        className="ed2-toggle"
        aria-label="Move up"
        disabled={index === 0}
        onClick={() => moveTo(index - 1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="ed2-toggle"
        aria-label="Move down"
        disabled={index === count - 1}
        onClick={() => moveTo(index + 1)}
      >
        ↓
      </button>
      <RemoveButton label="Remove" testid={`${testid}-remove`} onClick={() => remove(ctx, part)} />
    </div>
  );
}

// ------------------------------------------------------------------ fill

const PAINT_TYPES = [
  { value: "solid", label: "Solid" },
  { value: "linearGradient", label: "Linear gradient" },
  { value: "radialGradient", label: "Radial gradient" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
] as const;

const DEFAULT_FILL = "#E0E0E0";

/** Đổi loại fill: giữ những gì còn nghĩa (độ mờ, blend, ẩn), viết lại phần của loại mới. */
function repaint(ctx: InspectorContext, paint: Entity, type: string) {
  const color = typeof paint.color === "string" ? paint.color : DEFAULT_FILL;
  const keep = { opacity: paint.opacity, blendMode: paint.blendMode, hidden: paint.hidden };
  const next: Record<string, unknown> =
    type === "solid"
      ? { type, color }
      : type === "linearGradient" || type === "radialGradient"
        ? { type, stops: [{ offset: 0, color }, { offset: 1, color: "#000000" }] }
        : { type, src: (ctx.manifest?.assets ?? []).find((asset) => asset.type === type.toUpperCase() && !asset.state)?.path ?? "" };
  if ((type === "image" || type === "video") && !next.src) return;
  const at = list(ctx.node, "paints").indexOf(paint);
  ctx.edit([
    { op: "delete_element", element_id: paint.id },
    { op: "add_part", element_id: ctx.node.id, key: "paints", index: at, part: Object.fromEntries(Object.entries({ ...next, ...keep }).filter(([, value]) => value !== undefined)) },
  ]);
}

export function FillsSection({ ctx }: { ctx: InspectorContext }) {
  const paints = list(ctx.node, "paints");
  // Như fork: hàng trên cùng là fill vẽ trên cùng, tức phần tử CUỐI của file.
  const rows = paints.map((paint, at) => ({ paint, at })).reverse();
  return (
    <Section
      title="Fill"
      testid="ins-fills"
      action={<AddButton label="Add fill" testid="add-fill" onClick={() => add(ctx, "paints", { type: "solid", color: DEFAULT_FILL })} />}
    >
      {ctx.node.kind === "rect" || ctx.node.kind === "path" ? (
        <Row label="Base">
          <ColorField
            value={String(ctx.node.fill ?? "#FFFFFF")}
            testid="ins-rect-fill"
            diamond={diamond(ctx, ctx.node, "color", String(ctx.node.fill ?? "#FFFFFF"))}
            // Track `color` của rect là track của `fill`: có track thì ghi keyframe.
            onCommit={(value) =>
              ((ctx.node.tracks as Entity[] | undefined) ?? []).some((track) => track.property === "color")
                ? write(ctx, ctx.node, "color", value)
                : setProps(ctx, ctx.node, { fill: value })
            }
          />
        </Row>
      ) : null}
      {rows.map(({ paint, at }, index) => (
        <div key={paint.id ?? index} className="ed2-part" data-testid={`fill-${index}`}>
          <PartHead ctx={ctx} part={paint} index={paints.length - 1 - at} count={paints.length} testid={`fill-${index}`} reversed>
            <SelectField
              label="Fill type"
              value={String(paint.type)}
              options={PAINT_TYPES}
              onChange={(value) => repaint(ctx, paint, value)}
            />
          </PartHead>
          {paint.type === "solid" ? (
            <Row label="Color">
              <ColorField
                value={String(paint.color)}
                testid={`fill-${index}-color`}
                diamond={diamond({ ...ctx }, paint, "color", String(paint.color))}
                onCommit={(value) => write(ctx, paint, "color", value)}
              />
            </Row>
          ) : null}
          {paint.type === "linearGradient" || paint.type === "radialGradient" ? <Stops ctx={ctx} paint={paint} /> : null}
          {paint.type === "image" || paint.type === "video" ? (
            <Row label="File">
              <SelectField
                label="Fill file"
                value={typeof paint.src === "string" ? paint.src : ""}
                options={[
                  ...(typeof paint.src === "string" ? [{ value: paint.src, label: paint.src.replace(/^assets\//, "") }] : [{ value: "", label: "Generated" }]),
                  ...(ctx.manifest?.assets ?? [])
                    .filter((asset) => asset.type === String(paint.type).toUpperCase() && !asset.state && asset.path !== paint.src)
                    .map((asset) => ({ value: String(asset.path), label: String(asset.path) })),
                ]}
                onChange={(value) => value && setProps(ctx, paint, { src: value })}
              />
            </Row>
          ) : null}
          <Row label="Opacity">
            <Num ctx={ctx} holder={paint} prop="opacity" label="%" fallback={1} scale={100} step={1} min={0} max={100} />
            <SelectField
              label="Fill blend mode"
              value={(paint.blendMode as string | undefined) ?? "sourceOver"}
              options={BLEND_OPTIONS}
              onChange={(value) => setProps(ctx, paint, { blendMode: value === "sourceOver" ? null : value })}
            />
          </Row>
        </div>
      ))}
    </Section>
  );
}

function Stops({ ctx, paint }: { ctx: InspectorContext; paint: Entity }) {
  const stops = list(paint, "stops");
  return (
    <>
      <Row label="Angle">
        <NumberField label="°" value={Number(paint.rotation ?? 0)} onCommit={(value) => setProps(ctx, paint, { rotation: value || null })} />
      </Row>
      {stops.map((stop, index) => (
        <Row key={stop.id ?? index} label={`Stop ${index + 1}`}>
          <NumberField
            label="%"
            value={Number(stop.offset ?? 0)}
            scale={100}
            step={1}
            min={0}
            max={100}
            onCommit={(value) => setProps(ctx, stop, { offset: value })}
          />
          <ColorField value={String(stop.color)} onCommit={(value) => setProps(ctx, stop, { color: value })} />
          {stops.length > 2 ? <RemoveButton label="Remove stop" onClick={() => remove(ctx, stop)} /> : null}
        </Row>
      ))}
      <Row label="">
        <button
          type="button"
          className="ed2-link"
          onClick={() => ctx.edit([{ op: "add_part", element_id: paint.id, key: "stops", part: { offset: 0.5, color: "#808080" } }])}
        >
          Add stop
        </button>
      </Row>
    </>
  );
}

// ------------------------------------------------------------------ stroke, shadow

const JOINS = ["miter", "round", "bevel"].map((value) => ({ value, label: title(value) }));
const CAPS = ["butt", "round", "square"].map((value) => ({ value, label: title(value) }));

export function StrokesSection({ ctx }: { ctx: InspectorContext }) {
  const strokes = list(ctx.node, "strokes");
  return (
    <Section
      title="Stroke"
      testid="ins-strokes"
      action={<AddButton label="Add stroke" testid="add-stroke" onClick={() => add(ctx, "strokes", { color: "#000000" })} />}
    >
      {strokes.map((stroke, index) => (
        <div key={stroke.id ?? index} className="ed2-part" data-testid={`stroke-${index}`}>
          <PartHead ctx={ctx} part={stroke} index={index} count={strokes.length} testid={`stroke-${index}`}>
            <ColorField value={String(stroke.color)} onCommit={(value) => write(ctx, stroke, "color", value)} diamond={diamond(ctx, stroke, "color", String(stroke.color))} />
          </PartHead>
          <Row label="Width">
            <NumberField label="W" value={Number(stroke.width ?? 1)} min={0} step={0.5} testid={`stroke-${index}-width`} onCommit={(value) => setProps(ctx, stroke, { width: value === 1 ? null : value })} />
            <Num ctx={ctx} holder={stroke} prop="opacity" label="%" fallback={1} scale={100} step={1} min={0} max={100} />
          </Row>
          <Row label="Join">
            <SelectField label="Stroke join" value={(stroke.join as string | undefined) ?? "miter"} options={JOINS} onChange={(value) => setProps(ctx, stroke, { join: value === "miter" ? null : value })} />
            <SelectField label="Stroke cap" value={(stroke.cap as string | undefined) ?? "butt"} options={CAPS} onChange={(value) => setProps(ctx, stroke, { cap: value === "butt" ? null : value })} />
          </Row>
        </div>
      ))}
    </Section>
  );
}

export function ShadowsSection({ ctx }: { ctx: InspectorContext }) {
  const shadows = list(ctx.node, "shadows");
  return (
    <Section
      title="Shadow"
      testid="ins-shadows"
      action={
        <AddButton
          label="Add shadow"
          testid="add-shadow"
          onClick={() => add(ctx, "shadows", { color: "#000000", opacity: 0.25, blur: 4, offsetY: 4 })}
        />
      }
    >
      {shadows.map((shadow, index) => (
        <div key={shadow.id ?? index} className="ed2-part" data-testid={`shadow-${index}`}>
          <PartHead ctx={ctx} part={shadow} index={index} count={shadows.length} testid={`shadow-${index}`}>
            <ColorField value={String(shadow.color)} onCommit={(value) => write(ctx, shadow, "color", value)} diamond={diamond(ctx, shadow, "color", String(shadow.color))} />
          </PartHead>
          <Row label="Offset">
            <Num ctx={ctx} holder={shadow} prop="offsetX" label="X" fallback={0} />
            <Num ctx={ctx} holder={shadow} prop="offsetY" label="Y" fallback={0} />
          </Row>
          <Row label="Blur">
            <Num ctx={ctx} holder={shadow} prop="blur" label="B" fallback={0} min={0} />
            <Num ctx={ctx} holder={shadow} prop="opacity" label="%" fallback={1} scale={100} step={1} min={0} max={100} />
          </Row>
        </div>
      ))}
    </Section>
  );
}

// ------------------------------------------------------------------ effect

const EFFECTS = [
  { value: "blur", label: "Layer Blur", unit: "px", initial: 8 },
  { value: "brightness", label: "Brightness", unit: "amount", initial: 0.8 },
  { value: "contrast", label: "Contrast", unit: "amount", initial: 0.8 },
  { value: "grayscale", label: "Grayscale", unit: "amount", initial: 0.5 },
  { value: "hueRotate", label: "Hue Rotation", unit: "deg", initial: 100 },
  { value: "invert", label: "Invert", unit: "amount", initial: 0.5 },
  { value: "saturate", label: "Saturate", unit: "amount", initial: 0.8 },
  { value: "sepia", label: "Sepia", unit: "amount", initial: 0.5 },
  // Chỉnh màu (học Palmier §C5): exposure theo stop, các cái khác −100…100%.
  { value: "exposure", label: "Exposure", unit: "stops", initial: 0.5 },
  { value: "vibrance", label: "Vibrance", unit: "amount", initial: 0.3 },
  { value: "temperature", label: "Temperature", unit: "amount", initial: 0.3 },
  { value: "tint", label: "Tint", unit: "amount", initial: 0.2 },
  { value: "vignette", label: "Vignette", unit: "amount", initial: 0.5 },
  // E3 (học Palmier Adjust): chỉnh trên pixel ở `clip-render/src/grade.ts`.
  { value: "highlights", label: "Highlights", unit: "amount", initial: -0.3 },
  { value: "shadows", label: "Shadows", unit: "amount", initial: 0.3 },
  { value: "whites", label: "Whites", unit: "amount", initial: 0.2 },
  { value: "blacks", label: "Blacks", unit: "amount", initial: -0.2 },
  { value: "saturation", label: "Saturation", unit: "amount", initial: 0.2 },
  { value: "curves", label: "Curves", unit: "strength", initial: 1 },
  { value: "wheels", label: "Color Wheels", unit: "strength", initial: 1 },
  { value: "hueCurves", label: "Hue Curves", unit: "strength", initial: 1 },
  { value: "clarity", label: "Clarity", unit: "amount", initial: 0.3 },
  { value: "dehaze", label: "Dehaze", unit: "amount", initial: 0.3 },
  { value: "sharpen", label: "Sharpen", unit: "amount", initial: 0.4 },
  { value: "grain", label: "Film Grain", unit: "amount", initial: 0.3 },
  { value: "glow", label: "Glow", unit: "amount", initial: 0.5 },
  { value: "chromaKey", label: "Chroma Key", unit: "range", initial: 0.4 },
  { value: "motionBlur", label: "Motion Blur", unit: "amount", initial: 0.4 },
  { value: "lut", label: "LUT (.cube)", unit: "strength", initial: 1 },
] as const;

export function EffectsSection({ ctx }: { ctx: InspectorContext }) {
  const effects = list(ctx.node, "effects");
  return (
    <Section
      title="Effects"
      testid="ins-effects"
      action={<AddButton label="Add effect" testid="add-effect" onClick={() => add(ctx, "effects", { type: "blur", value: 8 })} />}
    >
      {["video", "image", "rect"].includes(String(ctx.node.kind)) ? <ScopesPanel ctx={ctx} /> : null}
      {effects.map((effect, index) => {
        const option = EFFECTS.find((item) => item.value === effect.type) ?? EFFECTS[0];
        return (
          <div key={effect.id ?? index} className="ed2-part" data-testid={`effect-${index}`}>
            <PartHead ctx={ctx} part={effect} index={index} count={effects.length} testid={`effect-${index}`}>
              <SelectField
                label="Effect"
                testid={`effect-${index}-type`}
                value={String(effect.type)}
                options={EFFECTS}
                // Đổi loại thì giá trị về mặc định của loại mới: 8 px blur không phải 8 độ.
                onChange={(value) => setProps(ctx, effect, { type: value, value: EFFECTS.find((item) => item.value === value)!.initial, params: null })}
              />
            </PartHead>
            <Row label={option.unit === "strength" ? "Strength" : option.unit === "range" ? "Range" : "Value"}>
              <Num
                ctx={ctx}
                holder={effect}
                prop="value"
                label={option.unit === "px" ? "px" : option.unit === "deg" ? "°" : option.unit === "stops" ? "EV" : "%"}
                fallback={option.initial}
                scale={option.unit === "px" || option.unit === "deg" || option.unit === "stops" ? 1 : 100}
                step={option.unit === "stops" ? 0.1 : 1}
                keepDefault
              />
            </Row>
            <EffectParams ctx={ctx} effect={effect} index={index} />
          </div>
        );
      })}
    </Section>
  );
}

// ------------------------------------------------------------------ animation

const ANIMATION_LABEL: Record<string, string> = {
  fade: "Fade",
  slideLeft: "Slide left",
  slideRight: "Slide right",
  slideUp: "Slide up",
  slideDown: "Slide down",
  grow: "Grow",
  shrink: "Shrink",
  spin: "Spin",
  twist: "Twist",
  blur: "Blur",
  appearWord: "Appear word",
  appearChar: "Appear character",
  scramble: "Scramble",
  gain: "Volume",
  pop: "Pop",
  typewriter: "Typewriter",
  wordSlide: "Word slide",
  highlightPop: "Highlight word",
};
const TEXT_ONLY = new Set(["appearWord", "appearChar", "scramble", "typewriter", "wordSlide", "highlightPop"]);
/** Animation theo từ (E4): thời lượng mặc định = số từ × giây mỗi từ. */
const PER_WORD = new Set(["typewriter", "wordSlide", "highlightPop"]);

export function AnimationsSection({ ctx }: { ctx: InspectorContext }) {
  const animations = list(ctx.node, "animations");
  const kind = ctx.node.kind as string;
  // Nhóm chữ chỉ cho text/phụ đề, nhóm tiếng chỉ cho thứ có tiếng — như fork.
  const options = ANIMATION_TYPES.filter(
    (type) => (!TEXT_ONLY.has(type) || kind === "text" || kind === "captions") && (type !== "gain" || kind === "video" || kind === "audio"),
  ).map((value) => ({ value, label: ANIMATION_LABEL[value] ?? value }));
  return (
    <Section
      title="Animations"
      testid="ins-animations"
      action={<AddButton label="Add animation" testid="add-animation" onClick={() => add(ctx, "animations", { type: "fade" })} />}
    >
      {animations.map((animation, index) => (
        <div key={animation.id ?? index} className="ed2-part" data-testid={`animation-${index}`}>
          <PartHead ctx={ctx} part={animation} index={index} count={animations.length} testid={`animation-${index}`} hideable={false}>
            <SelectField
              label="Animation"
              testid={`animation-${index}-type`}
              value={String(animation.type)}
              options={options}
              onChange={(value) => setProps(ctx, animation, { type: value })}
            />
          </PartHead>
          <Row label="Phase">
            <SelectField
              label="Animation phase"
              testid={`animation-${index}-phase`}
              value={(animation.phase as string | undefined) ?? "in"}
              options={[{ value: "in", label: "In" }, { value: "out", label: "Out" }]}
              onChange={(value) => setProps(ctx, animation, { phase: value === "in" ? null : value })}
            />
          </Row>
          <Row label="Timing">
            <NumberField label="Dur" value={Number(animation.duration ?? 1)} step={0.1} min={0} unit="s" onCommit={(value) => setProps(ctx, animation, { duration: value })} />
            <NumberField label="Delay" value={Number(animation.delay ?? 0)} step={0.1} min={0} unit="s" onCommit={(value) => setProps(ctx, animation, { delay: value || null })} />
          </Row>
          {PER_WORD.has(String(animation.type)) ? (
            <Row label="Per word">
              <NumberField
                label="Each"
                testid={`animation-${index}-perWord`}
                value={Number(animation.perWord ?? 0.2)}
                step={0.05}
                min={0.05}
                max={2}
                unit="s"
                onCommit={(value) => setProps(ctx, animation, { perWord: value === 0.2 ? null : value })}
              />
            </Row>
          ) : null}
          {animation.type === "highlightPop" ? (
            <Row label="Highlight">
              <ColorField label="Highlight color" value={String(animation.color ?? "#FFD900")} onCommit={(value) => setProps(ctx, animation, { color: value })} />
            </Row>
          ) : null}
        </div>
      ))}
    </Section>
  );
}

// ------------------------------------------------------------------ mask

function nextMaskName(ctx: InspectorContext): string {
  let max = 0;
  const visit = (entity: Entity) => {
    const match = typeof entity.name === "string" ? /^Mask (\d+)$/.exec(entity.name) : null;
    if (match) max = Math.max(max, Number(match[1]));
    for (const key of ["children", "masks"]) list(entity, key).forEach(visit);
  };
  ctx.doc.stage.children.forEach((node) => visit(node as unknown as Entity));
  return `Mask ${max + 1}`;
}

export function MasksSection({ ctx }: { ctx: InspectorContext }) {
  const masks = list(ctx.node, "masks");
  const width = Math.round(Number(ctx.node.width ?? 0));
  const height = Math.round(Number(ctx.node.height ?? 0));
  return (
    <Section
      title="Masks"
      testid="ins-masks"
      action={
        <AddButton
          label="Add mask"
          testid="add-mask"
          onClick={() =>
            add(ctx, "masks", {
              kind: "rect",
              name: nextMaskName(ctx),
              x: 20,
              y: 20,
              ...(width > 0 && height > 0 ? { width, height } : {}),
            })
          }
        />
      }
    >
      {masks.map((mask, index) => (
        <div key={mask.id ?? index} className="ed2-part-head" data-testid={`mask-${index}`}>
          <button type="button" className="ed2-link ed2-part-main" onClick={() => mask.id && ctx.select([mask.id])}>
            {String(mask.name ?? `Mask ${index + 1}`)}
          </button>
          <RemoveButton label="Remove mask" testid={`mask-${index}-remove`} onClick={() => remove(ctx, mask)} />
        </div>
      ))}
    </Section>
  );
}
