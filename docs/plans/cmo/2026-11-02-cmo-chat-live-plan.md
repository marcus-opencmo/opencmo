# CMO chat live: results come back to the chat, long chats stay fast, answers can be rated

> **For agentic workers:** branch **`plan/cmo-chat-live`**, PR into `cmo-build`. One session, in the order of §5.
> Source: the chat-control audit ([`../../research/agents/2026-11-01-cmo-chat-control-audit.md`](../../research/agents/2026-11-01-cmo-chat-control-audit.md),
> "Độ mượt" §4), and #138's follow-ups (session growth, ratings, the history menu).

## 0. Scope

Today the CMO chat hands work out and then goes quiet:
- The founder has to ask again ("is it done?"), and the model has to call `get_run_result` in a loop.
- One CMO conversation is reused forever and its history is never trimmed, so it grows until the model's context
  limit and then every message fails.
- The thumbs buttons store nothing.

This phase makes the chat behave like Claude: work finishes and says so in the chat, a long conversation keeps
working, and a rating is kept.

**Status:** plan, with the owner's go-ahead on 2026-11-02.

**Not in this phase:** push or email for finished runs (P6 digest/push already covers cards); streaming partial job
output.

## 1. Goal and decisions

**Goal:**
- "Draft a post about the launch" → the chat says "Drafting…". Under a minute later it says "Your draft is ready:
  3 versions, in Approvals", and column 3 shows the card.
- A conversation of 200 turns still answers.

**Decisions:**
1. **The finished run comes to the chat by realtime, with a short wait as the fallback.**
   - Add `cmo_runs` to the `supabase_realtime` publication. Its RLS already limits a founder to their own rows.
   - `ChatPanel` subscribes to `cmo_runs` updates for the runs it started this session.
   - A `wait_for_run` tool (as `wait_for_media` does in clip scope) lets the model wait up to 45 s within a turn when
     the founder asked to wait.
2. **What the founder sees when a run finishes:** a short system line in the chat ("Draft ready: 3 versions. Open
   Approvals") and `view.open` for its screen. It is **not** a new model turn: no credits are spent and no text is
   invented. The next message the founder sends carries `<runs_finished>` in its context, so the model knows.
3. **Long conversations:**
   - **Context editing on by default for the CMO scope.** Anthropic's `clear_tool_uses_20250919` is already wired
     (`lib/agent/providers/anthropic.ts`); today it is behind `OPENCMO_AGENT_CONTEXT_EDITING`.
   - **A rolling cut for every provider:** `history()` sends at most the last N turns of a CMO session (N = 30),
     cut on a turn boundary so tool calls stay paired.
   - **A new chat after 200 turns,** opened automatically, with the old one in "Past conversations".
4. **Ratings** go to a new `agent_turn_ratings` table: one row per turn (`session_id`, `turn_number`, `rating` up or
   down, an optional `reason` of at most 300 characters). It is written through an RPC with its own rate-limit bucket.
5. **The history menu** reads `GET /agent/sessions?scope=cmo&list=1`, which returns only the list, without rebuilding
   the session view.

## 2. What ships

| # | Feature | The founder sees | Done when |
|---|---|---|---|
| F1 | Finished runs in the chat | "Draft ready. Open Approvals" appears in the chat by itself, and column 3 moves to the card's screen. | `cmo_runs` is in the realtime publication (migration plus pgTAP). `ChatPanel` subscribes, filtered to the run ids it saw in `create_task` results, and adds a system line on `done` or `failed`. It survives a reload: the session view rebuilds the lines from the runs' finished state. |
| F2 | `wait_for_run` | "Draft it and show me" → the reply arrives in the same turn, when the run takes under ~45 s. | A tool that polls `cmo_runs` every 3 s for at most 45 s, then returns the run's status and summary. It is counted in the turn's steps. |
| F3 | Runs in the next turn's context | "Make the second one shorter", after a draft finished, refers to the right card. | `<runs_finished>` (run kind, result summary, card ids) is added to the turn's context for runs that finished since the last turn. It is data, not instructions. |
| F4 | Long chats keep working | A conversation of 200 turns answers like a new one. | `history()` sends the last 30 turns for CMO sessions, cut cleanly. Context editing is on for the CMO scope. A new session opens after 200 turns, with a line "Started a new conversation; the old one is in Past conversations". |
| F5 | Ratings kept | Thumbs up or down stays after a reload, and the owner can read them. | `agent_turn_ratings` (migration, RLS, grants, pgTAP) and `rate_agent_turn(p_session, p_turn, p_rating, p_reason)` with bucket `feedback-turn` 60/h. `ChatPanel` uses turn numbers as ids. |
| F6 | Lighter history menu | — | The `list=1` query returns only `sessions`. |
| F7 | Acceptance | | Fake model: `create_task` → the fake run completes → the line shows in the chat. A 40-turn fake session sends ≤ 30 turns. A rating survives a reload. Screenshots at 1440 and 390. |

## 3. What exists (cmo-build `5a99ddd`)

- **Runs:**
  - `cmo_runs` is finished by `complete_cmo_run` (`lib/cmo/jobs/store.ts`, `lib/cmo/jobs/runner.ts`). Nothing
    notifies the chat.
  - The realtime publication has `jobs`, `clips`, `tasks`, `media_assets`, `generations`, `approvals`,
    `work_orders`, `deliverables`, `work_order_events`, `studio_steps`, `short_batches` and `shorts`. It does not
    have `cmo_runs`.
- **Client realtime:** `components/clipping/useLive.ts` (`postgres_changes`), used by `useDashboard.ts` and
  `ActiveJobs.tsx`.
- **Waiting:** `lib/agent/wait-tool.ts` polls `generations` every 3 s for up to 60 s (clip scope).
  `get_run_result` lives in `lib/agent/cmo-tools.ts`.
- **History:**
  - `history()` (`lib/agent/loop.ts`) pages every message, with no limit, since #138.
  - `agent_open_cmo_session` reuses the latest session.
  - Context editing is `lib/agent/providers/anthropic.ts:30-54`, off unless `OPENCMO_AGENT_CONTEXT_EDITING=1`, and
    Anthropic only.
- **Ratings:** `ChatPanel.tsx` keeps `rated` as local state only. The `editor_feedback` / `send_feedback` RPC is the
  pattern to follow, but its categories do not fit.
- **History menu:** `ChatPanel.tsx` opens past conversations through `GET /agent/sessions`, which rebuilds the whole
  `sessionView`.

## 4. Research

- **Anthropic context editing** (`clear_tool_uses_20250919`): clears old tool results past a token trigger. We
  already send it with trigger 80k, keep 6 and clear at least 20k, but behind a flag. Turning it on for the CMO
  scope is the cheapest win, because CMO tool results (documents, research) are the bulk of the history.
- **Rolling window vs summary:** a summary costs a model call per cut and can drop facts. The CMO already keeps
  durable facts in `cmo_memories` and the documents, sent fresh in every turn's context. So a plain window of the
  last 30 turns loses little. **Recommendation:** use the window, and no summary.
- **Realtime vs polling:** Supabase realtime is already used for `jobs` and `approvals`. Polling in the browser
  would hit the API every few seconds per open tab. Realtime plus a short in-turn wait covers both "I'm watching"
  and "tell me when".

## 5. Tasks

| Task | What | Waits on |
|---|---|---|
| **A0** | **Contracts.** Migration `20270103010000_cmo_chat_live.sql`: `cmo_runs` added to `supabase_realtime`; table `agent_turn_ratings` (RLS: own rows only; grants: `select` to authenticated, all to service_role); RPC `rate_agent_turn`; the `feedback-turn` bucket in `rate_limit_hit`. pgTAP `242_cmo_chat_live`. Types: `RunLine` in `lib/agent/view.ts`. | — |
| A1 | **Finished runs.** `ChatPanel` keeps the run ids from `create_task` results and subscribes through `useLive("cmo_runs", …)`. On `done` / `failed` it adds a line and calls `openPanel` with the run's screen. `sessionView` adds `runs: {id, kind, status, summary}` for runs started from the session (by run id in the tool results). | A0 |
| A2 | **`wait_for_run`** in `cmo-tools.ts` (at the end of the tool list, hidden from MCP), modelled on `wait-tool.ts`. | — |
| A3 | **`<runs_finished>`** context in `cmoContext`: runs of this founder finished since the session's last turn, at most 5, with summaries from `cmo_runs.output`. Escaped. | A1 |
| A4 | **Long chats.** `history()` takes `maxTurns` for the CMO scope (30), cutting on turn boundaries with `provider.danglingCalls` kept consistent. Context editing is on for `scope.kind === "cmo"`, whatever the flag. A new session after 200 turns: `agent_open_cmo_session` gets `p_max_turns`, or the route checks the count. | — |
| A5 | **Ratings UI and the history menu.** The thumbs call `rate_agent_turn`; the state is loaded with the session view. `list=1` on the sessions route. | A0 |
| A6 | **Checks and acceptance.** `cmo-live.check.ts` covers the window cut with tool pairs and the line building. The fake runner completes a run in the e2e. Screenshots. `/code-review` on the diff. | A1–A5 |

## 6. Owner gates

1. Whether ratings may later feed the CMO's memory, e.g. "the founder disliked long answers". The default is that
   they are stored only.

## 7. Review focus

- `cmo_runs` in realtime exposes only the founder's own rows (RLS). Check `output` holds nothing a founder should not
  see.
- The window never cuts a tool call from its result (provider 400).
- A finished-run line never starts a model turn and never spends credits.
- The rating RPC checks session ownership.
