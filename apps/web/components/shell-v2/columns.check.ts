/** The three-column shell's widths: the invariant at real window sizes, and the boot script agreeing with the code. */

import assert from "node:assert/strict";

import { CHAT, COLUMNS_BOOT, COMPACT_BELOW, DEFAULT_PREF, PANEL_MIN, RAIL, clampColumns, parsePref, type ColumnsPref } from "./columns";

const prefs: ColumnsPref[] = [
  DEFAULT_PREF,
  { rail: RAIL.max, chat: CHAT.max, railCollapsed: false },
  { rail: RAIL.min, chat: CHAT.min, railCollapsed: false },
  { rail: 9999, chat: 9999, railCollapsed: false },
  { rail: -5, chat: -5, railCollapsed: false },
  { rail: RAIL.base, chat: 480, railCollapsed: true },
];

for (const viewport of [COMPACT_BELOW, 1280, 1366, 1440, 1920, 2560]) {
  for (const pref of prefs) {
    const { rail, chat } = clampColumns(viewport, pref);
    const panel = viewport - rail - chat - 2;
    assert.ok(rail < chat, `rail < chat at ${viewport}: ${rail} vs ${chat}`);
    assert.ok(chat <= panel, `chat ≤ panel at ${viewport}: ${chat} vs ${panel}`);
    assert.ok(panel >= PANEL_MIN, `panel ≥ ${PANEL_MIN} at ${viewport}: ${panel}`);
    assert.ok(chat >= CHAT.min && chat <= CHAT.max, `chat within limits at ${viewport}: ${chat}`);
  }
}

assert.deepEqual(
  { ...clampColumns(1440, DEFAULT_PREF), chatMax: 0 },
  { rail: RAIL.base, chat: CHAT.base, railCollapsed: false, chatMax: 0 },
  "defaults fit at 1440 untouched",
);
assert.equal(clampColumns(1280, { ...DEFAULT_PREF, chat: CHAT.max }).chat, 531, "1280: the chat gives way first");
assert.equal(clampColumns(1000, DEFAULT_PREF).railCollapsed, true, "too narrow for the rail: it collapses");
assert.deepEqual(parsePref("not json"), DEFAULT_PREF, "a broken value falls back to the defaults");
assert.deepEqual(parsePref('{"rail":"x","chat":450}'), { ...DEFAULT_PREF, chat: 450 });

// The boot script runs outside the bundle; run it against the same inputs and compare.
function boot(viewport: number, stored: string | null, pathname = "/app") {
  const vars: Record<string, string> = {};
  const dataset: Record<string, string> = {};
  const document = { documentElement: { style: { setProperty: (name: string, value: string) => (vars[name] = value) }, dataset } };
  const localStorage = { getItem: () => stored };
  new Function("localStorage", "innerWidth", "document", "location", COLUMNS_BOOT)(localStorage, viewport, document, { pathname });
  return { rail: parseInt(vars["--v2-col-rail"], 10), chat: parseInt(vars["--v2-col-chat"], 10), railCollapsed: dataset.v2Rail === "collapsed" };
}

for (const viewport of [900, COMPACT_BELOW, 1280, 1440, 1920]) {
  for (const stored of [null, "garbage", ...prefs.map((pref) => JSON.stringify(pref)), '{"rail":"x","chat":450}', '{"rail":null,"chat":"500"}']) {
    const { chatMax: _chatMax, ...expected } = clampColumns(viewport, parsePref(stored));
    assert.deepEqual(boot(viewport, stored), expected, `boot agrees with clampColumns at ${viewport} for ${stored}`);
  }
}

for (const viewport of [1280, 1440]) {
  const { chatMax: _chatMax, ...expected } = clampColumns(viewport, { ...DEFAULT_PREF, railCollapsed: true });
  assert.deepEqual(boot(viewport, null, "/app/editor/abc"), expected, `the editor boots with the rail as the icon strip at ${viewport}`);
}

console.log("columns.check: ok");
