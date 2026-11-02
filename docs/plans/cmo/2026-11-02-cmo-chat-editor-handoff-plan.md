# CMO chat → editor handoff: video work asked in the chat, done in the editor

> **For agentic workers:** branch **`plan/cmo-chat-editor-handoff`**, PR into `cmo-build`. One session, in the order of
> §5. Source: the chat-control audit ([`../../research/agents/2026-11-01-cmo-chat-control-audit.md`](../../research/agents/2026-11-01-cmo-chat-control-audit.md),
> recommendation "Không làm": do not merge the clip Assistant into the CMO chat; hand off instead).

## 0. Scope

The CMO chat cannot do any of these today:
- start an edit;
- open the founder's video;
- check an export;
- pass a video request to the editor.

The founder has to leave the chat, find the project, and type the request again in the editor's Assistant. Video is
the spearhead (CLAUDE.md "Strategy"), so this matters most for the marketing videos.

This phase keeps two Assistants. The clip Assistant has about 60 tools and its own guards, and folding them into the
CMO chat would blur both. Instead, **the CMO chat hands off**:
- it finds or creates the edit;
- it opens the editor in column 3, with the founder's request already typed into the clip Assistant;
- the clip Assistant takes it from there.

**Status:** plan, owner go-ahead 2026-11-02.

**Not in this phase:**
- running clip tools from the CMO chat;
- uploading from the chat (the browser picks the file);
- export from the CMO chat (it stays a clip Assistant tool with its own price card).

## 1. Goal and decisions

**Goal:** "Make a 30-second demo of the new editor from yesterday's upload, with captions" becomes one message:
1. the CMO chat says "Opening your upload in the editor";
2. column 3 opens the editor on that clip;
3. the clip Assistant's box holds the request and sends it once the editor has loaded;
4. the founder follows along, or confirms the clip Assistant's own priced cards.

**Decisions:**
1. **`open_editor` tool** with `{clip_id?, new_edit?: {name, aspect, kind}, prompt?}`:
   - it checks the clip under RLS, as MCP's `open_in_editor` does;
   - it can create a blank edit through `create_blank_edit` (already limited to 60/h, `project-write`);
   - it returns `view.open` with the editor target.
2. **Finding the video:** `list_projects` and `list_clips` as read tools, the same reads as MCP's `find` group
   (`packages/mcp-server/src/groups/find.ts`), returning names, dates, durations and ids only.
3. **The prompt reaches the clip Assistant** through `?ask=<text>` on the editor URL:
   - `EditorShell` reads it into `assistantPrefill` (which `AssistantPanel` already takes) and then removes it from
     the URL;
   - with `&send=1` it sends once, when the founder asked "do it". Otherwise it waits for the founder to press Send.
   - Default: **send**, because the founder asked in the chat. Owner gate 1.
4. **Status from the CMO chat:** `get_export` (read; the latest export of a clip and its download link) and
   `list_versions` (read) for "is my video ready" and "go back to the version before".
5. **Context in the editor:** when column 3 is the editor, the turn context names the clip, `<on_screen>` editor plus
   the clip id. Today `screenOfPath` returns null there.

## 2. What ships

| # | Feature | The founder sees | Done when |
|---|---|---|---|
| F1 | `list_projects`, `list_clips` | "Which videos do I have?" → a short list in the chat. | Read tools under RLS, at most 20 rows, names cleaned as data. |
| F2 | `open_editor` | Column 3 opens the editor on the clip, or on a new blank edit. | `panel.ts` gets an editor target `{editor: {clip_id, prompt?, send?}}` → `/app/editor/<id>?ask=…&send=1`, validated (uuid, prompt ≤ 2000 characters). `ChatPanel` opens it. |
| F3 | The request lands in the clip Assistant | The clip Assistant's box holds the request and sends it once. | `EditorShell` reads `ask` and `send`, sets `assistantPrefill`, and on `send` calls the panel's send once (`AssistantPanel` gets `autoSend`). The URL is cleaned with `router.replace`. |
| F4 | Export and versions | "Is my export ready?" → "Yes, 1080p, 42 s: download"; "go back to before captions" → opens the version list. | `get_export` and `list_versions` as reads; restore stays in the editor (it writes). |
| F5 | Editor context | In the editor, the CMO chat column is replaced by the clip Assistant; going back to the CMO chat knows which clip was open. | `screenOfPath` returns `{name: "editor", clip_id}`; `ScreenContextSchema` accepts it. |
| F6 | Acceptance | | e2e with fakes: "open my upload and add captions" → the editor opens with the prompt sent. Screenshots at 1440 and 390. |

## 3. What exists (cmo-build `5a99ddd`)

- **Shell:**
  - `components/shell-v2/ShellV2.tsx`: `EDITOR = "editor"`, and `clipAssistantSlot` shows the clip Assistant in
    column 2 inside the editor.
  - `components/editor/EditorShell.tsx`: it portals `AssistantPanel` into the slot, reads `?panel` and `?view`, and
    holds `assistantPrefill`, which only `redoKeyframe` sets.
- **`AssistantPanel`** (`components/editor/assistant/AssistantPanel.tsx`) has `prefill?: {text, nonce}`. It puts the
  text in the draft and focuses the box, but does not send.
- **New edit:** `app/api/v1/editor/new` POST `{name?, aspect, kind}` → `create_blank_edit` / `create_slideshow`.
- **MCP groups to mirror:**
  - `packages/mcp-server/src/groups/find.ts`: `list_projects`, `list_clips`, `new_edit`, `open_in_editor`;
  - `export.ts`: `get_export`;
  - `versions.ts`: `list_versions`, `restore_version`.
- **Panel:** `lib/agent/panel.ts` builds screens from rail entries, and the editor entry (`NAV_MAKE`) has
  `screen: null`, so it is left out. `panel.check.ts` asserts the screen list.

## 4. Research

- **Descript and CapCut**: an AI request opens the project and runs there; the project is the unit, not the chat.
  Our clip Assistant already is that, so the handoff only has to land the request in the right place.
- **Prefill and send vs. a server-side turn:** starting the clip Assistant's turn on the server would run without the
  editor's browser tools (capture, playhead), which many clip tools need. Sending from the opened editor keeps them.
  **Recommendation:** prefill plus a one-time send in the browser.

## 5. Tasks

| Task | What | Waits on |
|---|---|---|
| **A0** | **Contracts.** `panel.ts`: an editor target (a separate schema branch, `PanelOpen` becomes a union), `panelHref`, `screenOfPath` for `/app/editor/<id>`, and `panel.check.ts` updated. Tool specs for `list_projects`, `list_clips`, `open_editor`, `get_export`, `list_versions`, at the end of the CMO list and hidden from MCP, which has its own versions of them. | — |
| A1 | **Reads.** The four read tools, reusing the queries of the MCP groups (move the shared parts to `lib/editor/find.ts` if both sides need them). | A0 |
| A2 | **`open_editor`.** Check the clip, or create the edit. `view.open` editor. A new edit counts as a write (`WRITES`, `TAINT_GATED_TOOLS`). | A0 |
| A3 | **Editor side.** `EditorShell` reads `ask` / `send`; `AssistantPanel` gets `autoSend` (sends once per nonce); the URL is cleaned. | A0 |
| A4 | **Context and prompt.** The editor in `<on_screen>`. `CMO_SYSTEM_PROMPT`: "For video, find the clip and open the editor with the founder's request; the editor's Assistant does the work." | A1–A3 |
| A5 | **Checks and acceptance.** The panel check, a fake-model task in `lib/agent/eval/cmo-tasks.ts`, the e2e, screenshots, and `/code-review`. | A1–A4 |

## 6. Owner gates

1. Whether `open_editor` sends the request at once (default) or only fills the box.

## 7. Review focus

- Every clip id is checked under the founder's RLS before the URL is built; the prompt is length-capped and only
  goes into the Assistant's input box.
- The send happens once per handoff (nonce), never on reload.
- No clip tool runs from the CMO scope.
