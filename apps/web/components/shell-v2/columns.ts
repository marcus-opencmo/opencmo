/**
 * Column widths of the three-column shell (docs/plans/cmo/2026-10-30-three-column-shell-plan.md): rail · chat · tab
 * panel. The rail is always the narrowest and the panel always the widest: `rail < chat ≤ panel` at every desktop width.
 *
 * Pure, so `columns.check.ts` can hold the invariant, and mirrored by `COLUMNS_BOOT`, which sets the widths before the
 * first frame (the check runs both on the same inputs, so they cannot drift apart).
 */

export const RAIL = { min: 184, max: 264, base: 216, collapsed: 56 } as const;
export const CHAT = { min: 340, max: 560, base: 400 } as const;
export const PANEL_MIN = 480;
/** Below this the chat is a drawer and the rail an icon strip; `ui-v2.css` uses the same number. */
export const COMPACT_BELOW = 1100;

const SASHES = 2;
const KEY = "opencmo.columns";

/** What the person chose; the shell may show less when the window is too narrow, without forgetting the choice. */
export type ColumnsPref = { rail: number; chat: number; railCollapsed: boolean };
export type Columns = { rail: number; chat: number; railCollapsed: boolean; chatMax: number };

export const DEFAULT_PREF: ColumnsPref = { rail: RAIL.base, chat: CHAT.base, railCollapsed: false };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function chatMaxFor(viewport: number, rail: number): number {
  const free = viewport - rail - SASHES;
  // floor(free / 2) keeps the panel at least as wide as the chat.
  return Math.min(CHAT.max, Math.floor(free / 2), free - PANEL_MIN);
}

/** Shrinking takes from the chat first, then collapses the rail. */
export function clampColumns(viewport: number, pref: ColumnsPref): Columns {
  let collapsed = pref.railCollapsed;
  let rail = collapsed ? RAIL.collapsed : clamp(pref.rail, RAIL.min, RAIL.max);
  let chatMax = chatMaxFor(viewport, rail);
  if (!collapsed && chatMax < CHAT.min) {
    collapsed = true;
    rail = RAIL.collapsed;
    chatMax = chatMaxFor(viewport, rail);
  }
  chatMax = Math.max(CHAT.min, chatMax);
  return { rail, chat: clamp(pref.chat, CHAT.min, chatMax), railCollapsed: collapsed, chatMax };
}

export function parsePref(raw: string | null): ColumnsPref {
  try {
    const value = JSON.parse(raw ?? "null") as Partial<ColumnsPref> | null;
    return {
      rail: Number.isFinite(value?.rail) ? Number(value?.rail) : RAIL.base,
      chat: Number.isFinite(value?.chat) ? Number(value?.chat) : CHAT.base,
      railCollapsed: value?.railCollapsed === true,
    };
  } catch {
    return DEFAULT_PREF;
  }
}

export function readPref(): ColumnsPref {
  try {
    return parsePref(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_PREF;
  }
}

export function writePref(pref: ColumnsPref): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pref));
  } catch {
    // Private mode or storage off: the widths last for this page only.
  }
}

/** Writes the widths where CSS reads them. During a drag this is the only thing that runs: no React render per move. */
export function applyColumns(columns: Pick<Columns, "rail" | "chat" | "railCollapsed">): void {
  const root = document.documentElement;
  root.style.setProperty("--v2-col-rail", `${columns.rail}px`);
  root.style.setProperty("--v2-col-chat", `${columns.chat}px`);
  if (columns.railCollapsed) root.dataset.v2Rail = "collapsed";
  else delete root.dataset.v2Rail;
}

const L = { rm: RAIL.min, rM: RAIL.max, rb: RAIL.base, rc: RAIL.collapsed, cm: CHAT.min, cM: CHAT.max, cb: CHAT.base, p: PANEL_MIN, s: SASHES };

/**
 * `clampColumns` + `applyColumns` before the first frame, for `app/app/layout.tsx`. In the editor the rail is always
 * the icon strip (`ShellV2` passes `railCollapsed: true` there), so the script does the same from the path. Hand-written ES5: it runs as an
 * inline script, outside the bundle. `columns.check.ts` runs it against `clampColumns` on the same inputs.
 */
export const COLUMNS_BOOT =
  `try{var L=${JSON.stringify(L)},c,w=innerWidth;try{c=JSON.parse(localStorage.getItem('${KEY}'))}catch(e){}c=c||{};` +
  "var n=function(v){return typeof v=='number'&&isFinite(v)};var col=c.railCollapsed===true||location.pathname.indexOf('/app/editor')===0,r=col?L.rc:Math.min(L.rM,Math.max(L.rm,n(c.rail)?c.rail:L.rb));" +
  "var mx=function(r){var f=w-r-L.s;return Math.min(L.cM,Math.floor(f/2),f-L.p)};var m=mx(r);" +
  "if(!col&&m<L.cm){col=true;r=L.rc;m=mx(r)}m=Math.max(L.cm,m);" +
  "var ch=Math.min(m,Math.max(L.cm,n(c.chat)?c.chat:L.cb)),d=document.documentElement;" +
  "d.style.setProperty('--v2-col-rail',r+'px');d.style.setProperty('--v2-col-chat',ch+'px');" +
  "if(col)d.dataset.v2Rail='collapsed'}catch(e){}";
