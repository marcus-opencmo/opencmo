"use client";

/**
 * Tham số của effect chỉnh màu (E3, học hành vi tab Adjust của Palmier): đường cong
 * RGB / theo hue, ba bánh xe Lift–Gamma–Gain, chroma key có ống hút màu, và các thanh
 * phụ của glow/grain/motion blur/vignette. Mọi thay đổi đi qua `set_props` trên
 * `effect.params` — cùng đường ghi với agent.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { ColorField, NumberField, Row, Segmented, SelectField } from "./controls";
import { setProps, type Entity, type InspectorContext } from "./shared";

type Point = [number, number];
type Params = Record<string, unknown>;

const paramsOf = (effect: Entity): Params => (effect.params as Params | undefined) ?? {};

/** Ghi một khoá của `params`; `undefined` là bỏ khoá (về mặc định). */
function writeParam(ctx: InspectorContext, effect: Entity, key: string, value: unknown, preview = false) {
  const next: Params = { ...paramsOf(effect) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  setProps(ctx, effect, { params: Object.keys(next).length ? next : null }, preview);
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const round3 = (value: number) => Math.round(value * 1000) / 1000;

// ------------------------------------------------------------------ đường cong

const CURVE_CHANNELS = [
  { value: "master", label: "RGB", color: "#e8e8e8" },
  { value: "red", label: "R", color: "#ff5a5a" },
  { value: "green", label: "G", color: "#4fd17a" },
  { value: "blue", label: "B", color: "#5a8dff" },
] as const;
const HUE_CHANNELS = [
  { value: "hue", label: "Hue", color: "#f0c040" },
  { value: "sat", label: "Sat", color: "#e070e0" },
  { value: "lum", label: "Luma", color: "#e8e8e8" },
] as const;

const SIZE = 180;
const PAD = 6;

/**
 * Ô vẽ đường cong: nhấp để thêm điểm, kéo để dời, nhấp đúp để xoá. `hue`: trục x là
 * vòng màu (nối vòng), trục y là chỉnh −1…1 quanh đường giữa.
 */
function CurveBox({
  points,
  mode,
  color,
  onChange,
  testid,
}: {
  points: Point[];
  mode: "tone" | "hue";
  color: string;
  onChange: (points: Point[] | undefined, preview: boolean) => void;
  testid: string;
}) {
  const box = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<Point[] | null>(null);
  const drag = useRef<{ index: number; moved: boolean } | null>(null);
  const shown = draft ?? (points.length ? points : mode === "tone" ? [[0, 0], [1, 1]] : []);
  const toY = (y: number) => (mode === "tone" ? y : (y + 1) / 2);
  const fromY = (y: number) => (mode === "tone" ? y : y * 2 - 1);
  const px = (x: number) => PAD + x * (SIZE - 2 * PAD);
  const py = (y: number) => SIZE - PAD - toY(y) * (SIZE - 2 * PAD);
  const at = (event: ReactPointerEvent): Point => {
    const rect = box.current!.getBoundingClientRect();
    const x = clamp01((event.clientX - rect.left - PAD) / (rect.width - 2 * PAD));
    const y = clamp01(1 - (event.clientY - rect.top - PAD) / (rect.height - 2 * PAD));
    return [round3(x), round3(fromY(y))];
  };
  const sorted = (list: Point[]) => [...list].sort((a, b) => a[0] - b[0]);
  const path = (() => {
    if (!shown.length) return `M${px(0)},${py(0)} L${px(1)},${py(0)}`;
    const list = sorted(shown);
    const ends: Point[] = mode === "tone" ? list : [[0, list[0]![1]], ...list, [1, list.at(-1)![1]]];
    return ends.map(([x, y], i) => `${i ? "L" : "M"}${px(x)},${py(y)}`).join(" ");
  })();

  return (
    <svg
      ref={box}
      className="ed2-curve"
      data-testid={testid}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      width={SIZE}
      height={SIZE}
      onPointerDown={(event) => {
        // Điểm có sẵn tự bắt sự kiện (kéo); mọi chỗ khác của ô (nền, lưới, đường) là thêm điểm.
        if ((event.target as Element).classList.contains("ed2-curve-point")) return;
        const point = at(event);
        const next = sorted([...shown, point]).slice(0, 16);
        box.current!.setPointerCapture(event.pointerId);
        drag.current = { index: next.findIndex((p) => p === point), moved: true };
        setDraft(next);
        onChange(next, true);
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d || !draft) return;
        const next = draft.slice();
        next[d.index] = at(event);
        d.moved = true;
        setDraft(next);
        onChange(next, true);
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d && draft) onChange(sorted(draft), false);
        setDraft(null);
      }}
    >
      <rect className="ed2-curve-bg" x={0} y={0} width={SIZE} height={SIZE} />
      {[0.25, 0.5, 0.75].map((t) => (
        <g key={t} className="ed2-curve-grid">
          <line x1={px(t)} x2={px(t)} y1={PAD} y2={SIZE - PAD} />
          <line y1={PAD + t * (SIZE - 2 * PAD)} y2={PAD + t * (SIZE - 2 * PAD)} x1={PAD} x2={SIZE - PAD} />
        </g>
      ))}
      {mode === "tone" ? <line className="ed2-curve-diag" x1={px(0)} y1={py(0)} x2={px(1)} y2={py(1)} /> : null}
      <path d={path} fill="none" stroke={color} strokeWidth={1.6} />
      {shown.map(([x, y], index) => (
        <circle
          key={index}
          cx={px(x)}
          cy={py(y)}
          r={4.5}
          className="ed2-curve-point"
          data-testid={`${testid}-point-${index}`}
          onPointerDown={(event) => {
            event.stopPropagation();
            box.current!.setPointerCapture(event.pointerId);
            drag.current = { index, moved: false };
            setDraft(shown.slice());
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            const next = shown.filter((_, i) => i !== index);
            onChange(next.length >= (mode === "tone" ? 2 : 1) ? next : undefined, false);
          }}
        />
      ))}
    </svg>
  );
}

function CurvesFields({ ctx, effect, index, mode }: { ctx: InspectorContext; effect: Entity; index: number; mode: "tone" | "hue" }) {
  const channels = mode === "tone" ? CURVE_CHANNELS : HUE_CHANNELS;
  const [channel, setChannel] = useState<string>(channels[0].value);
  const option = channels.find((item) => item.value === channel) ?? channels[0];
  const params = paramsOf(effect);
  const points = (params[channel] as Point[] | undefined) ?? [];
  return (
    <div className="ed2-adjust-block">
      <Segmented
        label={mode === "tone" ? "Curve channel" : "Hue curve"}
        value={channel}
        options={channels.map(({ value, label }) => ({ value, label }))}
        onChange={(value) => setChannel(value)}
      />
      <CurveBox
        points={points}
        mode={mode}
        color={option.color}
        testid={`effect-${index}-curve`}
        onChange={(next, preview) => writeParam(ctx, effect, channel, next, preview)}
      />
      <p className="ed2-hint">Click to add a point, drag to move, double-click to remove.</p>
      {points.length ? (
        <button type="button" className="ed2-link" onClick={() => writeParam(ctx, effect, channel, undefined)}>
          Reset {option.label}
        </button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ bánh xe màu

/** Màu thuần ở góc `angle` (độ) trừ trung bình — offset RGB không đổi độ sáng. */
function hueOffset(angle: number): [number, number, number] {
  const channel = (shift: number) => Math.max(0, Math.min(1, Math.abs((((angle / 60 + shift) % 6) + 6) % 6 - 3) - 1));
  const rgb: [number, number, number] = [channel(0), channel(4), channel(2)];
  const mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
  return [rgb[0] - mean, rgb[1] - mean, rgb[2] - mean];
}

/** Chiếu offset RGB lên mặt phẳng màu (đỏ ở 0°, y hướng lên). */
const project = (r: number, g: number, b: number): [number, number] => [r - (g + b) / 2, (Math.sqrt(3) / 2) * (g - b)];

/**
 * Ngược lại của `tripleAt`: offset RGB → vị trí núm (−1…1) và độ sáng chung. Độ dài
 * chiếu của `hueOffset` đổi theo góc (lục giác RGB), nên chia cho độ dài ở đúng góc đó.
 */
function readWheel(triple: number[] | undefined): { x: number; y: number; master: number } {
  const [r, g, b] = triple ?? [0, 0, 0];
  const master = (r! + g! + b!) / 3;
  const [px, py] = project(r! - master, g! - master, b! - master);
  const length = Math.hypot(px, py);
  if (length < 1e-6) return { x: 0, y: 0, master };
  const angle = Math.atan2(py, px);
  const [ux, uy] = project(...(hueOffset((angle * 180) / Math.PI).map((value) => value * 0.75) as [number, number, number]));
  const amount = Math.min(1, length / Math.max(1e-6, Math.hypot(ux, uy)));
  return { x: Math.cos(angle) * amount, y: -Math.sin(angle) * amount, master };
}

const WHEEL = 96;

function ColorWheel({ label, triple, onChange, testid }: { label: string; triple: number[] | undefined; onChange: (triple: [number, number, number] | undefined, preview: boolean) => void; testid: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { x, y, master } = readWheel(triple);
  const dragging = useRef(false);
  const tripleAt = (event: ReactPointerEvent, base: number): [number, number, number] => {
    const rect = ref.current!.getBoundingClientRect();
    let dx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    let dy = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    const length = Math.hypot(dx, dy);
    if (length > 1) {
      dx /= length;
      dy /= length;
    }
    const angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
    const amount = Math.min(1, Math.hypot(dx, dy));
    const offset = hueOffset(angle);
    // Mép bánh xe = kênh chính +0.5, hai kênh kia −0.25: đủ mạnh mà không cháy màu ngay.
    return offset.map((value) => round3(base + value * amount * 0.75)) as [number, number, number];
  };
  return (
    <div className="ed2-wheel-cell" data-testid={testid}>
      <div
        ref={ref}
        className="ed2-wheel"
        style={{ width: WHEEL, height: WHEEL }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragging.current = true;
          onChange(tripleAt(event, master), true);
        }}
        onPointerMove={(event) => {
          if (dragging.current) onChange(tripleAt(event, master), true);
        }}
        onPointerUp={(event) => {
          if (!dragging.current) return;
          dragging.current = false;
          onChange(tripleAt(event, master), false);
        }}
        onDoubleClick={() => onChange(master ? [master, master, master] : undefined, false)}
      >
        <span className="ed2-wheel-puck" style={{ left: `${50 + x * 50}%`, top: `${50 + y * 50}%` }} />
      </div>
      <div className="ed2-wheel-label">{label}</div>
      <NumberField
        label="Y"
        value={master}
        step={1}
        scale={100}
        min={-100}
        max={100}
        unit="%"
        testid={`${testid}-master`}
        onCommit={(next) => {
          const [r, g, b] = triple ?? [0, 0, 0];
          const delta = next - master;
          const moved = [r! + delta, g! + delta, b! + delta].map(round3) as [number, number, number];
          onChange(moved.every((value) => value === 0) ? undefined : moved, false);
        }}
      />
    </div>
  );
}

function WheelsFields({ ctx, effect, index }: { ctx: InspectorContext; effect: Entity; index: number }) {
  const params = paramsOf(effect);
  return (
    <div className="ed2-wheels">
      {(["lift", "gamma", "gain"] as const).map((key) => (
        <ColorWheel
          key={key}
          label={key === "lift" ? "Lift" : key === "gamma" ? "Gamma" : "Gain"}
          triple={params[key] as number[] | undefined}
          testid={`effect-${index}-${key}`}
          onChange={(triple, preview) => writeParam(ctx, effect, key, triple, preview)}
        />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ chroma key

type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> };

function ChromaKeyFields({ ctx, effect, index }: { ctx: InspectorContext; effect: Entity; index: number }) {
  const params = paramsOf(effect);
  const color = typeof params.color === "string" ? params.color : "#00FF00";
  const Dropper = typeof window !== "undefined" ? (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper : undefined;
  return (
    <>
      <Row label="Key color">
        <ColorField
          label="Key color"
          testid={`effect-${index}-key-color`}
          value={color}
          onCommit={(value) => writeParam(ctx, effect, "color", value.slice(0, 7).toUpperCase())}
        />
        {Dropper ? (
          <button
            type="button"
            className="ed2-icon-btn"
            aria-label="Pick key color from the preview"
            title="Pick from the preview"
            onClick={() =>
              new Dropper()
                .open()
                .then((result) => writeParam(ctx, effect, "color", result.sRGBHex.slice(0, 7).toUpperCase()))
                .catch(() => undefined)
            }
          >
            ⌖
          </button>
        ) : null}
      </Row>
      <ParamNum ctx={ctx} effect={effect} param="spill" label="Spill" fallback={0.5} />
    </>
  );
}

// ------------------------------------------------------------------ thanh phụ

function ParamNum({
  ctx,
  effect,
  param,
  label,
  fallback,
  unit = "%",
  scale = 100,
  min = 0,
  max = 100,
  step = 1,
}: {
  ctx: InspectorContext;
  effect: Entity;
  param: string;
  label: string;
  fallback: number;
  unit?: string;
  scale?: number;
  min?: number;
  max?: number;
  step?: number;
}) {
  const value = typeof paramsOf(effect)[param] === "number" ? (paramsOf(effect)[param] as number) : fallback;
  return (
    <Row label={label}>
      <NumberField
        label={unit}
        value={value}
        unit={undefined}
        scale={scale}
        step={step}
        min={min}
        max={max}
        testid={`ins-param-${param}`}
        onCommit={(next) => writeParam(ctx, effect, param, next === fallback ? undefined : next)}
        onPreview={(next) => writeParam(ctx, effect, param, next, true)}
      />
    </Row>
  );
}

/** LUT `.cube` (E3-c): chọn từ file `.cube` đã nhập vào thư viện (tab Media). */
function LutFields({ ctx, effect, index }: { ctx: InspectorContext; effect: Entity; index: number }) {
  const luts = (ctx.manifest?.assets ?? []).filter((asset) => asset.type === "LUT" && asset.path);
  const current = typeof paramsOf(effect).src === "string" ? (paramsOf(effect).src as string) : "";
  if (!luts.length) {
    return <p className="ed2-hint" data-testid={`effect-${index}-lut-empty`}>Import a 3D .cube LUT in Media, then pick it here.</p>;
  }
  return (
    <Row label="LUT">
      <SelectField
        label="LUT file"
        testid={`effect-${index}-lut`}
        value={current}
        options={[{ value: "", label: "Choose a LUT…" }, ...luts.map((asset) => ({ value: asset.path!, label: asset.path!.split("/").pop()! }))]}
        onChange={(value) => writeParam(ctx, effect, "src", value || undefined)}
      />
    </Row>
  );
}

/** Ô tham số riêng của loại effect (null khi loại chỉ có một giá trị). */
export function EffectParams({ ctx, effect, index }: { ctx: InspectorContext; effect: Entity; index: number }) {
  switch (effect.type) {
    case "curves":
      return <CurvesFields ctx={ctx} effect={effect} index={index} mode="tone" />;
    case "hueCurves":
      return <CurvesFields ctx={ctx} effect={effect} index={index} mode="hue" />;
    case "wheels":
      return <WheelsFields ctx={ctx} effect={effect} index={index} />;
    case "chromaKey":
      return <ChromaKeyFields ctx={ctx} effect={effect} index={index} />;
    case "lut":
      return <LutFields ctx={ctx} effect={effect} index={index} />;
    case "glow":
      return (
        <>
          <ParamNum ctx={ctx} effect={effect} param="threshold" label="Threshold" fallback={0.7} />
          <ParamNum ctx={ctx} effect={effect} param="radius" label="Radius" fallback={0.3} />
          <ParamNum ctx={ctx} effect={effect} param="warmth" label="Warmth" fallback={0.3} />
        </>
      );
    case "grain":
      return <ParamNum ctx={ctx} effect={effect} param="size" label="Size" fallback={1} unit="px" scale={1} min={1} max={4} />;
    case "motionBlur":
      return <ParamNum ctx={ctx} effect={effect} param="angle" label="Angle" fallback={0} unit="°" scale={1} min={-180} max={180} />;
    case "vignette":
      return (
        <>
          <ParamNum ctx={ctx} effect={effect} param="midpoint" label="Midpoint" fallback={0.5} />
          <ParamNum ctx={ctx} effect={effect} param="roundness" label="Roundness" fallback={1} />
          <ParamNum ctx={ctx} effect={effect} param="feather" label="Feather" fallback={0.5} />
        </>
      );
    default:
      return null;
  }
}

// ------------------------------------------------------------------ scopes

type ScopeKind = "histogram" | "waveform" | "vectorscope";
const SCOPE_W = 220;
const SCOPE_H = 120;

/** Vẽ một scope từ pixel khung (đã nhỏ ≤ 256 px) lên canvas 2D của panel. */
function drawScope(canvas: HTMLCanvasElement, image: ImageData, kind: ScopeKind) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.fillStyle = "#0d0d0f";
  ctx.fillRect(0, 0, width, height);
  const data = image.data;
  if (kind === "histogram") {
    const bins = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
    for (let p = 0; p < data.length; p += 4) {
      if (data[p + 3]! < 8) continue;
      bins[0]![data[p]!]! += 1;
      bins[1]![data[p + 1]!]! += 1;
      bins[2]![data[p + 2]!]! += 1;
    }
    // Bỏ hai đầu khi tìm đỉnh: pixel bệt đen/cháy trắng không được ép phần còn lại thành đường phẳng.
    let peak = 1;
    for (const channel of bins) for (let v = 2; v < 254; v++) peak = Math.max(peak, channel[v]!);
    ctx.globalCompositeOperation = "lighter";
    ["rgba(255,70,70,0.55)", "rgba(70,220,110,0.55)", "rgba(80,130,255,0.55)"].forEach((color, index) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let v = 0; v < 256; v++) ctx.lineTo((v / 255) * width, height - Math.min(1, bins[index]![v]! / peak) * (height - 4));
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();
    });
    ctx.globalCompositeOperation = "source-over";
    return;
  }
  const out = ctx.getImageData(0, 0, width, height);
  const pixels = out.data;
  const plot = (x: number, y: number, r: number, g: number, b: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return;
    const i = (yi * width + xi) * 4;
    pixels[i] = Math.min(255, pixels[i]! + r);
    pixels[i + 1] = Math.min(255, pixels[i + 1]! + g);
    pixels[i + 2] = Math.min(255, pixels[i + 2]! + b);
  };
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const p = (y * image.width + x) * 4;
      if (data[p + 3]! < 8) continue;
      const R = data[p]! / 255;
      const G = data[p + 1]! / 255;
      const B = data[p + 2]! / 255;
      if (kind === "waveform") {
        const luma = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        plot((x / image.width) * width, (1 - luma) * (height - 1), 40, 60, 40);
      } else {
        const cb = -0.1146 * R - 0.3854 * G + 0.5 * B;
        const cr = 0.5 * R - 0.4542 * G - 0.0458 * B;
        const radius = height / 2 - 2;
        plot(width / 2 + cb * 2 * radius, height / 2 - cr * 2 * radius, 30 + R * 50, 30 + G * 50, 30 + B * 50);
      }
    }
  }
  ctx.putImageData(out, 0, 0);
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  if (kind === "vectorscope") {
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, height / 2 - 2, 0, Math.PI * 2);
    ctx.stroke();
    // Đường tông da (skin line) ở góc ~123° của vectorscope.
    ctx.beginPath();
    ctx.moveTo(width / 2, height / 2);
    ctx.lineTo(width / 2 + Math.cos((-123 * Math.PI) / 180) * (height / 2 - 2), height / 2 + Math.sin((-123 * Math.PI) / 180) * (height / 2 - 2));
    ctx.stroke();
  } else {
    for (const level of [0.25, 0.5, 0.75]) {
      ctx.beginPath();
      ctx.moveTo(0, level * height);
      ctx.lineTo(width, level * height);
      ctx.stroke();
    }
  }
}

/** Scopes của khung playhead (học Palmier `inspect_color`/scopes): vẽ lại khi khung hay document đổi. */
export function ScopesPanel({ ctx }: { ctx: InspectorContext }) {
  const [kind, setKind] = useState<ScopeKind>("histogram");
  const canvas = useRef<HTMLCanvasElement>(null);
  const { doc, frame } = ctx;
  // `sample` là hàm mới mỗi lần render: giữ trong ref, nếu không effect chạy lại và huỷ hẹn giờ liên tục.
  const sample = useRef(ctx.sample);
  sample.current = ctx.sample;
  const available = Boolean(ctx.sample);
  useEffect(() => {
    if (!available) return;
    const draw = () => {
      const image = sample.current?.();
      if (image && canvas.current) drawScope(canvas.current, image, kind);
    };
    // Hoãn một nhịp: kéo thanh trượt không phải vẽ lại scopes mỗi pixel. Vẽ lại lần nữa sau
    // khi khung video kịp giải mã (lần đầu mở tab, hoặc vừa tua).
    const first = setTimeout(draw, 120);
    const settle = setTimeout(draw, 700);
    return () => {
      clearTimeout(first);
      clearTimeout(settle);
    };
  }, [available, doc, frame, kind]);
  if (!available) return null;
  return (
    <div className="ed2-scopes" data-testid="ins-scopes">
      <Segmented
        label="Scope"
        value={kind}
        options={[
          { value: "histogram", label: "Histogram" },
          { value: "waveform", label: "Waveform" },
          { value: "vectorscope", label: "Vector" },
        ]}
        onChange={setKind}
      />
      <canvas ref={canvas} width={SCOPE_W} height={SCOPE_H} className="ed2-scope-canvas" aria-label={`${kind} of the current frame`} />
    </div>
  );
}
