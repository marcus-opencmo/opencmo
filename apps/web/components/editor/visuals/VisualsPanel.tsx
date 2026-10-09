"use client";

/**
 * Bảng Visuals (spec visuals V3): chèn visual giải thích mà không cần agent —
 * mũi tên/khoanh/gạch chân, diagram, biểu đồ, đồ thị, cảnh 3D. Mỗi nút là MỘT
 * op của editor-core (cùng op agent gọi), đặt ở playhead, dài 4 giây.
 *
 * Chọn sẵn một visual trên canvas thì bảng mở ở chế độ sửa: đổi nhãn/số/công
 * thức rồi "Update" là `update_visual` — sinh lại tại chỗ, giữ id và thời gian.
 */

import { useEffect, useState } from "react";

import { findIcons, iconPath, type IconMatch } from "@opencmo/clip-icons";
import { EMOJI_PACK, findLotties, LOTTIE_PACK, STUDIO_MODEL } from "@opencmo/editor-core";
import { PRODUCTS, THEMES, TEMPLATES } from "@opencmo/clip-three";
import { aiModel, priceOf } from "@opencmo/editor-core/generate";

import { liveModel } from "../generate/GeneratePanel";

const MOTIONS = ["draw", "pop", "spin", "orbit", "bounce", "float", "pulse", "shake", "fly"] as const;

/** Một ô icon: vẽ `d` 24×24 bằng SVG của trình duyệt (chỉ để chọn, không phải preview clip). */
function IconTile({ name, onPick }: { name: string; onPick: () => void }) {
  const [d, setD] = useState<string | null>(null);
  useEffect(() => {
    void iconPath(name).then(setD);
  }, [name]);
  return (
    <button type="button" className="ed2-chip" title={name} aria-label={name} data-testid={`visuals-icon-${name}`} onClick={onPick} style={{ padding: 6 }}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {d ? <path d={d} /> : null}
      </svg>
    </button>
  );
}

type Kind = "icon" | "animation" | "pointer" | "diagram" | "chart" | "graph" | "3d" | "studio";

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "icon", label: "Icon" },
  { kind: "animation", label: "Animation" },
  { kind: "pointer", label: "Pointer" },
  { kind: "diagram", label: "Diagram" },
  { kind: "chart", label: "Chart" },
  { kind: "graph", label: "Graph" },
  { kind: "3d", label: "3D" },
  { kind: "studio", label: "3D Studio" },
];

/** Template người dùng tự điền được. `code` (cảnh agent tự viết) không có ở đây: nó cần Assistant. */
type PickableTemplate = Exclude<(typeof TEMPLATES)[number], "code">;
const STUDIO_LABELS: Record<PickableTemplate, string> = { bars: "Bars", number: "Big number", rise: "Growth line", product: "Object" };
const PICKABLE = Object.keys(STUDIO_LABELS) as PickableTemplate[];

/** Model 3D Studio có bật trên máy chủ này không (cùng nguồn với ô Generate). */
let studioEnabled: Promise<boolean> | null = null;
function useStudioEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    studioEnabled ??= fetch("/api/v1/generations/models")
      .then((response) => (response.ok ? (response.json() as Promise<{ models: { id: string }[] }>) : { models: [] }))
      .then((body) => body.models.some((model) => model.id === STUDIO_MODEL))
      .catch(() => false);
    let live = true;
    void studioEnabled.then((value) => live && setEnabled(value));
    return () => {
      live = false;
    };
  }, []);
  return enabled;
}

const POINTERS = [
  { shape: "arrow", label: "Arrow", from: [0.2, 0.25], to: [0.65, 0.4] },
  { shape: "circle", label: "Circle", box: { x: 0.3, y: 0.3, width: 0.4, height: 0.12 } },
  { shape: "underline", label: "Underline", from: [0.15, 0.62], to: [0.85, 0.62] },
  { shape: "highlight", label: "Highlight", box: { x: 0.15, y: 0.58, width: 0.7, height: 0.05 } },
  { shape: "check", label: "Check", box: { x: 0.42, y: 0.3, width: 0.16, height: 0.1 } },
  { shape: "cross", label: "Cross", box: { x: 0.43, y: 0.3, width: 0.14, height: 0.08 } },
] as const;

const LAYOUTS = ["column", "row", "cycle", "tree", "compare"] as const;
const CHARTS = ["stat", "bar", "line", "donut", "pie"] as const;
const SHAPES3D = [
  { id: "surface", label: "Wave surface" },
  { id: "solids", label: "Shapes" },
  { id: "cube", label: "Spinning cube" },
] as const;

/** Vùng đặt chuẩn hoá 0–1; "auto" để op tự chọn (1/3 trên của khung dọc). */
const REGIONS = {
  auto: null,
  top: { x: 0.06, y: 0.06, width: 0.88, height: 0.34 },
  middle: { x: 0.06, y: 0.33, width: 0.88, height: 0.34 },
  bottom: { x: 0.06, y: 0.52, width: 0.88, height: 0.3 },
  left: { x: 0.04, y: 0.1, width: 0.46, height: 0.8 },
  right: { x: 0.5, y: 0.1, width: 0.46, height: 0.8 },
  full: { x: 0.04, y: 0.04, width: 0.92, height: 0.92 },
} as const;
type RegionName = keyof typeof REGIONS;

export type SelectedVisual = { id: string; op: string; input: Record<string, unknown> };

/** "Label: 12" mỗi dòng → dữ liệu biểu đồ; dòng không có số bị bỏ. */
function parseData(text: string): { label: string; value: number }[] {
  return text
    .split("\n")
    .map((line) => {
      const match = /^(.*?)[:=\s]\s*(-?[\d.,]+)\s*$/.exec(line.trim());
      if (!match) return null;
      const value = Number(match[2]!.replace(/,/g, ""));
      return Number.isFinite(value) ? { label: match[1]!.trim().slice(0, 24), value } : null;
    })
    .filter((item): item is { label: string; value: number } => item !== null);
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

function threeObjects(preset: (typeof SHAPES3D)[number]["id"], expr: string) {
  if (preset === "surface") {
    return {
      objects: [
        { type: "axes", length: 3.5 },
        { type: "surface", expr: expr || "sin(x) cos(y)", resolution: 26, color: "#236B8E", color2: "#FACC15", edges: "#0B1020", tracks: [{ property: "progress", keyframes: [{ time: 0, value: 0 }, { time: 1.2, value: 1 }] }] },
      ],
      camera: { phi: 62, theta: -40, distance: 13, orbit: 18 },
    };
  }
  if (preset === "solids") {
    return {
      objects: [
        { type: "cube", size: 1.8, position: [-1.8, 0, 0], color: "#58C4DD" },
        { type: "sphere", radius: 1.1, position: [0.8, -1.2, 0], color: "#FC6255" },
        { type: "torus", radius: 1, tube: 0.35, position: [1.4, 1.8, 0], rotation: [60, 0, 0], color: "#83C167" },
      ],
      camera: { phi: 60, theta: -60, distance: 12, orbit: 12 },
    };
  }
  return {
    objects: [{ type: "cube", size: 2.4, color: "#FACC15", edges: "#0B1020", tracks: [{ property: "rotateZ", keyframes: [{ time: 0, value: 0 }, { time: 4, value: 180 }] }, { property: "rotateX", keyframes: [{ time: 0, value: 0 }, { time: 4, value: 90 }] }] }],
    camera: { phi: 65, theta: -45, distance: 11 },
  };
}

export function VisualsPanel({
  busy,
  playhead,
  selected,
  onRun,
  onClose,
}: {
  busy: boolean;
  playhead: () => number;
  selected: SelectedVisual | null;
  onRun: (ops: unknown[]) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind>("icon");
  const [iconQuery, setIconQuery] = useState("arrow");
  const [icons, setIcons] = useState<IconMatch[]>([]);
  const [motion, setMotion] = useState<(typeof MOTIONS)[number]>("pop");
  const [flip, setFlip] = useState(false);
  const [lottieGroup, setLottieGroup] = useState<"motion" | "emoji">("motion");
  const [lottieQuery, setLottieQuery] = useState("");
  const [labels, setLabels] = useState("Hook\nValue\nCall to action");
  const [layout, setLayout] = useState<(typeof LAYOUTS)[number]>("column");
  const [chart, setChart] = useState<(typeof CHARTS)[number]>("stat");
  const [data, setData] = useState("Faster: 47");
  const [unit, setUnit] = useState("%");
  const [expr, setExpr] = useState("2^x");
  const [surface, setSurface] = useState("sin(x) cos(y)");
  const [title, setTitle] = useState("");
  const [region, setRegion] = useState<RegionName>("auto");
  const studio = useStudioEnabled();
  const [template, setTemplate] = useState<PickableTemplate>("bars");
  const [studioData, setStudioData] = useState("2023: 12\n2024: 19\n2025: 31");
  const [studioValue, setStudioValue] = useState("2.4M");
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [studioLabel, setStudioLabel] = useState("");
  const [object, setObject] = useState<(typeof PRODUCTS)[number]>("trophy");
  const [theme, setTheme] = useState<(typeof THEMES)[number]>("midnight");

  // Sửa visual đang chọn: nạp input của nó vào form.
  useEffect(() => {
    if (!selected) return;
    const input = selected.input;
    if (selected.op === "add_diagram") {
      setKind("diagram");
      setLabels(((input.nodes as { label: string }[] | undefined) ?? []).map((node) => node.label).join("\n"));
      if (typeof input.layout === "string") setLayout(input.layout as (typeof LAYOUTS)[number]);
    } else if (selected.op === "add_chart") {
      setKind("chart");
      setChart(input.type as (typeof CHARTS)[number]);
      setData(((input.data as { label: string; value: number }[] | undefined) ?? []).map((item) => `${item.label}: ${item.value}`).join("\n"));
      setUnit(typeof input.unit === "string" ? input.unit : "");
    } else if (selected.op === "add_graph") {
      setKind("graph");
      setExpr(String(input.expr ?? "x"));
    }
    setTitle(typeof input.title === "string" ? input.title : "");
  }, [selected]);

  useEffect(() => {
    if (kind !== "icon") return;
    let live = true;
    void findIcons(iconQuery || "arrow", 30).then((found) => live && setIcons(found));
    return () => {
      live = false;
    };
  }, [kind, iconQuery]);

  const at = () => {
    const start = Math.round(playhead() * 100) / 100;
    return { start, end: Math.round((start + 4) * 100) / 100 };
  };
  const titled = { ...(title.trim() ? { title: title.trim() } : {}), ...(REGIONS[region] ? { region: REGIONS[region] } : {}) };

  const spec = (): Record<string, unknown> | null => {
    if (kind === "diagram") {
      const nodes = lines(labels).slice(0, 8);
      if (!nodes.length) return null;
      if (layout === "compare") {
        const [a, b] = [nodes.slice(0, Math.ceil(nodes.length / 2)), nodes.slice(Math.ceil(nodes.length / 2))];
        return { layout, nodes: [{ label: a[0] ?? "A", items: a.slice(1) }, { label: b[0] ?? "B", items: b.slice(1) }], ...titled };
      }
      return { layout, nodes: nodes.map((label) => ({ label: label.slice(0, 60) })), ...titled };
    }
    if (kind === "chart") {
      const values = parseData(data);
      if (!values.length) return null;
      return { type: chart, data: chart === "stat" ? values.slice(0, 1) : values.slice(0, 12), ...(unit ? { unit } : {}), ...titled };
    }
    if (kind === "graph") return expr.trim() ? { expr: expr.trim(), label: `y = ${expr.trim()}`, ...titled } : null;
    return null;
  };

  /** "2.4M", "12,500", "47" → số; K/M/B nhân lên. */
  const number = (text: string): number | null => {
    const match = /^\s*(-?[\d.,]+)\s*([kmb])?\s*$/i.exec(text);
    if (!match) return null;
    const value = Number(match[1]!.replace(/,/g, "")) * ({ k: 1e3, m: 1e6, b: 1e9 }[(match[2] ?? "").toLowerCase() as "k"] ?? 1);
    return Number.isFinite(value) ? value : null;
  };
  const studioScene = (): Record<string, unknown> | null => {
    const common = { template, theme, ...(title.trim() ? { title: title.trim().slice(0, 40) } : {}), ...(studioLabel.trim() ? { label: studioLabel.trim().slice(0, 40) } : {}) };
    if (template === "bars") {
      const bars = parseData(studioData).slice(0, 6);
      if (bars.length < 2 || bars.some((bar) => bar.value < 0)) return null;
      const top = Math.max(...bars.map((bar) => bar.value));
      return { ...common, bars: bars.map((bar) => ({ ...bar, ...(bar.value === top ? { highlight: true } : {}) })), ...(prefix ? { prefix: prefix.slice(0, 3) } : {}), ...(suffix ? { suffix: suffix.slice(0, 4) } : {}) };
    }
    if (template === "number") {
      const value = number(studioValue);
      return value === null ? null : { ...common, value, ...(prefix ? { prefix: prefix.slice(0, 3) } : {}), ...(suffix ? { suffix: suffix.slice(0, 4) } : {}) };
    }
    if (template === "rise") {
      const points = studioData.split(/[\s,;]+/).map(number).filter((value): value is number => value !== null).slice(0, 12);
      return points.length < 3 ? null : { ...common, points, ...(prefix ? { prefix: prefix.slice(0, 3) } : {}), ...(suffix ? { suffix: suffix.slice(0, 4) } : {}) };
    }
    return { ...common, object };
  };
  const studioModel = liveModel(STUDIO_MODEL) ?? aiModel(STUDIO_MODEL);
  const studioCredits = studioModel ? priceOf(studioModel, { prompt: "x" }) : 1;

  const add = (op: string, extra: Record<string, unknown>) => onRun([{ op, ...at(), ...extra }]);
  const opFor: Record<Kind, string> = { icon: "add_icon", animation: "add_lottie", pointer: "add_shape", diagram: "add_diagram", chart: "add_chart", graph: "add_graph", "3d": "add_3d", studio: "add_3d_studio" };
  const editing = selected && selected.op === opFor[kind] ? selected : null;

  return (
    <div className="ed2-gen" data-testid="visuals-panel" onPointerDown={(event) => event.stopPropagation()}>
      <div className="ed2-row">
        {KINDS.filter((entry) => entry.kind !== "studio" || studio).map((entry) => (
          <button key={entry.kind} type="button" className="ed2-chip" aria-pressed={kind === entry.kind} data-testid={`visuals-kind-${entry.kind}`} onClick={() => setKind(entry.kind)}>
            {entry.label}
          </button>
        ))}
        <span className="ed2-grow" />
        <button type="button" className="ed2-icon" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>

      {kind === "icon" ? (
        <>
          <input className="ed2-select" style={{ flex: "none" }} aria-label="Search icons" placeholder="Search icons: money, rocket, bow arrow…" data-testid="visuals-icon-search" value={iconQuery} onChange={(event) => setIconQuery(event.target.value)} onKeyDown={(event) => event.stopPropagation()} />
          <div className="ed2-row ed2-wrap">
            {MOTIONS.map((value) => (
              <button key={value} type="button" className="ed2-chip" aria-pressed={motion === value} data-testid={`visuals-motion-${value}`} onClick={() => setMotion(value)}>
                {value}
              </button>
            ))}
          </div>
          <div className="ed2-row ed2-wrap" style={{ maxHeight: 180, overflowY: "auto" }}>
            {icons.map((icon) => (
              <IconTile
                key={icon.name}
                name={icon.name}
                onPick={() => add("add_icon", { name: icon.name, motion, at: [0.5, 0.25], ...(motion === "fly" ? { at: [0.2, 0.25], to: [0.8, 0.25], orient: true } : {}) })}
              />
            ))}
          </div>
        </>
      ) : null}

      {kind === "animation" ? (
        <>
          <div className="ed2-row">
            <button type="button" className="ed2-chip" aria-pressed={lottieGroup === "motion"} data-testid="visuals-lottie-group-motion" onClick={() => setLottieGroup("motion")}>
              Motion
            </button>
            <button type="button" className="ed2-chip" aria-pressed={lottieGroup === "emoji"} data-testid="visuals-lottie-group-emoji" onClick={() => setLottieGroup("emoji")}>
              Emoji
            </button>
          </div>
          <input
            className="ed2-select"
            style={{ flex: "none" }}
            aria-label="Search animations"
            placeholder={lottieGroup === "emoji" ? "Search emoji: fire, laugh, idea, money…" : "Search: run, celebrate, idea, goal…"}
            data-testid="visuals-lottie-search"
            value={lottieQuery}
            onChange={(event) => setLottieQuery(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
          {lottieGroup === "motion" ? (
            <div className="ed2-row ed2-wrap">
              {(lottieQuery.trim() ? findLotties(lottieQuery, 40).filter((entry) => !entry.name.startsWith("emoji/")) : LOTTIE_PACK).map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  className="ed2-chip"
                  disabled={busy}
                  title={entry.tags.join(", ")}
                  data-testid={`visuals-lottie-${entry.name}`}
                  onClick={() => add("add_lottie", { animation: entry.name, ...(flip ? { flip: true } : {}) })}
                >
                  {entry.title}
                </button>
              ))}
            </div>
          ) : (
            <div className="ed2-emoji-grid">
              {(lottieQuery.trim() ? EMOJI_PACK.filter((entry) => findLotties(lottieQuery, 200).some((hit) => hit.name === entry.name)) : EMOJI_PACK).map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  className="ed2-emoji"
                  disabled={busy}
                  title={entry.title}
                  aria-label={entry.title}
                  data-testid={`visuals-emoji-${entry.name.slice(6)}`}
                  onClick={() => add("add_lottie", { animation: entry.name })}
                >
                  {entry.emoji}
                </button>
              ))}
            </div>
          )}
          <label className="ed2-check">
            <input type="checkbox" checked={flip} data-testid="visuals-lottie-flip" onChange={(event) => setFlip(event.target.checked)} />
            Mirror (face left)
          </label>
          <p className="ed2-muted">
            Your own Lottie .json files go in Media — drag them onto the canvas. Animated emoji by Google Noto (CC BY 4.0).
          </p>
        </>
      ) : null}

      {kind === "pointer" ? (
        <div className="ed2-row ed2-wrap">
          {POINTERS.map((pointer) => (
            <button
              key={pointer.shape}
              type="button"
              className="ed2-chip"
              disabled={busy}
              data-testid={`visuals-shape-${pointer.shape}`}
              onClick={() => {
                const { label: _label, ...shape } = pointer;
                add("add_shape", shape);
              }}
            >
              {pointer.label}
            </button>
          ))}
        </div>
      ) : null}

      {kind === "diagram" ? (
        <>
          <div className="ed2-row ed2-wrap">
            {LAYOUTS.map((value) => (
              <button key={value} type="button" className="ed2-chip" aria-pressed={layout === value} onClick={() => setLayout(value)}>
                {value}
              </button>
            ))}
          </div>
          <textarea
            className="ed2-asst-input"
            aria-label="Steps, one per line"
            placeholder={layout === "compare" ? "First half: title then bullets; second half: title then bullets" : "One step per line"}
            data-testid="visuals-labels"
            value={labels}
            onChange={(event) => setLabels(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
        </>
      ) : null}

      {kind === "chart" ? (
        <>
          <div className="ed2-row ed2-wrap">
            {CHARTS.map((value) => (
              <button key={value} type="button" className="ed2-chip" aria-pressed={chart === value} onClick={() => setChart(value)}>
                {value}
              </button>
            ))}
            <input className="ed2-select" aria-label="Unit" placeholder="Unit" value={unit} style={{ width: 64 }} onChange={(event) => setUnit(event.target.value)} onKeyDown={(event) => event.stopPropagation()} />
          </div>
          <textarea
            className="ed2-asst-input"
            aria-label="Data, one 'label: value' per line"
            placeholder="Label: value, one per line"
            data-testid="visuals-data"
            value={data}
            onChange={(event) => setData(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
        </>
      ) : null}

      {kind === "graph" ? (
        <input className="ed2-select" aria-label="Formula in x" placeholder="y = …  e.g. 2^x, x^2, sin(x)" data-testid="visuals-expr" value={expr} onChange={(event) => setExpr(event.target.value)} onKeyDown={(event) => event.stopPropagation()} />
      ) : null}

      {kind === "3d" ? (
        <>
          <input className="ed2-select" aria-label="Surface formula in x and y" placeholder="z = …  e.g. sin(x) cos(y)" value={surface} onChange={(event) => setSurface(event.target.value)} onKeyDown={(event) => event.stopPropagation()} />
          <div className="ed2-row ed2-wrap">
            {SHAPES3D.map((preset) => (
              <button key={preset.id} type="button" className="ed2-chip" disabled={busy} data-testid={`visuals-3d-${preset.id}`} onClick={() => add("add_3d", { ...threeObjects(preset.id, surface), ...titled })}>
                {preset.label}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {kind === "studio" ? (
        <>
          <div className="ed2-row ed2-wrap">
            {PICKABLE.map((value) => (
              <button key={value} type="button" className="ed2-chip" aria-pressed={template === value} data-testid={`studio-template-${value}`} onClick={() => setTemplate(value)}>
                {STUDIO_LABELS[value]}
              </button>
            ))}
          </div>
          {template === "bars" || template === "rise" ? (
            <textarea
              className="ed2-asst-input"
              aria-label={template === "bars" ? "Bars, one 'label: value' per line" : "Values over time, separated by commas"}
              placeholder={template === "bars" ? "Label: value, 2 to 6 lines" : "12, 18, 26, 41 (3 to 12 values)"}
              data-testid="studio-data"
              value={studioData}
              onChange={(event) => setStudioData(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
            />
          ) : null}
          {template === "number" ? (
            <input className="ed2-select" style={{ flex: "none" }} aria-label="Number" placeholder="2.4M, 12,500, 47" data-testid="studio-value" value={studioValue} onChange={(event) => setStudioValue(event.target.value)} onKeyDown={(event) => event.stopPropagation()} />
          ) : null}
          {template === "product" ? (
            <div className="ed2-row ed2-wrap">
              {PRODUCTS.map((value) => (
                <button key={value} type="button" className="ed2-chip" aria-pressed={object === value} data-testid={`studio-object-${value}`} onClick={() => setObject(value)}>
                  {value}
                </button>
              ))}
            </div>
          ) : (
            <div className="ed2-row">
              <input className="ed2-select" aria-label="Prefix" placeholder="Prefix ($)" value={prefix} maxLength={3} style={{ width: 80 }} onChange={(event) => setPrefix(event.target.value)} onKeyDown={(event) => event.stopPropagation()} />
              <input className="ed2-select" aria-label="Suffix" placeholder="Suffix (%)" value={suffix} maxLength={4} style={{ width: 80 }} onChange={(event) => setSuffix(event.target.value)} onKeyDown={(event) => event.stopPropagation()} />
            </div>
          )}
          <input className="ed2-select" style={{ flex: "none" }} aria-label="Label (optional)" placeholder="Label (optional)" maxLength={40} value={studioLabel} onChange={(event) => setStudioLabel(event.target.value)} onKeyDown={(event) => event.stopPropagation()} />
          <div className="ed2-row ed2-wrap" aria-label="Look">
            {THEMES.map((value) => (
              <button key={value} type="button" className="ed2-chip" aria-pressed={theme === value} data-testid={`studio-theme-${value}`} onClick={() => setTheme(value)}>
                {value}
              </button>
            ))}
          </div>
          <p className="ed2-muted">Rendered in 3D on our GPUs. It appears on the clip in about half a minute.</p>
        </>
      ) : null}

      {kind !== "pointer" && kind !== "icon" ? (
        <div className="ed2-row ed2-wrap" aria-label="Region">
          {(Object.keys(REGIONS) as RegionName[]).map((name) => (
            <button key={name} type="button" className="ed2-chip" aria-pressed={region === name} data-testid={`visuals-region-${name}`} onClick={() => setRegion(name)}>
              {name}
            </button>
          ))}
        </div>
      ) : null}

      {kind === "studio" ? (
        <div className="ed2-row">
          <input className="ed2-select ed2-grow" aria-label="Title (optional)" placeholder="Title (optional)" maxLength={40} value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => event.stopPropagation()} />
          <button
            type="button"
            className="ed2-btn ed2-primary"
            disabled={busy || !studioScene()}
            data-testid="studio-render"
            onClick={() => {
              const scene = studioScene();
              const start = Math.round(playhead() * 100) / 100;
              if (scene) onRun([{ op: "add_3d_studio", start, end: Math.round((start + 6) * 100) / 100, ...scene, ...(REGIONS[region] ? { region: REGIONS[region] } : {}) }]);
            }}
          >
            Render 3D · {studioCredits} {studioCredits === 1 ? "credit" : "credits"}
          </button>
        </div>
      ) : null}

      {kind === "diagram" || kind === "chart" || kind === "graph" ? (
        <div className="ed2-row">
          <input className="ed2-select ed2-grow" aria-label="Title (optional)" placeholder="Title (optional)" value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => event.stopPropagation()} />
          {editing ? (
            <button
              type="button"
              className="ed2-btn"
              disabled={busy || !spec()}
              data-testid="visuals-update"
              onClick={() => {
                const changes = spec();
                if (changes) onRun([{ op: "update_visual", id: editing.id, changes }]);
              }}
            >
              Update
            </button>
          ) : null}
          <button
            type="button"
            className="ed2-btn ed2-primary"
            disabled={busy || !spec()}
            data-testid="visuals-add"
            onClick={() => {
              const extra = spec();
              if (extra) add(opFor[kind], extra);
            }}
          >
            Add at playhead
          </button>
        </div>
      ) : null}
    </div>
  );
}
