# Three-column shell for UI v2 — plan

Owner request, 2026-10-30. Design canvas, in the v2 tokens below (all screens, the editor at 1440/1280/1024, the parts):
https://claude.ai/artifact/5E6W7sADybZEkzpEZVHurF

## What the owner asked for

1. Three columns, like the Claude Code app: **rail** (pick a tab, see its status) · **chat** (the CMO, always there) ·
   **tab panel** (the screen the rail opened).
2. Every column is **resizable** by dragging the border between them.
3. **The right column is always the widest** (it is where you look at things); **the rail is always the narrowest**.
4. **Status lines sit under the item title** in the rail (two lines per item), not beside it.
5. Use the **current landing tokens** ("pixel", Landing v4), to the pixel.

## Why it is worth it

The editor is the spearhead and the pitch is "an editor you drive from a slash command". Today the CMO chat is a
column inside the Dashboard and the editor's Assistant is a tab inside the editor: two chats, neither visible from
the other screens. One fixed chat beside whatever is open is the product the landing describes, and it is the shot
every marketing video needs: type `/edit` on the left, watch the edit happen on the right.

## Decisions

### Tokens: `--v2-*` only

`apps/web/styles/ui-v2.css` already holds the Landing v4 tokens (`--v2-paper`, `--v2-ink`, `--v2-line`,
`--v2-brand`, `--v2-brand-deep`, `--v2-char*`, `--v2-mono`, `--v2-radius: 4px`, `--v2-target: 44px`), copied from
`landing.css`. The shell uses those and nothing else; no new colour. The pixel details that make it read as the
landing:

- Status marks are **squares** (`.v2-mark`, 8×8, no radius), never round dots; live = `.v2-mark.is-live` (stepped
  pulse, off under reduced motion).
- Headings in the rail and status lines are `--v2-mono` uppercase, 11 px, `.12em` tracking.
- The current item is the inverted block the rail already uses (`--v2-ink` ground, `--v2-paper` text).
- Borders are 1 px `--v2-line`; the resize handle shows `--v2-brand` only while hovered, focused or dragged.
- The tab panel's editor tab keeps the dark `--v2-char` ground.

### Widths

| Column | Default | Min | Max | Rule |
|---|---|---|---|---|
| Rail | 216 px | 184 px | 264 px | Always the narrowest. Collapses to a 56 px icon strip (button or `⌘B`). |
| Chat | 400 px | 340 px | 560 px | Never wider than the panel. |
| Tab panel | the rest (`1fr`) | 480 px | — | Always the widest; it takes every pixel the others leave. |

Invariants, enforced in one pure function `clampColumns(viewport, rail, chat)` and unit-tested:

- `rail < chat ≤ panel` at every viewport width.
- When the window shrinks, take from the chat first (down to 340), then collapse the rail to 56, then switch to the
  compact layout below.
- A drag that would break an invariant stops at the limit; it does not push the other column.

Layout: one CSS grid on `.v2-shell`,
`grid-template-columns: var(--v2-col-rail) 1px var(--v2-col-chat) 1px minmax(480px, 1fr)`. Dragging only writes the
two custom properties on `<html>` (no React re-render per pointer move); the stored values are read back on release.

Below 1100 px (compact): rail at 56, the chat becomes a drawer over the panel's left edge, opened from a "Chat"
button in the tab strip. At 760 px and below the phone layout stays as today (`TabBar`), plus "Chat" as the first
tab.

### Resize handles

Our own component, not a dependency (≈120 lines): `react-resizable-panels` (MIT) works in percentages and its
layout is React state, and we need pixels and zero re-renders. We copy its accessibility contract, not its code:

- `role="separator"`, `aria-orientation="vertical"`, `aria-valuenow/min/max` in px, `aria-controls` the left column,
  a label ("Resize rail", "Resize chat"), `tabIndex=0`.
- Arrow keys ±16 px (Shift ±64), Home/End to min/max, Enter or double-click resets to the default.
- Pointer: `setPointerCapture`, `cursor: col-resize` on `<html>` while dragging, `user-select: none`; 1 px line with
  an 8 px invisible hit area (VS Code's sash does the same).

### Persistence without a jump

Widths and the collapsed rail live in `localStorage` (`opencmo.columns` = `{rail, chat, railCollapsed, panelHidden}`).
`app/app/layout.tsx` already boots `opencmo.rail` and the theme before the first frame; add `COLUMNS_BOOT` next to
`RAIL_BOOT`, which reads the key, clamps it and sets `--v2-col-rail` / `--v2-col-chat` on `<html>`. The server HTML
renders the defaults; the script fixes them before paint, so there is no flash. Bad or missing values fall back to
the defaults. Per-device by design: a laptop and a big screen want different widths.

### The rail: status under the title

Each item becomes two lines:

```
■ Dashboard            ← 14 px Inter, 500
  3 WAITING ON YOU     ← 11 px mono, --v2-ink2; --v2-brand-deep when it needs the user
```

Status lines show **only data the shell already has**; no line rather than a made-up one:

| Item | Source today | Line |
|---|---|---|
| Dashboard | `ShellState.pending` | `N waiting on you` |
| any department | `ShellState.stuck` | `Stuck` (red square, `--v2-stuck`) |
| Studio | `useActiveJobs().active` | `N processing` (live square) |
| Editor | `useActiveJobs` render/export tasks | `Rendering 64%` once the task reports progress |

Schedule's "next post at" and Sales' "N new threads" need a count endpoint each; they come with P4 / Sales work, not
here. An open tab gets an outlined square before its title; the current tab is the inverted block. In the 56 px
strip only the icon and the square remain, and the status goes into the tooltip and the accessible name.

### Column 3 is the route

The URL stays the source of truth: clicking a rail item is still `router.push(href)`, and the page renders in column
3 through `{children}` as today. The **tab strip** on top of column 3 lists the routes opened this session (kept in
`sessionStorage`, max 8, oldest dropped). Closing the current tab navigates to its neighbour; Dashboard is pinned and
cannot be closed, so column 3 is never empty. Clicking the current item in the rail again hides column 3 (`⌘\`
too), and the chat widens to the space; the panel stays mounted so its state survives.

### Column 2 is the CMO chat, moved into the shell

`components/cmo/workspace/ChatPanel.tsx` already talks to the `cmo` scope of the Assistant loop. It moves from the
Dashboard into `ShellV2`, so it lives in the layout and survives navigation like the Realtime channel does. The
Dashboard drops its own chat column. The composer shows a context chip for the open tab ("Writer", "Sales · thread")
and sends `{segment, ids}` with the turn, so "make this shorter" means the thing on screen. Session state is already
server side (`agent_sessions`), so nothing about storage changes.

### The editor (last step, the one that matters most)

Today `/app/editor` and `/app/video` render the classic `WebShell` at full width (`CLASSIC` in `ShellV2.tsx`) and
have their own Assistant tab (`clip` scope). The end state: the editor is a column-3 tab, and while it is the active
tab the chat column **is** that clip's Assistant (`AssistantPanel`, `clip` scope), with a header that says
"Editing · launch-demo". Two chats on screen would be one too many. This needs its own research note before it is
built (canvas width vs the timeline, keyboard shortcuts that the chat must not steal, the capture tools that read the
editor's canvas), so it is step S4 and keeps `CLASSIC` until then.

## Steps

Each step is one PR into the v2 branch, behind `NEXT_PUBLIC_OPENCMO_UI=v2` (production unchanged).

| Step | Scope | Files | Done when |
|---|---|---|---|
| S1 Columns | grid, two handles, `clampColumns`, `COLUMNS_BOOT`, compact and phone fallbacks; chat column shows a placeholder | `shell-v2/ShellV2.tsx`, new `shell-v2/columns.ts`, `shell-v2/Sash.tsx`, `app/app/layout.tsx`, `styles/ui-v2.css` | drag + keyboard resize, reload keeps widths with no flash, invariants unit-tested at 1024 / 1280 / 1440 / 1920 |
| S2 Rail + tab strip | two-line items with status, 56 px strip, open-tab marks, `TabStrip` on column 3, hide panel | `shell-v2/Rail.tsx`, `nav.ts` (icons), new `shell-v2/TabStrip.tsx`, `ui-v2.css` | statuses match the Dashboard numbers; closing tabs never leaves column 3 empty |
| S3 Chat in the shell | `ChatPanel` in column 2, removed from the Dashboard, context chip of the open tab | `ShellV2.tsx`, `cmo/workspace/ChatPanel.tsx`, `CmoWorkspace.tsx`, the cmo turn route (accept the context) | one chat survives navigation; a turn sees the open tab |
| S4 Editor joins | research note first; then editor as a column-3 tab, chat column switches to clip scope | `ShellV2.tsx` (`CLASSIC` gone), `editor/EditorShell.tsx`, `AssistantPanel.tsx` | a full `/edit` → export run in the new frame, and the video below |

Rough size: S1 1 day, S2 1 day, S3 1–2 days, S4 3–4 days after its research.

## Checks

- `npm run typecheck && npm run build`; `cd apps/web && npm run check:contracts && npm run test:e2e`.
- New e2e: resize by keyboard, reload keeps widths, `rail < chat ≤ panel` after resizing the window, closing the last
  tab lands on Dashboard, axe clean on the frame (separators named, focus visible).
- **Look at it** (CLAUDE.md, Verify by looking): screenshots at 1440, 1280, 1024 and 390 wide, light and dark; the
  rail's status lines must not wrap or clip at 184 px.
- No migration, no credit path touched.

## Marketing video

S4 ends with a real video made in the editor and kept as landing material: a screen recording of the new workspace,
`/edit` typed in the chat, the edit landing in the editor tab beside it, cut and captioned in OpenCMO itself.

## Not in this plan

Count endpoints for Schedule and Sales status lines; multiple chats side by side; dragging tabs into a split view.
Note them in the PR if they come up.
