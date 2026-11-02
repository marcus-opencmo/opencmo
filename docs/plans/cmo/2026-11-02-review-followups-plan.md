# Review follow-ups: what the R1–R6 reviews left open

> **For agentic workers:** branch **`plan/review-followups`**, PR into `cmo-build`. Work the batches in order; each batch
> is green and pushed on its own. Source: the "Not fixed here" lists of the fix PRs:
> - #138 (R1, chat and screens)
> - #145 (R2, CMO jobs and Sales)
> - #146 (R3, security)
> - #147 (R4, rate limits)
> - #148 (R5, credits)
> - #150 (R6, load balance)

## 0. Scope

The six review areas each fixed most findings and left a short list open. Those items were too large for a review PR,
needed a design, or were cleanups. This plan collects them in one place, in the review order:
1. quality
2. security
3. rate limit
4. credits
5. load

Each item lists its source, a size and a done test.

**Not in this plan:**
- the owner's pricing decisions (#148): Annual plan credits, the empty `sales_scan` refund, refunds on blocked
  moderation, Assistant usage past the hold;
- the move from Polar to Creem;
- items that other plans of 2026-11-02 take over:
  - CMO session growth, ratings and the history menu → [`2026-11-02-cmo-chat-live-plan.md`](2026-11-02-cmo-chat-live-plan.md);
  - ScrapeCreators spend → [`2026-11-02-provider-spend-ledger-plan.md`](2026-11-02-provider-spend-ledger-plan.md).

**Status:** plan, owner go-ahead 2026-11-02.

## 1. Decisions

- Every item is checked again before it is built: the review's line numbers predate later merges.
- An item that turns out to need an owner decision stays unticked, with the question written next to it.
- Every SQL change ships with a migration and pgTAP. A migration that has merged is never edited.

## 2. Items

Size: S = under 2 hours, M = up to a day, L = more.

### Batch Q: quality

| # | Item | Source | Size | Done when |
|---|---|---|---|---|
| Q1 | "Going out today" shows the approval time, not the slot's time and status | #138 | S | `outToday` reads `schedule_slots` for approved posts: time, account and the slot status. |
| Q2 | Studio loader reads only the 100 latest projects, document hashes included | #138 | M | The loader selects only the projects the shown orders name; the document hash comes from a small column or RPC, not the documents. |
| Q3 | A one-frame column flash on a hard reload | #138 | S | The first render reads the stored column prefs before the layout effect. |
| Q4 | Weekly review runs Sunday 00:05 and never counts Sunday | #145 | S | `review_week` runs Monday 00:05 for the week just ended (`loops.ts` weekday). Lessons and goals use that week. |
| Q5 | `weekResults.views` counts lifetime views of every post measured this week | #145 | M | Views are the increase since the post's measurement before this week, or only posts published this week. Pick one, write it down, and test it. |
| Q6 | A stuck order's one replan is marked used even when it merged into an existing plan | #145 | S | `work_order_mark_replanned` only when the enqueued run is new (compare ids). |
| Q7 | A `build_video` that failed for lack of credits is never retried after a top-up | #145 | M | A credit top-up (ledger insert trigger, or the progress check) re-queues `failed` orders with code `needs_credits` from the current week. |
| Q8 | `URL_LIKE` matches "Next.js/React" | #145 | S | TS `check-post.ts` and SQL `caption_check` change together, with a shared fixture list of allowed and refused strings. |
| Q9 | `hnPlain` decodes before stripping tags ("&lt;10 … &gt;5" loses text) | #145 | S | Strip, then decode, since `threadBlock` escapes anyway. Revisit the 08daa44 reasoning first, in `git log -p lib/cmo/social/hn.ts`. |
| Q10 | The runner's own store errors are handled as job errors | #145 | M | `store.inbox()` moves inside the try. A throw from `complete(ok)` after the job's writes is retried, not turned into `complete(false)` with a refund. |
| Q11 | Efficiency and reuse cleanups (`Promise.all` in read steps; one `fakeAllowed`; one handle normalizer) | #145 | S | Done, with checks unchanged. |

### Batch S: security

| # | Item | Source | Size | Done when |
|---|---|---|---|---|
| S1 | CodeQL "password hash" on `lib/mcp/auth.ts:38` | CI | S | Dismissed in GitHub as a false positive by the owner: it is HMAC-SHA256 JWT signing, and the API keys are 192-bit random tokens. No code change. |
| S2 | Free and unauthenticated MCP requests are not throttled | #147 | M | `packages/mcp-server/src/http.ts`: an IP-keyed limiter for failed auth, and `mcp_admit` counting free-plan calls before refusing. Deployed with the MCP app. |
| S3 | The shared card-title helper (digest vs expiring email) | #146 | S | One helper in `lib/cmo/digest.ts`, used by both. |
| S4 | The push-host allowlist exists twice (TS regex, SQL) | #146 | S | A shared fixture in `packages/contracts`, read by `push.check.ts` and pgTAP 230. |

### Batch R: rate limits

| # | Item | Source | Size | Done when |
|---|---|---|---|---|
| R1 | Undo can run under a newer turn that is running but has not written yet | #147 | S | The undo route refuses while any newer turn of the session is open. |
| R2 | Dead allowlist entries (`draft`, `mcp`, `zip`, `preview 2/60`, `mcp_preview 30`) and the unused `consume_daily_task_quota` | #147 | S | A migration drops them; `handler.check` still passes; pgTAP 239 stays green. |
| R3 | The "3D scenes" wording in the scene-code limit | #147 | S | The message says "explainer scenes"; the 429 mapping in `lib/api/errors.ts` is updated with it. |
| R4 | `handler.check` does not cover rate limits held in constants | #147 | S | The check reads `GENERATION_RATE_LIMIT`, `PREVIEW_LIMIT` and the MCP look and find limits. |

### Batch C: credits

| # | Item | Source | Size | Done when |
|---|---|---|---|---|
| C1 | Studio model calls are free once the balance hits 0 | #148 | M | `runOrder` checks the balance before each step, not only at start. `studio_record_usage` refuses past zero, and the order waits as `needs_credits`. |
| C2 | Lock order: `complete_generation` vs `cancel_generation` / `cancel_job` | #148 | M | One order for all three (profile → generation → task), with a pgTAP that runs both in sequence. |
| C3 | The export quota release before `raise` is dead code | #147 | S | A worker-side failure releases the day's export (a `release_rate_limit_for` call from the task's fail path); the dead calls are removed. |
| C4 | A `/video` batch checks credits per piece, not for the batch | #148 | S | `checkGeneration` gets the batch total. Past the balance, the whole batch is refused before moderation. |
| C5 | `startCmoRun`'s `after()` kick late in a 300 s turn | #148 | S | No kick from inside an agent turn past 200 s; the sweep dispatches it within a minute. |
| C6 | `retry_job` sums the whole ledger | #148 | S | It uses `credit_balance(v_user)`. |

### Batch L: load

| # | Item | Source | Size | Done when |
|---|---|---|---|---|
| L1 | `render_motion`'s 900 s budget includes Modal queue time | #150 | M | The budget starts when the call starts, or the `FunctionCall` is cancelled on timeout. `RENDER_TIMEOUT` matches the function timeout. |
| L2 | `OPENCMO_CMO_PAUSED` is invisible to SQL and the worker | #150 | M | A one-row `ops_flags` table read by `schedule_claim_due`, `cmo_dispatch_count` and the web; the env stays as an override. |
| L3 | Dispatch helpers open their own httpx clients | #150 | S | `cmo_dispatch` takes the open store. |
| L4 | `NODE_VERSION` is duplicated in `mcp_app.py` | #150 | S | A small shared image module. |
| L5 | Modal retries stack on the database's attempts (up to 6 runs) | #150 | S | `run_job` and `run_task` drop `max_retries` (the lease reclaim retries), or the database attempts drop to 2. Write down which. |
| L6 | `publish_media` and `look_check` can starve behind requeued work | #150 | S | Aging in `claim_next_task`: a task queued for more than 10 minutes sorts first. |
| L7 | Remaining Vietnamese comments in `modal_app.py`, `lib/modal.ts` and `lib/cmo/jobs` | #150, #145 | S | Translated (CLAUDE.md, Language). |

## 3. Order

Batches go Q, S, R, C, L.
- Within a batch, S-sized items go first.
- Each batch is one commit series, pushed when green.
- `/code-review` runs at the end of each batch.

## 4. Verification

- Web: typecheck, `check:contracts`, build.
- Engine: `pytest` for the touched files and `ruff check`.
- pgTAP for every migration, in CI.
- Q1 and Q3 change the UI: take screenshots at 1440 and 390.

## 5. Owner gates

1. S1: dismiss the CodeQL alert.
2. Q5: which views count toward the weekly goal.
3. L5: which retry layer stays.
