"use client";

/**
 * Nút bật/tắt Assistant · Media · Inspector và chọn preset bố cục, như
 * `TitleBarLeadingView` của Palmier: icon đặc khi panel đang hiện.
 */

import type { EditorLayout, ToggleablePanel } from "./layout";
import { PRESETS } from "./layout";
import { DropdownMenu } from "./menus/Menu";

const ICON: Record<ToggleablePanel, React.ReactNode> = {
  agent: <path d="M4 5h16v11H9l-5 4z" />,
  media: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  inspector: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
};
const LABEL: Record<ToggleablePanel, string> = { agent: "Assistant", media: "Media panel", inspector: "Inspector" };

export function PanelToggles({ layout, altLabel }: { layout: EditorLayout; altLabel: string }) {
  return (
    <div className="ed2-panels" role="group" aria-label="Panels">
      {(["agent", "media", "inspector"] as const).map((name) => (
        <button
          key={name}
          type="button"
          className="ed2-icon ed2-panel-toggle"
          aria-pressed={layout.visible[name]}
          aria-label={LABEL[name]}
          title={name === "media" && layout.squeezed ? "Show Media panel (closes the Assistant to make room)" : `${layout.visible[name] ? "Hide" : "Show"} ${LABEL[name]}`}
          data-testid={`panel-${name}`}
          onClick={() => layout.toggle(name)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden fill={name === "agent" && layout.visible.agent ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
            {ICON[name]}
          </svg>
        </button>
      ))}
      <DropdownMenu
        label="Layout"
        testid="layout-menu"
        items={PRESETS.map((preset) => ({
          label: `${preset.id === layout.preset ? "✓ " : ""}${preset.label}`,
          shortcut: `${altLabel}${preset.key}`,
          onSelect: () => layout.setPreset(preset.id),
          testid: `layout-${preset.id}`,
        }))}
      >
        {PRESETS.find((preset) => preset.id === layout.preset)?.label} ▾
      </DropdownMenu>
    </div>
  );
}
