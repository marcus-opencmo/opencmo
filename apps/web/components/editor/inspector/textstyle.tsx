"use client";

/**
 * Kiểu chữ thêm của E4 (học Palmier TextStyle / TextFillMode / tilt): hộp nền, gạch
 * dưới/trên/ngang, chữ lộ hình (Footage) hay đảo màu (Inverted), nghiêng phối cảnh.
 */

import { ColorField, NumberField, Row, Section, Segmented } from "./controls";
import { setProps, type InspectorContext } from "./shared";

type Background = { color: string; paddingX?: number; paddingY?: number; radius?: number; outlineColor?: string; outlineWidth?: number; perLine?: boolean };

const DECORATIONS = [
  { value: "underline", label: "U", title: "Underline" },
  { value: "overline", label: "O", title: "Overline" },
  { value: "strike", label: "S", title: "Strikethrough" },
] as const;

export function TextStyleSection({ ctx }: { ctx: InspectorContext }) {
  const { node } = ctx;
  const background = node.background as Background | undefined;
  const decoration = (node.decoration as string[] | undefined) ?? [];
  const setBackground = (patch: Partial<Background> | null) =>
    setProps(ctx, node, { background: patch === null ? null : { ...(background ?? { color: "#000000B3" }), ...patch } });
  return (
    <Section title="Text style" testid="ins-text-style">
      <Row label="Background">
        <label className="ed2-check">
          <input type="checkbox" data-testid="ins-text-bg" checked={!!background} onChange={(event) => setBackground(event.target.checked ? { radius: 12 } : null)} />
          Box
        </label>
        {background ? <ColorField label="Background color" value={background.color} onCommit={(value) => setBackground({ color: value })} /> : null}
      </Row>
      {background ? (
        <>
          <Row label="Padding">
            <NumberField label="X" value={background.paddingX ?? 0} min={0} onCommit={(value) => setBackground({ paddingX: value })} />
            <NumberField label="Y" value={background.paddingY ?? 0} min={0} onCommit={(value) => setBackground({ paddingY: value })} />
          </Row>
          <Row label="Corners">
            <NumberField label="R" value={background.radius ?? 0} min={0} onCommit={(value) => setBackground({ radius: value })} />
            <label className="ed2-check">
              <input type="checkbox" checked={!!background.perLine} onChange={(event) => setBackground({ perLine: event.target.checked || undefined })} />
              Each line
            </label>
          </Row>
          <Row label="Outline">
            <NumberField label="W" value={background.outlineWidth ?? 0} min={0} onCommit={(value) => setBackground({ outlineWidth: value || undefined })} />
            <ColorField label="Outline color" value={background.outlineColor ?? "#FFFFFF"} onCommit={(value) => setBackground({ outlineColor: value })} />
          </Row>
        </>
      ) : null}
      <Row label="Lines">
        <div className="ed2-row" role="group" aria-label="Text decoration">
          {DECORATIONS.map((item) => {
            const on = decoration.includes(item.value);
            return (
              <button
                key={item.value}
                type="button"
                className="ed2-chip"
                title={item.title}
                aria-pressed={on}
                data-testid={`ins-text-${item.value}`}
                onClick={() => {
                  const next = on ? decoration.filter((value) => value !== item.value) : [...decoration, item.value];
                  setProps(ctx, node, { decoration: next.length ? next : null });
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </Row>
      <Row label="Fill">
        <Segmented
          label="Text fill"
          value={(node.fill as string | undefined) ?? "color"}
          options={[
            { value: "color", label: "Color" },
            { value: "footage", label: "Footage" },
            { value: "inverted", label: "Inverted" },
          ]}
          onChange={(value) => setProps(ctx, node, { fill: value === "color" ? null : value })}
        />
      </Row>
      {node.fill === "footage" ? <p className="ed2-hint">The text is a window onto the layers below; the rest of the frame takes the text color.</p> : null}
      <Row label="Tilt">
        <NumberField label="X" value={Number(node.tiltX ?? 0)} min={-89} max={89} unit="°" testid="ins-tiltX" onCommit={(value) => setProps(ctx, node, { tiltX: value || null })} />
        <NumberField label="Y" value={Number(node.tiltY ?? 0)} min={-89} max={89} unit="°" testid="ins-tiltY" onCommit={(value) => setProps(ctx, node, { tiltY: value || null })} />
      </Row>
    </Section>
  );
}
