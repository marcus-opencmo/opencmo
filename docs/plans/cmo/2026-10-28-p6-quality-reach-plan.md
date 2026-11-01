# P6: Quality and reach: analytics, best time, digest by email, evals

> **For agentic workers:** §2 says *what* ships, §5 the tasks. Three sessions build it on branch **`cmo-p6`** (PR into
> `cmo-build`). Each session's numbered todo list, owned paths and order are in
> [`2026-10-28-p6-sessions/`](2026-10-28-p6-sessions/): read `README.md` there, then your own file. Build nothing
> before your Task 0 is done; nobody builds on a contract before it is pushed.

## 0. Scope

Phase 6, the last, of [`2026-10-28-backend-roadmap.md`](2026-10-28-backend-roadmap.md) (on branch `cmo-p2`). It
builds eight backend phases:
- **A2** reaching the founder: email digest, web push, phone-first queue (`approval.md` §7, §11);
- **P2** best time and **P3** Zernio metrics (`schedule-publish.md` §10);
- **R3** reply outcomes and metrics, **R4** Hacker News (`research-sales.md` §9);
- **S4** look check and Studio evals (`studio.md` §9, §11);
- **B4** brain evals (`brain.md` §10, §11);
- **W4** X threads (`writer.md` §10).

After it: 27 of 28. The 28th, **S0** (finishing the long take on production), runs on the editor roadmap.

**Status: ready (refreshed 2026-10-31).** Written early on 2026-10-28; `cmo-build` with P2–P5 (`1c299ec`) is merged
into `cmo-p6` and §3 is refreshed from what was built. Sessions may start once CI on `cmo-build` is green. This phase is
wide; if review shows it is too big for one PR, split it at M2 into P6a (A2, P2, P3, R3) and P6b (R4, S4, B4, W4) with
the owner's OK.

**Order (owner, 2026-10-30, as in P5): the editor first.** M2 is the look check (S4) and Studio evals, because they
make the marketing videos better; reach (email, push) and analytics follow. Real Zernio calls stay behind
`OPENCMO_PUBLISH_LIVE=1` and the owner gates of P4 (owner, 2026-10-30: "real posting, the gates and review are next
week's phase"); until then every Zernio read in this phase runs against the fake adapter.

Not in this phase: real posting through Zernio (its own owner-led phase), S0 (editor roadmap), AI search visibility
(GEO, later).

## 1. Goal and decisions

**Goal:** the founder sees how every connected account performs, posts go out at their own best times, a waiting card
reaches them by email or push and can be decided on a phone, and the brain's and Studio's quality is measured on
real profiles with a look check before every video card.

**Decisions already made:**
- Email through Resend; the email opens the card, it never decides from the email (`approval.md` §12, 2).
- About 10 cards a day at most; the brain batches or waits beyond that (`approval.md` §12, 3).
- Every connected account returns its data and can be viewed (owner, Analytics comment, 2026-10-27); Zernio's
  analytics endpoints (per post, per account, follower stats).
- Default slots until a platform has ~10 published posts with metrics, then the founder's own best median hours;
  jitter up to ±4 minutes (`schedule-publish.md` §5, §11).
- Hacker News: yes, free, after R1–R3.
- Look check: only before a card (recommended in `studio.md` §12, 6; confirm with the owner at M1).
- X threads when founders ask (`writer.md` §10: W4 "when founders ask"); kept under `post_draft` (thread). B4 is last
  in B's order and the first thing to drop at M3 if no founder has asked, with the owner's OK.

## 2. What ships

| # | Feature | The founder sees | Done when |
|---|---|---|---|
| F1 | Email digest | a morning email when cards wait, and one before a time-bound card expires; links open the card | Resend wired (`RESEND_API_KEY`, verified domain); the in-app digest (wave 1 B2) sends at `digest_hour` in their timezone; unsubscribe link; `support@opencmo.io` in the footer |
| F2 | Web push | a push when a card waits (if they allowed it) | VAPID keys, a service worker, `push_subscriptions`; at most one push per batch; on iPhone only for a Home Screen web app (help text says so) |
| F3 | Phone-first queue | the queue and every card decide at 390 px inside the shell's phone layout (`TabBar`, Chat first) and in the compact layout at 1024 (chat as a drawer); previews from signed URLs of preview files | every card kind passes axe and a decide e2e at 390 and 1024; the editor still sends phones to a computer, the queue does not |
| F4 | Card budget | at most ~10 cards a day | the brain batches or waits beyond the budget; a counter in SQL |
| F5 | Zernio metrics (P3) | Analytics live: every connected account, KPIs, daily chart, per account, top posts | a `pull_metrics` source for connected accounts through Zernio (per post, per account, followers); public reading stays for unconnected ones; `analytics.*` live; Dashboard results live |
| F6 | Best time (P2) | schedule cards propose their own best hours ("Your posts on X do best around 9 am") | after ~10 published posts with metrics on a platform, the founder's best median hours replace `schedule-defaults.json`'s slots in `schedule_propose`; the existing jitter, gaps and caps stay |
| F7 | Reply outcomes (R3) | Sales shows "your reply got 4 replies, 12 votes" | a few days after "replied", re-read the thread for the founder's reply (by the URL they pasted or a match) and store votes and replies with the outcome; memory learns which threads work |
| F8 | Hacker News (R4) | Sales and Research include HN threads | Algolia HN search as a source for both (no key, within its rate limit), outside text as data |
| F9 | Look check (S4) | a video card with a note when the check found a problem | Modal `look` draws up to 12 frames of the full-size export; a vision judge answers fixed questions (captions inside the frame, no black or frozen frames, text readable, sound present); a failure goes back to the squad once, then to the card with a note |
| F10 | Studio evals | — | eval cases for the long-take squad, shorts and slideshows in `lib/cmo/jobs/eval`; approved-as-is and redo rates per squad |
| F11 | Brain evals (B4) | Brain → measures (plan accepted without edits, drafts approved as is, orders on time, credits per approved deliverable, replans) | ~20 real profiles in `lib/cmo/jobs/eval` with a plan judge on the cascade; measures from `brain.md` §10 on the Brain screen |
| F12 | X threads (W4) | a thread card: 5–8 posts, each under 280 | `post_draft` with `thread: true`; checks per post; scheduled as one slot posting a thread through Zernio |
| F14 | Rail status lines | the rail says "Next post 9:00" under Schedule and "Waiting on Zernio" or the account count under Analytics | `statusOf` in `Rail.tsx` reads two new `ShellState` fields from the screens loaders (only real numbers; no line otherwise) |
| F13 | Acceptance | — | a local run with fakes: digest email to Inbucket, a push to a test subscription, a card decided at 390, metrics from the fake Zernio on Analytics, a best-time proposal after 10 fake posts, a look check failure noted on a card |

## 3. What exists (`cmo-build` at `1c299ec`, with P2–P5)

- **Digest:** `lib/cmo/digest.ts` (`buildDigest`, escaped titles, links that open the card, no approve button; checked
  in `jobs/progress.check.ts`), cron `app/api/cron/cmo-digest`, `profiles.digest_hour` and `timezone`. No email
  sender (no Resend code), no web push, no `push_subscriptions`.
- **Publish (P4):** `lib/departments/publish/` (`types.ts`, `adapter.ts`, `zernio.ts` against Zernio's OpenAPI v1.420,
  `fake.ts`, `intent.ts`, `job.ts`, `webhook*.ts`, `accounts*.ts`); platforms `x`, `threads`, `linkedin`, `tiktok`,
  `youtube`, `instagram`; deliverable kinds `post`, `video`, `short`, `slideshow`. Real calls only with
  `ZERNIO_API_KEY` **and** `OPENCMO_PUBLISH_LIVE=1`; none made yet. No analytics calls, no thread posting.
- **Schedule (P4):** `schedule_slots`, `schedule_propose` (`20261230100000_p4_slots.sql`), schedule cards, firing in
  `20261230120000_p4_firing.sql`; defaults in `packages/contracts/schedule-defaults.json` (slots per platform,
  `windowMinutes` 15, `jitterSeconds` 240, gaps and caps). So jitter and default slots exist; **best time from the
  founder's own data does not** (no `best_slots`).
- **Metrics:** `jobs/pull-metrics.ts` reads public numbers through ScrapeCreators (no Zernio); `post_metrics`. The
  `analytics` screen has no live field (release needs `accounts`, `kpis`, `daily`, `byAccount`, `posts`); the
  Dashboard `results` waits on this phase.
- **Look:** Modal endpoint `look` and `packages/engine/opencmo/worker/look.py` (tests in `test_worker_look.py`); no
  squad calls it before a card yet (the long take, Shorts, Slideshow and Post image squads raise cards without it).
- **Evals:** `lib/cmo/jobs/eval/` (`runner.ts`, `core.ts`, cascade judge in `jobs/judge.ts`), cases for `writer`,
  `sales`, `onboarding`, `factuality`; none for Studio squads or the brain's plan.
- **Sales (P5):** subreddit rules cache, 1-in-10 mentions, excluded subreddits, Sales loaders live; no reply outcome
  check, no Hacker News source.
- **Writer (P3):** `platforms.json`, voice notes, per-platform drafts; X threads not built (`post_draft` is single
  posts).
- **UI (three-column shell, `2026-10-30-three-column-shell-plan.md`, S1–S4 merged with P5):** rail · CMO chat · tab
  panel, resizable (`shell-v2/columns.ts`, `Sash.tsx`); below 1100 px the chat is a drawer, at 760 px and below the
  phone layout is `TabBar` with Chat first; the editor opens in column 3 and its Assistant takes the chat column. Every
  screen of this phase renders in column 3 with `--v2-*` tokens only. Rail status lines (`Rail.tsx` `statusOf`) show
  only Dashboard pending and Stuck; Schedule's "next post" and Sales' "new threads" lines were left out of the shell
  plan for lack of a count, which this phase's loaders can supply.
- Latest migration `20261231160000_p5_review_fixes.sql`; this phase's prefix `20270101` sorts after it.
- **Owner decisions still open from P2** (`2026-10-28-p2-sessions/B.md` notes): a price for the brain's Studio orders,
  60 s briefs vs 10 s shorts, short renders against the daily export limit. B4's brain evals measure credits per
  approved deliverable, which feeds the first one.

## 4. Global constraints

- Every write through an ownership-checking RPC; a pgTAP test per migration and per transition; regenerate
  `supabase/schema/current.sql`. **Migration prefix for this phase: `20270101`.**
- No decision from an email or a push; they only open the card.
- Secrets from env only (`RESEND_API_KEY`, `VAPID_PRIVATE_KEY`, `ZERNIO_API_KEY`); never sent to another vendor.
- The look check reads the full-size export, not `*.preview.mp4`; its frames go through moderation like any frame.
- Outside text (HN, threads re-read) is data.
- English in all user-facing text and emails; no model names.

## 5. Tasks

| Task | Session | What | Waits on |
|---|---|---|---|
| **A0** | A | **Contracts first:** migration skeleton `push_subscriptions`, `email_log` (sent, kind, card ids), card budget counter, `account_metrics` (per account per day), `best_slots` (per founder, platform, hour), reply outcome columns; screen types for `analytics.*`, Brain measures; the metrics source interface | — |
| **B0** | B | **Contracts first:** look check result type and the Studio hook "before a card"; eval case shapes for squads and the brain; the HN source interface; the thread draft type | — |
| A1 | A | Zernio metrics (P3): fetch per post, per account, followers for connected accounts on the `pull_metrics` schedule; store; loaders `analytics.*` and Dashboard `results`; flip `live` | A0 |
| A2 | A | Best time (P2): `best_slots` from published posts with metrics (≥ 10 per platform); `schedule_propose` prefers them over the defaults (jitter, gaps and caps unchanged); the card's one-line reason; pgTAP | A0, A1 |
| A3 | A | Reply outcomes (R3): re-read replied threads after 3 days, store votes and replies, memory notes | A0 |
| A4 | A | Card budget (F4): counter and the brain's batching; Brain measures loader; the next waiting slot time and connected-account count for the rail (F14) | A0 |
| A5 | A | Acceptance (F13) with screenshots of Analytics, a phone queue and the digest email | all |
| B1 | B | Look check (S4): call `look` before raising a video, short or slideshow card; one send-back to the squad; the note on the card | B0 |
| B2 | B | Studio evals and brain evals (B4): cases, the plan judge on the cascade, the eval report; a fake run in CI, a real run with the owner | B0 |
| B3 | B | Hacker News (R4): Algolia search source for Sales and Research, budget, untrusted wrapping, tests | B0 |
| B4 | B | X threads (W4): `post_draft` thread mode, checks per post, Zernio thread posting in the publish adapter | B0 |
| C0 | C | Email templates (digest, expiring card) and the Resend sender `lib/notify/email.ts`; unsubscribe route; dev sends to Inbucket | A0, owner gate |
| C1 | C | Web push: service worker, permission prompt with help text, `lib/notify/push.ts`, send on a new card batch | A0 |
| C2 | C | Phone-first queue: every card kind at 390 (previews by signed URL), axe and decide e2e per kind | — |
| C3 | C | Analytics page live (accounts, KPIs, daily, by account, top posts), Brain measures panel, the thread card body, all in column 3 of the shell | A1, A4, B4 |
| C5 | C | Rail status lines for Schedule and Analytics (F14) from A's `ShellState` fields | A1, A2 |
| C4 | C | e2e: digest to Inbucket opens the card, a card decided at 390, Analytics with fake Zernio data | C0–C3 |

**Milestones**
- **M1** contracts: A0 and B0 pushed and reviewed; the owner confirms the look check rule.
- **M2** look check and evals (editor first): B1, B2, the look note in C3.
- **M3** reach, analytics and acceptance: A1–A5, B3, B4, C0–C2, C3 (rest), C4, C5; the planner reviews the whole PR.
  (Split point if the PR grows too big: after M2.)

## 6. Owner gates

1. Resend account, verified sending domain (`opencmo.io`), `RESEND_API_KEY`.
2. VAPID keys in env.
3. Zernio analytics included in the plan bought in P4 (check the endpoints and their price).
4. One real-model brain eval and one Studio eval run (costs money).

## 7. Review focus

- Email and push never carry a decision; links open the card behind login.
- Unsubscribe works; at most one digest a day and one expiring-card email per card.
- Metrics only for the founder's own connected accounts; nothing scraped from other people's private data.
- Best time never overrides a gap, a cap or the founder's own time choice on a card.
- The look check uses the full-size export and sends back only once.
- Evals are reproducible (fixed profiles, recorded judge prompts).
