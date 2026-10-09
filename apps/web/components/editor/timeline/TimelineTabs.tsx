"use client";

/**
 * Tab timeline (E2-a, học Palmier `timelineTabsButton` + thanh tab): mỗi timeline là
 * một scene cấp stage của document. Bấm tab là mở; nhấp đúp đổi tên; "+" tạo
 * timeline trống hoặc nhân bản tab đang mở (cách làm phiên bản "bản 9:16", "bản gọn").
 */

import { useState } from "react";

import type { ClipDocument } from "@opencmo/clip-doc";
import { timelineLabel, timelinesOf } from "@opencmo/editor-core";

import { ContextMenu, DropdownMenu } from "../menus/Menu";

type Props = { doc: ClipDocument; run: (ops: unknown[]) => Promise<unknown> };

/** Nút "+" trên thanh timeline: luôn có, kể cả khi project mới một timeline. */
export function NewTimeline({ doc, run }: Props) {
  const scenes = timelinesOf(doc);
  const active = scenes.find((scene) => scene.active) ?? scenes[0];
  if (!active) return null;
  return (
    <DropdownMenu
      label="New timeline"
      testid="timeline-new"
      items={[
        { label: `Duplicate “${timelineLabel(active, scenes.indexOf(active))}”`, onSelect: () => void run([{ op: "create_timeline", from: active.id }]), testid: "timeline-duplicate", disabled: !active.id },
        { label: "Empty timeline", onSelect: () => void run([{ op: "create_timeline" }]), testid: "timeline-empty" },
      ]}
    >
      + Timeline
    </DropdownMenu>
  );
}

/** Hàng tab riêng dưới thanh timeline, chỉ khi có từ hai timeline (Palmier: thanh tab bật/tắt). */
export function TimelineTabs({ doc, run }: Props) {
  const scenes = timelinesOf(doc);
  const active = scenes.find((scene) => scene.active) ?? scenes[0];
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  if (!active || scenes.length < 2) return null;

  const commitName = (id: string, value: string, before: string) => {
    setRenaming(null);
    const name = value.trim();
    if (name && name !== before) void run([{ op: "rename_timeline", timeline_id: id, name }]);
  };

  return (
    <div className="ed2-tl-tabs" role="tablist" aria-label="Timelines" data-testid="timeline-tabs">
      {scenes.map((scene, index) => {
        const id = scene.id ?? "";
        const label = timelineLabel(scene, index);
        if (renaming === id) {
          return (
            <input
              key={id}
              className="ed2-tl-tab ed2-tl-tab-edit"
              autoFocus
              aria-label="Timeline name"
              defaultValue={label}
              maxLength={60}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") commitName(id, event.currentTarget.value, label);
                if (event.key === "Escape") setRenaming(null);
              }}
              onBlur={(event) => commitName(id, event.currentTarget.value, label)}
            />
          );
        }
        return (
          <button
            key={id || index}
            type="button"
            role="tab"
            className="ed2-tl-tab"
            aria-selected={scene === active}
            data-testid="timeline-tab"
            title={`${label} · ${scene.width}×${scene.height}`}
            disabled={!id}
            onClick={() => scene !== active && void run([{ op: "set_active_timeline", timeline_id: id }])}
            onDoubleClick={() => setRenaming(id)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setMenu({ id, x: event.clientX, y: event.clientY });
            }}
          >
            {label}
          </button>
        );
      })}
      {menu ? (
        <ContextMenu
          at={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          items={[
            { label: "Rename", onSelect: () => setRenaming(menu.id), testid: "timeline-rename" },
            { label: "Duplicate", onSelect: () => void run([{ op: "create_timeline", from: menu.id }]) },
            { kind: "separator" },
            { label: "Delete timeline", disabled: scenes.length < 2, onSelect: () => void run([{ op: "delete_timeline", timeline_id: menu.id }]), testid: "timeline-delete" },
          ]}
        />
      ) : null}
    </div>
  );
}
