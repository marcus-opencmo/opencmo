"use client";

/**
 * Mục "Layout" khi chọn nhiều lớp (E5, học bảng bố cục của Palmier): chỉ hiện các bố cục có
 * đúng bằng số phần tử media đang chọn, gán theo THỨ TỰ CHỌN; "Rotate" xoay vòng thứ tự đó.
 * Gửi `apply_layout` — cùng op với agent.
 */

import { useState } from "react";

import { LAYOUT_LABEL, layoutSlots, layoutsFor, type VideoLayout } from "@opencmo/editor-core";

import { Section, Segmented } from "./controls";
import type { Edit } from "./controls";
import type { Entity } from "./shared";

const isMedia = (node: Entity): boolean =>
  node.kind === "video" ||
  node.kind === "image" ||
  node.kind === "sequence" ||
  (node.kind === "rect" && Array.isArray(node.paints) && (node.paints as { type?: string }[]).some((paint) => paint.type === "image" || paint.type === "video"));

/** Hình nhỏ của bố cục: các ô, ô có z cao tô đậm hơn. */
function Thumb({ layout }: { layout: VideoLayout }) {
  return (
    <svg viewBox="0 0 90 160" width={27} height={48} aria-hidden="true">
      {layoutSlots(layout).map((slot, index) => (
        <rect
          key={slot.id}
          x={slot.rect[0] * 90 + 1.5}
          y={slot.rect[1] * 160 + 1.5}
          width={slot.rect[2] * 90 - 3}
          height={slot.rect[3] * 160 - 3}
          rx={4}
          className={slot.z > 0 ? "ed2-layout-cell is-top" : "ed2-layout-cell"}
          data-index={index}
        />
      ))}
    </svg>
  );
}

export function ArrangeSection({ selection, nodes, edit }: { selection: string[]; nodes: Map<string, Entity>; edit: Edit }) {
  const [fit, setFit] = useState<"fill" | "fit">("fill");
  const [shift, setShift] = useState(0);
  const media = selection.map((id) => nodes.get(id)).filter((node): node is Entity => !!node && isMedia(node) && !!node.id);
  const options = layoutsFor(media.length);
  if (!options.length) return null;
  // Xoay vòng thứ tự gán: "Rotate" đổi ai vào ô nào mà không phải chọn lại.
  const order = media.map((_, index) => media[(index + shift) % media.length]!);
  const apply = (layout: VideoLayout) => {
    const slots = layoutSlots(layout).map((slot, index) => ({ slot: slot.id, element_ids: [order[index]!.id!] }));
    edit([{ op: "apply_layout", layout, fit, slots }]);
  };
  return (
    <Section title="Layout" testid="ins-layout">
      <div className="ed2-layout-grid">
        {options.map((layout) => (
          <button key={layout} type="button" className="ed2-layout-option" data-testid={`layout-${layout}`} title={LAYOUT_LABEL[layout]} onClick={() => apply(layout)}>
            <Thumb layout={layout} />
            <span>{LAYOUT_LABEL[layout]}</span>
          </button>
        ))}
      </div>
      <div className="ed2-row">
        <Segmented
          label="Layout fit"
          value={fit}
          options={[
            { value: "fill", label: "Fill" },
            { value: "fit", label: "Fit" },
          ]}
          onChange={setFit}
        />
        {media.length > 1 ? (
          <button type="button" className="ed2-chip" data-testid="layout-rotate" onClick={() => setShift((value) => (value + 1) % media.length)}>
            Rotate order
          </button>
        ) : null}
      </div>
      <p className="ed2-hint">Slots fill in the order you selected the layers{shift ? `, rotated ${shift}` : ""}.</p>
    </Section>
  );
}
