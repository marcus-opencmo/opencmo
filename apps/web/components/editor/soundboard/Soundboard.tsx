"use client";

/**
 * Soundboard (checklist SND-01/02): hai dải fader + đồng hồ cho hai lớp có
 * tiếng (chọn được) và một dải master (âm lượng của scene), bên phải timeline
 * như fork.
 *
 * Fader ghi `volume` theo dB NGUYÊN (0 dB là bỏ prop), và ghi keyframe khi lớp
 * có track `volume` — như fork. Dải −60…+60 dB.
 *
 * Đồng hồ không đọc WebAudio: nó tính từ sóng âm của nguồn (cùng `peaks` của
 * timeline) nhân biên độ `renderer.gains()` ở khung đang phát. Nhờ vậy mỗi lớp
 * có đồng hồ của riêng nó kể cả khi hai lớp chung một file nguồn, và số đo tất
 * định — kiểm được bằng test.
 */

import { useEffect, useMemo, useState } from "react";

import type { AssetInput, ClipDocument, ClipNode } from "@opencmo/clip-doc";
import { FPS, type Renderer, type TimeNode } from "@opencmo/clip-render";
import { activeScene } from "@opencmo/editor-core";

import { keyOf, type BrowserMedia } from "../media";
import { loadPeaks, type Peaks } from "../timeline/peaks";
import { labelOf } from "../timeline/rows";

type Entity = Record<string, unknown> & { id?: string };

const METER = { min: -60, max: 3 };
const FADER = { min: -60, max: 60 };

const toDb = (amplitude: number) => (amplitude <= 0 ? -Infinity : 20 * Math.log10(amplitude));

/** Lớp trên cùng (con của scene) chứa `r`. */
function topLayer(r: { node: unknown; parent: { node: unknown; parent: unknown } | null }): Entity | null {
  let at = r as { node: unknown; parent: { node: unknown; parent: unknown } | null };
  while (at.parent && (at.parent.node as Entity).kind !== "scene") at = at.parent as typeof at;
  return at.parent ? (at.node as Entity) : null;
}

export function Soundboard({
  doc,
  renderer,
  times,
  frame,
  playing,
  media,
  edit,
}: {
  doc: ClipDocument;
  renderer: Renderer | null;
  times: Map<ClipNode, TimeNode>;
  frame: number;
  playing: boolean;
  media: BrowserMedia;
  edit: (ops: unknown[]) => void;
}) {
  const scene = activeScene(doc) as unknown as Entity;

  // Lớp có tiếng, theo thứ tự hàng của timeline (trên cùng trước).
  const layers = useMemo(() => {
    const seen: Entity[] = [];
    for (const clip of renderer?.audio ?? []) {
      const layer = topLayer(clip.node as never);
      if (layer && !seen.includes(layer)) seen.push(layer);
    }
    const order = ((scene.children as Entity[] | undefined) ?? []).slice().reverse();
    return order.filter((node) => seen.some((layer) => layer.id === node.id));
  }, [renderer, scene]);

  const [picked, setPicked] = useState<[string | null, string | null]>([null, null]);
  // Ô trống tự điền lớp chưa hiện ở ô bên cạnh — hai đồng hồ không trùng một lớp.
  const left = layers.find((layer) => layer.id === picked[0]) ?? layers.find((layer) => layer.id !== picked[1]) ?? null;
  const right =
    layers.find((layer) => layer.id === picked[1] && layer.id !== left?.id) ??
    layers.find((layer) => layer !== left) ??
    null;

  // Sóng âm của mọi nguồn có tiếng.
  const [peaks, setPeaks] = useState<Map<string, Peaks>>(new Map());
  const sources = useMemo(() => {
    const map = new Map<string, AssetInput>();
    for (const clip of renderer?.audio ?? []) map.set(keyOf(clip.src), clip.src);
    return map;
  }, [renderer]);
  useEffect(() => {
    let live = true;
    for (const [key, src] of sources) {
      if (peaks.has(key)) continue;
      void loadPeaks(key, () => media.bytesOf(src)).then((found) => {
        if (live && found) setPeaks((all) => new Map(all).set(key, found));
      });
    }
    return () => {
      live = false;
    };
  }, [sources, media, peaks]);

  // Biên độ của từng lớp và của tổng ở khung này (chỉ khi đang phát, như fork).
  const levels = useMemo(() => {
    const byLayer = new Map<string, number>();
    let master = 0;
    if (!renderer || !playing) return { byLayer, master };
    const gains = renderer.gains(frame);
    renderer.audio.forEach((clip, index) => {
      if (frame < clip.start || frame >= clip.end) return;
      const found = peaks.get(keyOf(clip.src));
      if (!found) return;
      const seconds = clip.sourceIn + ((frame - clip.start) / FPS) * clip.rate;
      const peak = found.values[Math.floor(seconds * found.rate)] ?? 0;
      const level = peak * (gains[index] ?? 0);
      const layer = topLayer(clip.node as never);
      if (layer?.id) byLayer.set(layer.id, Math.max(byLayer.get(layer.id) ?? 0, level));
      master += level;
    });
    return { byLayer, master };
  }, [renderer, playing, frame, peaks]);

  const volumeOf = (node: Entity) => (node.volume === "-Infinity" ? FADER.min : typeof node.volume === "number" ? node.volume : 0);

  const setVolume = (node: Entity | null, value: number) => {
    if (!node?.id) return;
    const db = Math.round(value);
    const track = ((node.tracks as Entity[] | undefined) ?? []).find((item) => item.property === "volume");
    if (track) {
      const t = times.get(node as unknown as ClipNode);
      const local = t ? Math.round((frame - t.origin) * t.rate) : frame;
      edit([{ op: "set_keyframe", element_id: node.id, property: "volume", time: local / FPS, value: db }]);
      return;
    }
    edit([{ op: "set_props", element_id: node.id, props: { volume: db === 0 ? null : db } }]);
  };

  const strip = (node: Entity | null, level: number, testid: string, choose?: (id: string) => void, options: Entity[] = []) => (
    <div className="ed2-strip" data-testid={testid}>
      <div className="ed2-strip-body">
        <Fader
          label={`${node ? labelOf(node) : "Layer"} volume`}
          testid={`${testid}-fader`}
          disabled={!node}
          value={node ? volumeOf(node) : 0}
          onCommit={(value) => setVolume(node, value)}
        />
        <Meter level={level} testid={`${testid}-meter`} />
      </div>
      <span className="ed2-strip-db">{node ? `${volumeOf(node)} dB` : "—"}</span>
      {choose ? (
        <select
          className="ed2-strip-pick"
          aria-label="Layer"
          value={node?.id ?? ""}
          disabled={options.length <= 1}
          onChange={(event) => choose(event.target.value)}
        >
          {node ? null : <option value="">No audio</option>}
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {labelOf(option)}
            </option>
          ))}
        </select>
      ) : (
        <span className="ed2-strip-name">Master</span>
      )}
    </div>
  );

  return (
    <aside className="ed2-sound" data-testid="soundboard">
      {strip(left, left?.id ? (levels.byLayer.get(left.id) ?? 0) : 0, "strip-left", (id) => setPicked([id, picked[1]]), layers.filter((layer) => layer !== right))}
      {strip(right, right?.id ? (levels.byLayer.get(right.id) ?? 0) : 0, "strip-right", (id) => setPicked([picked[0], id]), layers.filter((layer) => layer !== left))}
      {strip(scene, levels.master, "strip-master")}
    </aside>
  );
}

function Meter({ level, testid }: { level: number; testid: string }) {
  const db = toDb(level);
  const fraction = db <= METER.min ? 0 : Math.min(1, (db - METER.min) / (METER.max - METER.min));
  return (
    <div className="ed2-meter" data-testid={testid} data-db={Number.isFinite(db) ? db.toFixed(1) : "-inf"}>
      <div className={db > 0 ? "ed2-meter-fill is-hot" : "ed2-meter-fill"} style={{ height: `${fraction * 100}%` }} />
    </div>
  );
}

/** Fader dọc: kéo chỉ đổi số hiện, thả tay (hay nhả phím) mới ghi — một bước Undo. */
function Fader({
  label,
  testid,
  disabled,
  value,
  onCommit,
}: {
  label: string;
  testid: string;
  disabled: boolean;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      type="range"
      className="ed2-fader"
      aria-label={label}
      data-testid={testid}
      min={FADER.min}
      max={FADER.max}
      step={1}
      disabled={disabled}
      value={draft ?? value}
      onChange={(event) => setDraft(Number(event.target.value))}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
    />
  );
}
