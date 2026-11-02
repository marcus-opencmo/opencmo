# CMO chat decisions: approve, schedule and set things from the chat

> **For agentic workers:** branch **`plan/cmo-chat-decisions`**, PR into `cmo-build`. One session builds it, in the
> order of §5. Nothing is built before A0 (the contracts) is pushed. Source: the chat-control audit
> ([`../../research/agents/2026-11-01-cmo-chat-control-audit.md`](../../research/agents/2026-11-01-cmo-chat-control-audit.md),
> recommendation 2, "Gắn vào OpenCMO" §2) and the review series R1–R6 (#138–#150).

## 0. Scope

The audit found that the CMO chat can read and hand out work, but every decision still needs a button:
- approving or skipping a card;
- choosing a time or an account;
- approving a goal;
- marking something posted or replied;
- changing Sales or CMO settings;
- pausing.

This phase lets the founder do each of those by asking in the chat. The chat shows a confirmation card, and the
founder confirms it in the chat. That is how a founder works with Claude: one sentence, one confirmation.

**Status:** plan, owner go-ahead 2026-11-02 ("open the PRs, then do each one until it is done").

**Not in this phase:**
- connecting accounts (OAuth needs the browser);
- billing and checkout;
- video editing (plan [`2026-11-02-cmo-chat-editor-handoff-plan.md`](2026-11-02-cmo-chat-editor-handoff-plan.md));
- anything that posts by itself (never).

## 1. Goal and decisions

**Goal:** "approve the pricing post for 9 am", "skip the second Reddit reply", "pause the CMO for a week" and "stop
showing r/memes" each become one message and one confirmation in the chat. Column 3 then shows the result.

**Decisions:**
1. **Assist, never act.** A decision tool never runs on the model's own initiative. It runs when the founder asked
   for it in this turn **and** confirmed the card the chat shows. That is the same rule as the Approve button,
   reached through a sentence. Nothing posts by itself; a post still goes out at its approved slot or is copied by
   the founder.
2. **The confirmation is a real card.** It uses the agent loop's existing approval path, `plan()` → `approval_request`
   → the founder's yes/no → `decide()`, which the clip Assistant already uses for priced tools. It is not a "yes"
   typed back to the model.
3. **The card's hash is taken on the server when the card is shown**, not passed by the model. If the card changed
   in between (edited elsewhere, expired), the decision is refused with "This card changed. Look at it again."
4. **Same writes as the buttons.** Every tool calls the RPC its UI route calls (§3). There is no new SQL path.
5. **`decided_via`:** the default is `'app'`, with `source: 'chat'` in the payload. SQL accepts only `app` and `mcp`
   (`approval_decide` checks `v_via`). Owner gate 1 decides whether to add `'chat'` in SQL.
6. **Not over MCP.** MCP has its own inbox path, so these tools are kept out of `CMO_TOOLS` (`lib/cmo/mcp/cmo.ts`
   exports every CMO tool spec today).
7. **After outside content, decisions wait.** The tools join `TAINT_GATED_TOOLS`: once a website or a social post was
   read in the turn, a decision needs the founder's next message.

## 2. What ships

| # | Feature | The founder sees | Done when |
|---|---|---|---|
| F1 | `decide_card` | "Approve the pricing post" leads to a card in the chat with the post's text and **Approve / Cancel**. On Approve the card in Approvals is approved, and column 3 shows the Dashboard. | Post approve/skip, reply replied/dismissed, goal approve/reject, correction, Studio approve/send_back, schedule approve/cancel all go through `approval_decide` with the server-held hash. |
| F2 | `schedule_card` | "Post it at 9 tomorrow on my LinkedIn" leads to a card naming the time in the founder's timezone and the account. | `change_time` / `change_account` through `approval_decide`. The time is resolved in the founder's timezone (`cmo_settings`); the account is one of their connected accounts. |
| F3 | `mark_done` | "I posted it, here's the link" / "I replied to that thread". | `cmo_mark_posted(p_url)`, `schedule_mark_posted`, `cmo_decide_opportunity('replied')`. |
| F4 | `set_sales_settings` | "Stop showing r/memes" / "only threads that mention invoices and late". | Read the current settings, merge, then `sales_settings_save`. The route replaces the whole list, so the tool adds or removes. |
| F5 | `set_cmo_paused`, `update_cmo_settings` | "Pause the CMO" / "budget 80 credits a week" / "send my digest at 7". | `cmo_pause` / `cmo_resume`; a read-modify-write of `save_cmo_settings`. |
| F6 | `get_credits` | "How many credits do I have?" | `account_summary` (read only, no card). |
| F7 | Cards in the CMO chat | A card with what will change, the price if any, and Approve / Cancel. It survives a reload. | `ChatPanel` renders `turn.pending` and `approval_request`, and posts the decision. |
| F8 | `list_approvals` with summaries | The chat can say "3 cards wait: the pricing post (X, 9:00), …". | Each waiting card's `title`, `summary`, `kind`, allowed actions and `postAt`, through `approvalToCard`. Never the hash, and never stranger text beyond the card's own title. |
| F9 | Acceptance | | e2e with the fake model: a turn asks to approve a waiting post, the card shows, Approve flips it to approved, and the Dashboard reloads. Screenshots at 1440 and 390. |

## 3. What exists (cmo-build `5a99ddd`)

- **Approval path in the loop** (`lib/agent/loop.ts`):
  - approvals are collected around line 430;
  - each is saved pending with `result.approval = card`;
  - the loop emits `approval_request {id, name, card}` (line 503) and `done awaiting_approval`;
  - `decide()` runs on resume (around 650); a missing answer counts as Cancel.
- **Scopes** (`lib/agent/scope.ts`): clip `plan()` returns `{kind: "approval", input, card}` (lines 257–396, e.g.
  `generateCard`). `cmoScope().plan()` always returns `run`, and its `decide()` throws.
- **Session view** (`lib/agent/view.ts`): `TurnView.pending` rebuilds cards from the pending rows, so cards survive a
  reload.
- **Routes:**
  - `app/api/v1/agent/sessions/[id]/approvals` takes `{decisions: [{tool_use_id, approved}]}`.
  - The clip panel sends decisions through `tool-results` (`components/editor/assistant/AssistantPanel.tsx`
    `decide`).
- **Card UI to reuse:** `AssistantPanel.tsx` renders the approval cards (the `changes` lines, the total, Approve and
  Cancel). The type lives in `components/editor/assistant/client.ts` (`ApprovalCard`).
- **CMO chat UI** (`components/cmo/workspace/ChatPanel.tsx`): no `pending` and no `approval_request` handling, and
  `done awaiting_approval` is dropped.
- **Decision RPCs (what the buttons call):**

  | Action | Route | RPC and input |
  |---|---|---|
  | Card decisions | `app/api/v1/approvals/[id]` | `approval_decide(p_id, p_action, p_payload)`; the payload needs `content_hash` and `via` (`app` or `mcp`). Allowed actions per kind are in `20261231150000_p5_sales_safety.sql`, around line 137. |
  | Posted, edit, remove | `cmo/items/[id]` | `cmo_mark_posted`, `cmo_update_item`, `cmo_remove_item` |
  | Goals | `cmo/goals/[id]` | `cmo_decide_goal` |
  | Replies | `cmo/opportunities/[id]` | `cmo_decide_opportunity` |
  | Schedule | `schedule/slots/[id]` | `schedule_change`, `schedule_mark_posted` |
  | Sales settings | `sales/settings` | `sales_settings_save`, which replaces both lists |
  | Pause | `cmo/pause` | `cmo_pause` / `cmo_resume` |
  | CMO settings | `cmo/settings` | `save_cmo_settings`; every field is required |
  | Credits | `account` | `account_summary` |

- **Cards for the chat:** `lib/screens/cards.ts` `APPROVAL_COLUMNS` and `approvalToCard`, and `enrichScheduleCards`
  for the timezone. `lib/screens/approval-card.ts` holds `PRIMARY_ACTION`, `STUDIO_ACTIONS` and `SCHEDULE_ACTIONS`.
- **Gates** (`lib/agent/cmo-tools.ts`): `WRITES`, `TAINT_GATED_TOOLS` and `TAINT_MESSAGE`, enforced in `loop.ts`
  (`turnTainted`).
- **MCP exposure:** `lib/cmo/mcp/cmo.ts:103` maps every `CMO_TOOL_SPECS` entry except `open_screen`.
- **Panel:** `view.open` (`lib/agent/panel.ts`), so a decision can open the screen it changed.

## 4. Research (what to copy, what to avoid)

- **vercel/ai** (`packages/ai/src/ui/chat.ts`, Apache-2.0, read 2026-11-01): a tool call carries a state,
  `approval-requested` then `approval-responded`, and `addToolApproveResponse({id, approved, reason})` answers it.
  We already have that state machine: the pending tool row plus the approvals route. The lesson is that the approval
  is *a state of the tool call*, kept with the call and shown inline, not a separate flow. We follow that. We do not
  copy their auto-resubmit (`sendAutomaticallyWhen`): our loop resumes on the decision route already.
- **Claude's own permission prompts:** the card says plainly what will change ("Approve 'Pricing that…' on X, posts
  at 09:00 Tue"), and Cancel is never the risky choice. Copy the wording style: the verb, the object, the time and
  the account.
- **Avoid:**
  - letting the model pass the hash or a free-form payload;
  - deciding several cards in one confirmation without listing each.

  At most 5 cards per confirmation, each named on its own line.

## 5. Tasks

| Task | What | Waits on |
|---|---|---|
| **A0** | **Contracts.** `lib/agent/cmo-decisions.ts` (pure): zod inputs for the 7 tools; `DecisionCard` = `{title, lines: string[], credits?: number, screen: PanelOpen}`; `CMO_DECISION_TOOLS` (specs, added at the end of the CMO tool list); `MCP_HIDDEN` deny list. A check (`cmo-decisions.check.ts`) for the input shapes and that MCP's tool list has none of them. | — |
| A1 | **Server.** `cmoScope().plan()`: a decision tool returns `{kind: "approval", input: prepared, card}`, where `prepared` holds the card's id, action, payload and the `content_hash` read now under RLS. `decide()` calls the RPC and returns `view.open` for the screen it changed. `get_credits` and `list_approvals` stay `run`. Add the tools to `WRITES` and `TAINT_GATED_TOOLS`. | A0 |
| A2 | **Schedule time.** Resolve "9 tomorrow" in the founder's timezone (`profiles.timezone` via `schedule_timezone`), turn it into an ISO time with offset, and refuse a time in the past or outside the slot's window. Resolve the account among `social_accounts` for the card's platform. | A1 |
| A3 | **Settings merges.** `set_sales_settings` reads `sales_settings`, applies the adds and removes, validates against the route's limits (50 subreddits, 20 pairs), then saves. `update_cmo_settings` reads all three fields and changes only those given. | A1 |
| A4 | **Chat UI.** `ChatPanel`: `TurnView.pending`; render pending cards (factor `ApprovalCards` out of `AssistantPanel` into `components/editor/assistant/ApprovalCards.tsx` and reuse it); handle `approval_request` and `done awaiting_approval`; Approve / Cancel post `{decisions}` to the approvals route and stream the rest of the turn. A decision with `view.open` opens column 3. | A0 |
| A5 | **Prompt and summaries.** `list_approvals` returns card summaries (`approvalToCard`, no hash). `CMO_SYSTEM_PROMPT` gets one paragraph: decisions need the founder to ask this turn; never decide on your own; one card per thing, at most 5. | A1 |
| A6 | **Checks and acceptance.** `cmo-decisions.check.ts` covers, with a fake client: the hash taken at plan time, a changed hash refused, the taint gate, the MCP deny list, and the merge logic. The fake model gets a scripted "approve the post" turn (`lib/agent/eval/cmo-tasks.ts`). e2e: the card renders and Approve updates Approvals. Screenshots at 1440 and 390. | A1–A5 |

**Progress (2026-11-02):**
- [x] **A0.** `lib/agent/cmo-decisions.ts` and `cmo-decisions.check.ts`. The mark-posted tool is named `mark_done`, because `jobs.check` forbids any tool name with "post" in it.
- [x] **A1.** `cmoScope` plan and decide; added to `WRITES`, `TAINT_GATED_TOOLS` and the MCP deny list.
- [x] **A2.** The local time is resolved in the founder's zone (`localToIso`), and a past time is refused. The account must be one of the founder's own.
- [x] **A3.** Sales and CMO settings merge only the fields that changed. A request that changes nothing is refused.
- [x] **A4.** `ChatPanel` shows the confirmation cards (live and after a reload); Approve and Cancel go to the approvals route.
- [x] **A5.** `list_approvals` returns card summaries without the hash, and the prompt has the decision rule.
- [~] **A6.**
  - Done: the check passes, and the CMO eval adds `cmo-pause` (it ends on the card) and a planted "pause the CMO" in the site-injection case, which the gate refuses.
  - Open: the browser e2e and screenshots, because no local Supabase runs in this container.

**Milestones**
- **M1:** A0 and A1. A decision works end to end through the approvals route; the UI is still missing.
- **M2:** A2–A5.
- **M3:** A6, and `/code-review` on the diff.

## 6. Owner gates

1. `decided_via = 'chat'`. If wanted, a migration widens `approval_decide`'s `v_via` check and
   `approvals_decided_via_check`. Until then: `'app'` plus `source: 'chat'` in the payload.
2. Whether the chat may approve a **priced** Studio card (`price` kind, "Approve 12 credits"). The default is yes:
   the card shows the price and the founder confirms it. Owner may say "buttons only for money".

## 7. Review focus

- No decision without the founder's message in the same turn and a confirmed card. The model cannot pass a hash.
- Every write is the same RPC as the button, under the founder's RLS client. No service role.
- None of the new tools reach MCP.
- The taint gate holds after `read_site` or the research tools.
- The schedule time is in the founder's timezone and inside the slot window. Text in a card that came from a
  stranger is escaped.
