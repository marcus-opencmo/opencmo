# Session A: metrics, best time, reply outcomes, card budget

Plan: [`../2026-10-28-p6-quality-reach-plan.md`](../2026-10-28-p6-quality-reach-plan.md) · rules: [`README.md`](README.md).

## You own

- `supabase/migrations/20270101*`, `supabase/tests/` for them, `supabase/schema/current.sql`
- `apps/web/lib/cmo/jobs/pull-metrics.ts` (Zernio source), new `reply-outcomes.ts`, the brain's batching in `apps/web/lib/cmo/brain.ts`
- `schedule_propose` and `packages/contracts/schedule-defaults.json`
- `apps/web/lib/screens/` (types, fixtures, loaders, registry), `apps/web/app/api/v1/screens/`
- `docs/plans/cmo/2026-10-28-p6-acceptance/`

## Order

A0 → (push, M1) → A1 → A2 → A4 → A3 → A5. Post "M1/M2/M3 ready for review" on the PR.

## Todo

- [x] **A0 Contracts (push first)**: migration skeleton with grants, RLS and pgTAP: `push_subscriptions`,
      `email_log`, `card_budget` (per user per day), `account_metrics`, `best_slots`, reply outcome columns on
      `cmo_draft_outcomes`; screen types for `analytics.*` and Brain measures; `MetricsSource` interface (public,
      Zernio).
      Done: `20270101090000_p6_contracts.sql` + `229_p6_contracts.test.sql`. For C: `push_subscribe(endpoint, p256dh,
      auth, user_agent)` / `push_unsubscribe(endpoint)`; `notify_settings` (+ `notify_settings_save(email, push)`,
      service `notify_settings_for(user)` for the unsubscribe token); `email_unsubscribe(token)` callable signed out;
      service `email_log_claim(user, kind, ids)` → `{log_id, approval_ids}` (one digest a local day, one expiring
      email per card, waiting cards only, nothing when unsubscribed) and `email_log_done(log, provider_id, error)`.
      Approval status `held` (+ `held_until`). TS: `lib/cmo/jobs/metrics-source.ts`, `BrainScreen.measures`,
      `lib/screens/rail.ts` (`RailStatus`: `nextPostAt`, `connectedAccounts`, `timezone`; C puts it in
      `ShellState`), card fields `PostBody.platforms[].thread?` and `lookNote?` on the three Studio bodies.
      Note: cards are raised in SQL (`approval_raise`), so the card budget (A4) lives there, not in `brain.ts`;
      owner (2026-10-31): past ~10 a day a card is held until the next day, time-bound cards never.
- [x] **A1 Zernio metrics (P3)**: per post, per account and followers for connected accounts on the `pull_metrics`
      schedule; public reading stays for the rest; loaders `analytics.*` and Dashboard `results`; flip `live`.
      Done: `lib/departments/publish/analytics.ts` (three Zernio endpoints, fake, a 402 = no add-on never fails the
      run), `20270101110000_p6_metrics.sql` + pgTAP `233` (`nonneg()`: `greatest(0, null)` is 0 in Postgres),
      `lib/screens/analytics-build.ts` (KPIs against the previous range, daily, by account, best and worst posts;
      `brainReads` stays sample), `analytics.check.ts`. Finished by a later session from A's recovered working tree.
- [x] **A2 Best time (P2)**: `best_slots` from published posts with metrics (≥ 10 per platform, median views per
      hour in the founder's timezone); `schedule_propose` (`20261230100000_p4_slots.sql`) prefers them over
      `schedule-defaults.json`'s slots; the existing jitter, gaps and caps stay; the card's one-line reason. pgTAP.
      Done: `20270101120000_p6_best_time.sql` + pgTAP `234`; `pull_metrics` calls `best_slots_refresh`; the reason
      is added in `schedule-enrich.ts` (`bestTimeWhy`), outside the hash, so waiting cards stay valid.
- [x] **A4 Card budget**: about 10 cards a day; past it the brain batches (one card per batch) or waits; the Brain
      measures loader (`brain.md` §10).
      Done: `20270101130000_p6_card_budget.sql` + pgTAP `235` (`202` resets the day's budget, it raises eleven cards).
      `approval_raise` holds the 11th new card until the next local day (time-bound cards never); a replacement keeps
      its place and is not counted; `held` joins `approvals_one_waiting`, the supersede and `approval_refresh`.
      `approval_release_held` runs first in the hourly `cmo-digest` cron. "Waits" is built; batching several items
      into one card is not (each squad already raises one card per batch: shorts, slideshows). Brain measures:
      `brain-measures.ts` + `weekCounts` in `load.ts`. Rail: `loadRailStatus` + `GET /api/v1/screens/rail`.
- [x] **A3 Reply outcomes (R3)**: 3 days after "replied", re-read the thread (by the pasted URL, else a match on the
      founder's text), store votes and replies, write a memory note; outside text as data.
      Done: `20270101150000_p6_reply_outcomes.sql` + pgTAP `236`; `jobs/reply-outcomes.ts` runs as a step of
      `pull_metrics` (which now also runs for connected accounts and due replies, `loops.ts`); Reddit through
      `redditThread` (100 comments), HN through Algolia `items/<id>` (`hnItem`, free; HN shows no comment points, so
      votes stay null there). SQL writes the memory line from our own numbers and the community name only.
      `opportunity_reply_url(id, url)` keeps a pasted link into the same thread; the card has no field for it yet
      (C's reply card).
- [x] **A5 Acceptance** with fakes (F13), screenshots of Analytics, the phone queue and the digest email into
      `docs/plans/cmo/2026-10-28-p6-acceptance/`.
      Done: `lib/screens/p6-acceptance.e2e.ts` passed; results and gaps in that folder's README.

## Requests

(Others append `[from → A] what, why`; answer here with the commit.)

- [x] [from planner → A] **CI red on `database`: `182_authenticated_function_allowlist` fails** (run 41199949759, head
  `8ab9f57`). A0 and `c21abd5` added functions `authenticated` can call that the allowlist does not name:
  `email_unsubscribe(uuid)`, `notify_settings_save(boolean,boolean)`, `push_subscribe(text,text,text,text)`,
  `push_unsubscribe(text)` (list them in `supabase/tests/182_authenticated_function_allowlist.test.sql`, they are meant
  to be called) and `push_endpoint_allowed(text)` (a helper for the check and the RPC: `revoke all ... from public, anon,
  authenticated` instead of listing it). Earlier runs on this branch were cancelled by newer pushes, so this is the
  first full pgTAP run of A0.
  **Answer (A):** fixed in the look-check commit: the four listed in 182, `push_endpoint_allowed` revoked from
  `authenticated`; the whole suite passes on a fresh database built from every migration.
- [from planner → A] **M1 review, before A4:** the `held` status is outside `approvals_one_waiting` (unique where
  `status = 'waiting'`) and outside the supersede in `approval_raise` (cancels only `waiting`). A card whose content
  changes while it is held keeps its stale snapshot next to a new waiting card, and releasing it later hits the unique
  index. Use `status in ('waiting', 'held')` in both, with a pgTAP case. Also: register `look_check` in
  `task-kinds.json` with B's SQL (keep `publish_media` last; `test_worker_loop.py` checks the first seven kinds), and a
  per-user advisory lock in `email_log_claim` so two cron runs cannot send the same expiring email.
  **Answer (A):** `look_check` sits before `publish_media` in `task-kinds.json`; the lock is in `20270101103000`;
  `held` joins the unique index and the supersede in A4 (done, `20270101130000`).

- [x] **[from B → A] 1. Look check before a Studio card (S4, M2; owner confirmed "only before a card", 2026-10-31).**
      Contract: `apps/web/lib/departments/studio/look-check.ts` (`LookCheckInputSchema`, `LookResultSchema`,
      `lookNextStep`) and the worker side `packages/engine/opencmo/worker/look_check_task.py` (B builds the task in B1).
      Asked of A, in one `20270101*` migration with pgTAP:
      - a task kind `look_check` (the SQL kind check; B adds the row to `packages/contracts/task-kinds.json` in the same
        push window so `task-kinds.check.ts` stays green; tell B the commit);
      - where a Studio render is done today and a card is raised (`tasks_studio_rules` for `editor_project`,
        `short_batch_settle` for `short_batch`, `studio_slideshow_settle` for `studio_step`): enqueue one `look_check`
        task with `payload = {ref_kind, ref_id, round, files: [{path, clip_id}]}` (the full-size `exports` paths) instead
        of `approval_raise`;
      - on `look_check` done: `pass`, or `round = 1` → `approval_raise` with `look` (the task output) in
        `approval_snapshot`, so `contentHash` changes with it; failed at round 0 → no card, a send-back row the TS side
        can claim (e.g. `studio_look_sendbacks_claim(p_limit)` returning `{ref_kind, ref_id, user_id, order_id, look}`),
        after which B's redo renders again and the next `look_check` gets `round = 1`. B's redo
        (`lib/departments/studio/look-redo.ts`) can answer "unchanged" (nothing the squad can fix, so a render would
        return the same file): then it needs one call that raises the card with the round-0 result as is, e.g.
        `studio_look_settle(p_ref_kind, p_ref_id, p_render_tasks uuid[])`, empty array = raise now, else wait on those
        renders and check them as round 1;
      - `look_check` failed as a task (worker error) → raise the card without a note, never block it;
      - `lookNote` (≤ 200) on the three studio bodies in `approval-card.ts` (your block), read from `snapshot.look.note`.
      Why: cards are raised in SQL, so the wait between "render done" and the card has to live there.
      **Answer (A, this commit):** `20270101100000_p6_look_check.sql` + pgTAP `231` (and `207` updated). Task kind
      `look_check` in SQL and in `task-kinds.json` (A added the row so the check stays green). The three render rules
      call `look_check_begin` instead of raising: payload `{ref_kind, ref_id, round, files: [{path, clip_id}]}` on
      `tasks.payload` (full-size `output_path`). Rounds count per order (`coalesce(order_id, ref_id)`), so a redo that
      makes a new step or batch is still round 1. On the task: pass or round 1 → card; round 0 failed → `look_checks`
      row `sent_back`, no card; task failed/cancelled → card without a note. Squads claim with service
      `studio_look_sendbacks_claim(p_limit)` → `{check_id, ref_kind, ref_id, user_id, order_id, look}` (`look` = the
      task output); a claimed send-back with no round-1 check after an hour raises its card with the round-0 note.
      `approval_snapshot` adds `look: {pass: false, round, note}` only for a failed check of this exact render
      (`document_hash`, or `parent_hash` for a batch); `cards.ts` maps it to `lookNote`. While checked, a slideshow
      step stays `running` and a batch stays `rendering`. Note: the worker writes `clipId`/`frameTimes` in its output
      and `LookResultSchema` uses the same, good; SQL only reads `pass` and `note`.
- [x] **[from B → A] 1b. Raise a sent-back card now when the squad has nothing to redo.** Thanks for request 1. Renders
      are keyed on the document hash, so most send-backs cannot change anything (black stretch, frozen shot, every
      shorts batch and slideshow; see `look-redo.ts`). Today those cards wait for the hour-long give-up. Asked: a
      service-only `studio_look_sendback_unchanged(p_check uuid)`: a `claimed` check → `failed` + `look_check_raise`, so
      the card shows at once with the round-0 note; pgTAP. B already calls it from `runLookSendBacks` (the drain loop
      in `studio-orders.ts`); until it exists the call fails softly and the give-up still raises the card.
      **Answer (A):** `20270101140000_p6_look_unchanged.sql`, service only, returns false unless the check is
      `claimed`; pgTAP in `231` (the card carries the round-0 note, a second call does nothing).
- [x] **[from B → A] 2. Hacker News threads in Sales (R4).** `cmo_opportunities` (`20261015090000_cmo_sales.sql`) only
      takes `platform = 'reddit'` and a reddit.com URL. Asked: allow `platform in ('reddit','hn')` and
      `^https://news\.ycombinator\.com/item\?id=[0-9]+$` for `hn`; `cmo_save_opportunities` takes each item's
      `platform` (default `reddit`); the `opportunity` snapshot emits `platform`. pgTAP: an hn row saves, an hn URL on a
      reddit row and a reddit URL on an hn row are refused. B sends `platform: "hn"` from `sales-scan.ts` once it lands.
      **Answer (A):** `20270101103000_p6_threads_hn.sql` + pgTAP `232`. `platform in ('reddit','hn')`; an `hn` URL is
      exactly `https://news.ycombinator.com/item?id=<digits>`; `cmo_save_opportunities` takes `platform` (default
      `reddit`, anything else refused). The snapshot emits `platform` only for `hn`, so Reddit cards keep their hash;
      the reply card gets `platform: "hn"` and the community "Hacker News" when empty.
- [x] **[from B → A] 3. X threads (W4).** Asked: `cmo_save_draft` keeps `body.thread` (array of 5–8 strings, each ≤ 280
      code points; `body.text` = the first post), `approval_snapshot` for a post emits `thread`; the thread block of
      `approval-card.ts` (`PostBody.platforms[].thread?: string[]`); the deliverable built for publishing carries
      `thread` (B adds `thread` to `PublishDeliverableSchema` in `publish/types.ts` unless you prefer to, say so).
      Types: `ThreadDraftSchema`, `ThreadBody` in `lib/cmo/writer/types.ts`.
      **Answer (A):** same migration. `thread_valid(body)`: 5–8 strings of 1–280 code points, `thread[0] = text`;
      `cmo_save_draft` refuses an invalid thread or one on a non-X item. The post snapshot and `schedule_content` emit
      `thread` (part of the schedule `content_hash`; single posts keep theirs); `ScheduleSnapshotSchema.thread?` and
      `PostBody.platforms[].thread?` are in. `PublishDeliverableSchema` is yours, as you offered.
- [x] **[from B → A] 4. `check:contracts` additions (your block):** `tsx lib/cmo/social/hn.check.ts` (B3, pushed later;
      B will say when it exists). Studio look-check checks live in `studio.check.ts`, already in the chain.
      **Answer (A):** `hn.check.ts` is in the `check:contracts` chain after `research.check.ts`.
