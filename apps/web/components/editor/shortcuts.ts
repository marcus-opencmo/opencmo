/**
 * Bảng phím tắt (checklist §2.2, KBD-01…19) — cùng phím với fork. Menu và menu
 * chuột phải đọc cùng bảng này để in phím cạnh tên lệnh, nên một lệnh chỉ có
 * một phím ở mọi chỗ.
 *
 * `mod` là ⌘ trên Mac, Ctrl ở máy khác. `undefined` = không quan tâm phím đó.
 */

export type ActionName =
  | "undo"
  | "redo"
  | "delete"
  | "rippleDelete"
  | "addMarker"
  | "duplicate"
  | "copy"
  | "paste"
  | "cut"
  | "selectAll"
  | "group"
  | "ungroup"
  | "wrapScene"
  | "wrapSequence"
  | "unwrapSequence"
  | "oneRow"
  | "split"
  | "toggleHidden"
  | "zoomIn"
  | "zoomOut"
  | "zoomActual"
  | "zoomFit"
  | "zoomSelection"
  | "toolMove"
  | "toolHand"
  | "toolScene"
  | "toolText"
  | "toolRect"
  | "frameBack"
  | "frameForward"
  | "secondBack"
  | "secondForward"
  | "selectionStart"
  | "selectionEnd"
  | "timelineStart"
  | "timelineEnd"
  | "shuttleBack"
  | "stop"
  | "shuttleForward"
  | "bringFront"
  | "sendBack"
  | "selectParent"
  | "selectChildren"
  | "deselect"
  | "nudgeLeft"
  | "nudgeRight"
  | "nudgeUp"
  | "nudgeDown"
  | "nudgeLeftFast"
  | "nudgeRightFast"
  | "nudgeUpFast"
  | "nudgeDownFast"
  | "export"
  | "back"
  | "import";

type Combo = { key: string; mod?: boolean; shift?: boolean; alt?: boolean };

export const SHORTCUTS: { combo: Combo; action: ActionName }[] = [
  { combo: { key: "z", mod: true, shift: false }, action: "undo" },
  { combo: { key: "z", mod: true, shift: true }, action: "redo" },
  { combo: { key: "y", mod: true }, action: "redo" },
  { combo: { key: "backspace", shift: false }, action: "delete" },
  { combo: { key: "delete", shift: false }, action: "delete" },
  // Học Palmier §B4: Shift+Backspace xoá và kéo các clip phía sau lên lấp chỗ.
  { combo: { key: "backspace", shift: true }, action: "rippleDelete" },
  { combo: { key: "m", mod: false, shift: false, alt: false }, action: "addMarker" },
  { combo: { key: "delete", shift: true }, action: "rippleDelete" },
  { combo: { key: "d", mod: true, shift: false }, action: "duplicate" },
  { combo: { key: "d", mod: true, shift: true }, action: "back" },
  { combo: { key: "i", mod: true }, action: "import" },
  { combo: { key: "g", mod: true, shift: false }, action: "group" },
  { combo: { key: "g", mod: true, shift: true }, action: "ungroup" },
  { combo: { key: "enter", mod: true, shift: false, alt: false }, action: "wrapScene" },
  { combo: { key: "enter", mod: true, alt: true, shift: false }, action: "wrapSequence" },
  { combo: { key: "enter", mod: true, alt: true, shift: true }, action: "unwrapSequence" },
  { combo: { key: "b", mod: true }, action: "split" },
  { combo: { key: "c", mod: true }, action: "copy" },
  { combo: { key: "v", mod: true }, action: "paste" },
  { combo: { key: "x", mod: true }, action: "cut" },
  { combo: { key: "h", mod: true, shift: true }, action: "toggleHidden" },
  { combo: { key: "a", mod: true }, action: "selectAll" },
  { combo: { key: "=", mod: true }, action: "zoomIn" },
  { combo: { key: "+", mod: true }, action: "zoomIn" },
  { combo: { key: "-", mod: true }, action: "zoomOut" },
  { combo: { key: "0", mod: true }, action: "zoomActual" },
  { combo: { key: "1", mod: true }, action: "zoomFit" },
  { combo: { key: "2", mod: true }, action: "zoomSelection" },
  { combo: { key: "e", mod: true }, action: "export" },
  { combo: { key: "v", mod: false }, action: "toolMove" },
  { combo: { key: "h", mod: false }, action: "toolHand" },
  { combo: { key: "f", mod: false }, action: "toolScene" },
  { combo: { key: "t", mod: false }, action: "toolText" },
  { combo: { key: "r", mod: false }, action: "toolRect" },
  { combo: { key: "a", mod: false }, action: "frameBack" },
  { combo: { key: "d", mod: false }, action: "frameForward" },
  { combo: { key: "w", mod: false }, action: "secondForward" },
  { combo: { key: "s", mod: false }, action: "secondBack" },
  { combo: { key: ";", mod: false }, action: "selectionStart" },
  { combo: { key: "'", mod: false }, action: "selectionEnd" },
  { combo: { key: "home" }, action: "timelineStart" },
  { combo: { key: "end" }, action: "timelineEnd" },
  { combo: { key: "j", mod: false }, action: "shuttleBack" },
  { combo: { key: "k", mod: false }, action: "stop" },
  { combo: { key: "l", mod: false }, action: "shuttleForward" },
  { combo: { key: "]", mod: false }, action: "bringFront" },
  { combo: { key: "[", mod: false }, action: "sendBack" },
  { combo: { key: "\\", mod: false }, action: "selectParent" },
  { combo: { key: "enter", mod: false }, action: "selectChildren" },
  { combo: { key: "escape" }, action: "deselect" },
  { combo: { key: "arrowleft", shift: false }, action: "nudgeLeft" },
  { combo: { key: "arrowright", shift: false }, action: "nudgeRight" },
  { combo: { key: "arrowup", shift: false }, action: "nudgeUp" },
  { combo: { key: "arrowdown", shift: false }, action: "nudgeDown" },
  { combo: { key: "arrowleft", shift: true }, action: "nudgeLeftFast" },
  { combo: { key: "arrowright", shift: true }, action: "nudgeRightFast" },
  { combo: { key: "arrowup", shift: true }, action: "nudgeUpFast" },
  { combo: { key: "arrowdown", shift: true }, action: "nudgeDownFast" },
];

type KeyInput = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

export function matchShortcut(event: KeyInput): ActionName | null {
  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  for (const { combo, action } of SHORTCUTS) {
    if (combo.key !== key) continue;
    if (combo.mod !== undefined && combo.mod !== mod) continue;
    if (combo.shift !== undefined && combo.shift !== event.shiftKey) continue;
    if (combo.alt !== undefined && combo.alt !== event.altKey) continue;
    return action;
  }
  return null;
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const KEY_LABEL: Record<string, string> = {
  enter: "↵",
  backspace: "⌫",
  delete: "⌦",
  escape: "Esc",
  home: "Home",
  end: "End",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
};

/** Phím đầu tiên của một lệnh, viết như menu: "⇧⌘G" trên Mac, "Ctrl+Shift+G" ở máy khác. */
export function shortcutLabel(action: ActionName): string | null {
  const found = SHORTCUTS.find((entry) => entry.action === action);
  return found ? comboLabel(found.combo) : null;
}

function comboLabel(combo: Combo): string {
  const key = KEY_LABEL[combo.key] ?? combo.key.toUpperCase();
  if (isMac()) return `${combo.shift ? "⇧" : ""}${combo.alt ? "⌥" : ""}${combo.mod ? "⌘" : ""}${key}`;
  return [combo.mod ? "Ctrl" : "", combo.shift ? "Shift" : "", combo.alt ? "Alt" : "", key].filter(Boolean).join("+");
}

/**
 * Bảng tra phím cho hộp thoại Keyboard shortcuts (Help), như trang Help của
 * DS. Đọc từ chính `SHORTCUTS` nên không lệch được với phím thật; lệnh có hai
 * phím (Redo, Delete, Zoom in) in cả hai.
 */
export const SHORTCUT_GROUPS: { title: string; actions: [ActionName, string][] }[] = [
  {
    title: "General",
    actions: [
      ["undo", "Undo"],
      ["redo", "Redo"],
      ["copy", "Copy"],
      ["cut", "Cut"],
      ["paste", "Paste"],
      ["duplicate", "Duplicate"],
      ["delete", "Delete"],
      ["rippleDelete", "Delete and close the gap"],
      ["import", "Import from computer"],
      ["export", "Export"],
      ["back", "Back to project"],
    ],
  },
  {
    title: "Tools",
    actions: [
      ["toolMove", "Move"],
      ["toolHand", "Hand"],
      ["toolScene", "Scene"],
      ["toolText", "Text"],
      ["toolRect", "Rectangle"],
    ],
  },
  {
    title: "Selection and layers",
    actions: [
      ["selectAll", "Select all"],
      ["selectParent", "Select parent"],
      ["selectChildren", "Select children"],
      ["deselect", "Deselect"],
      ["group", "Group"],
      ["ungroup", "Ungroup"],
      ["wrapScene", "Wrap in scene"],
      ["wrapSequence", "Wrap in sequence"],
      ["unwrapSequence", "Unwrap sequence"],
      ["oneRow", "Put on one row"],
      ["bringFront", "Bring to front"],
      ["sendBack", "Send to back"],
      ["toggleHidden", "Show/Hide"],
      ["nudgeLeft", "Nudge left"],
      ["nudgeLeftFast", "Nudge left ×10"],
    ],
  },
  {
    title: "Playback and timeline",
    actions: [
      ["nudgeUp", "Previous cut (nothing selected)"],
      ["nudgeDown", "Next cut (nothing selected)"],
      ["shuttleBack", "Play backward"],
      ["stop", "Pause"],
      ["shuttleForward", "Play forward"],
      ["frameBack", "Previous frame"],
      ["frameForward", "Next frame"],
      ["secondBack", "Back 1 second"],
      ["secondForward", "Forward 1 second"],
      ["selectionStart", "Go to selection start"],
      ["selectionEnd", "Go to selection end"],
      ["timelineStart", "Go to start"],
      ["timelineEnd", "Go to end"],
      ["split", "Split at playhead"],
      ["addMarker", "Add a marker at the playhead"],
    ],
  },
  {
    title: "View",
    actions: [
      ["zoomIn", "Zoom in"],
      ["zoomOut", "Zoom out"],
      ["zoomActual", "Zoom to 100%"],
      ["zoomFit", "Zoom to fit"],
      ["zoomSelection", "Zoom to selection"],
    ],
  },
];

/** Mọi phím của một lệnh, theo thứ tự trong bảng. */
export function shortcutLabels(action: ActionName): string[] {
  return SHORTCUTS.filter((entry) => entry.action === action).map((entry) => comboLabel(entry.combo));
}
