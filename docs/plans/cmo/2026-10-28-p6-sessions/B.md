# Session B: look check, evals, Hacker News, X threads

Plan: [`../2026-10-28-p6-quality-reach-plan.md`](../2026-10-28-p6-quality-reach-plan.md) · rules: [`README.md`](README.md).

## You own

- `apps/web/lib/departments/studio/` (the look check hook)
- `packages/engine/opencmo/worker/look.py` (only if the fixed questions change)
- `apps/web/lib/cmo/jobs/eval/` (Studio and brain cases, the plan judge)
- `apps/web/lib/cmo/social/hn.ts` (new) and its use in `sales-scan.ts` / research (through a request to A if it touches A's files)
- `apps/web/lib/cmo/jobs/draft-post.ts` (thread mode), thread posting in `apps/web/lib/departments/publish/zernio.ts`

## Order

B0 → (push, M1) → B1 → B2 (editor first, M2) → B3 → B4.

## Todo

- [x] **B0 Contracts (push first)**: `LookResult` (questions, pass/fail, frame times, note), where it runs (before a
      card, never on every render unless the owner says so at M1); eval case shapes (squad: brief → output → judge
      questions; brain: profile → plan → judge); `HnSource`; thread draft type (5–8 posts, each ≤ 280).
- [x] **B1 Look check (S4)**: before a video, short or slideshow card (long take, Shorts, Slideshow squads in
      `lib/departments/studio/`), call Modal `look` on the full-size export (up to 12 frames); fixed questions; one
      send-back to the squad, then the card shows the note.
      Done: worker `look_check_task.py` + `ai/look_judge.py`, web `look-check.ts` / `look-redo.ts`, the drain loop in
      `studio-orders.ts`; SQL wait by A (`20270101100000`, `20270101140000` for "unchanged"). Not run yet: a real
      vision judge and a real export (owner gate).
- [x] **B3 Hacker News (R4)**: Algolia HN search (no key, within its rate limit) for Sales and Research, budget,
      untrusted wrapping, tests with recorded responses.
- [x] **B4 X threads (W4)**: `post_draft` thread mode (hook post with the promise, one step per post, no recap
      ending, checks per post), posting as a thread through the publish adapter.
      Done: `jobs/draft-thread.ts` (one thread, code checks per post and on the thread, the checker in its own
      context, one fix round), `post_draft` with `thread: true` (X only), `create_task` takes `thread` (now only),
      `PublishDeliverableSchema.thread`, Zernio `threadItems` (media on the root post), `draft-thread.check.ts`.
      Finished by a later session from B's recovered working tree.
- [x] **B2 Evals (S4, B4)**: Studio cases for long take, shorts and slideshows; ~20 brain profiles with the plan
      judge on the cascade; a fake run in CI; the real run waits for the owner.

## Notes for M1

- **Look check rule (owner, 2026-10-31): only before a card.** `LOOK_CHECK_RULE = "before_card"`; draft renders in the
  editor are never checked.
- **Contracts:** `lib/departments/studio/look-check.ts` (questions, `LookResult`, `LookCheckInput`, one send-back,
  `lookNote`; checked in `studio.check.ts`), `packages/engine/opencmo/worker/look_check_task.py` (the worker contract,
  built in B1), `lib/cmo/jobs/eval/studio-types.ts` (squad cases, brain profiles, the plan judge's questions),
  `lib/cmo/social/hn.ts` (`HnSource`, `HnThread`, `HnBudget`), `ThreadDraftSchema` / `ThreadBody` in
  `lib/cmo/writer/types.ts`.
- **Black, frozen and silence are code, not a model:** ffmpeg `blackdetect`, `freezedetect` and `astats` on the
  full-size file; only "captions inside" and "text readable" go to the vision judge (Python, beside
  `opencmo/ai/moderation.py`, which already holds the vision calls). No vision key → "not checked", never a fail.
- **Cards are raised in SQL**, so the wait for the look check is A's (request 1 in `A.md`); HN rows need A's
  constraint change (request 2), threads need `cmo_save_draft` and the card block (request 3).
- **Zernio threads exist:** OpenAPI v1.429 has `TwitterPlatformData.threadItems[] {content, mediaItems}`
  (`platformSpecificData`, item 0 is the root post), checked on `zernio.com/openapi.json` 2026-10-31.

## Notes for M2

- **B1 look check, worker (2026-10-31):** `look_check_task.py` + `ai/look_judge.py`, 15 tests on generated MP4s
  (black, frozen, mute, silent, judge fail, blocked frame, paths). Measured on a 90 s 1080×1920 export: peak RSS
  174 MB, 7.5 s (`/usr/bin/time -v`, fake judge). **Not yet run:** a real vision judge (no key used), a real export from
  Storage, and the SQL wait (A's request 1); the task kind is registered once A's kind check lands.
- **Send-back is honest, not a retry:** renders are keyed on the document hash, so `look-redo.ts` only redoes what the
  squad can change: the long take's `finishVideo` (late voice-overs and their captions). Black stretches, frozen
  shots, shorts and slideshows raise the card with the note at once. A caption safe-area op or slide text shortening
  would let more failures be fixed; out of scope here, noted for the editor roadmap.
- **B2 evals (2026-10-31):** `eval/cases/brain.ts` (`b4`, 20 profiles in `eval/fixtures/profiles.ts`, code tier with
  stage fit, then `plan-judge.ts` on the other provider, judge version in the report) and `eval/cases/studio.ts`
  (`s4-shorts` on a fixed 90 s talk, `s4-slideshow`, `s4-long-take`; the long take's render measures are `pending`,
  measured by the look check at runtime). All pass on the fake provider; code tiers asserted in `coverage.check.ts`.
  **The real run waits for the owner** (gate 4): `ai-evals.yml` by hand with `job=b4,s4-shorts,s4-slideshow,s4-long-take`;
  not added to the weekly cron, which would spend every Monday.
- **B3 Hacker News (2026-10-31):** `social/hn.ts` (Algolia, no key, discussion URL only, HTML to plain text, our own
  budget) on a recorded response (`hn.check.ts`). Sales: up to 3 searches of the scan's queries, newest within 30 days,
  at most 8 stories scored with Reddit's; replies on HN are always help only (no rules page; HN frowns on
  self-promotion); saved with `platform: "hn"` (A's request 2). Research: `search_hackernews` in the CMO chat and MCP,
  counted in the turn's lookups. A failing HN search never fails a scan. The w4 eval stays Reddit-only so it compares
  with older runs. **Not run:** a real scan against Algolia end to end (one recorded response only).

## Requests

(Others append `[from → B] what, why`; answer here with the commit.)
