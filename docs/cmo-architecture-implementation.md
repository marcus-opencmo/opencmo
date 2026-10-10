# AI CMO architecture — implementation plan and handoff

This is the handoff for a **local** Claude Code session (or a person) that builds, checks and
deploys the AI CMO architecture. The code is written and pushed; what is left needs a machine with
Docker, a browser and the production accounts.

- Review with diagrams (Vietnamese): <https://claude.ai/artifact/4quoqTrvHHckeQohx1x68A>
- Pull request: [#21](https://github.com/marcus-opencmo/opencmo/pull/21), branch `claude/cmo-architecture-plan`
- Short version of the design: [`ARCHITECTURE.md` §11](../ARCHITECTURE.md)

| Phase | Commit | What |
|---|---|---|
| P0 | `2b3f830` | Modal schedules, Vercel runs CMO jobs in parallel |
| P1 | `c6c4fe6` | Memory in three tiers |
| P1+ | `e3ff8de` | One default LLM provider |
| P2 | `d55357d` | Weekly goal loop |
| P3 | `a37fd68` | CMO → editor assistant bridge (video briefs) |
| Docs | `01cfef4` | `ARCHITECTURE.md` §11, `.env.example` |

CI on the PR is green: web, engine, database (real pgTAP), parity and browsers.

---

## 1. Target architecture

> **TypeScript for product logic. Python only for video. Postgres for data and money.**

| Layer | Runs | Owns |
|---|---|---|
| Browser | TypeScript | app pages, editor (`editor-core` + `clip-render`), TUS uploads |
| Vercel | TypeScript | API, CMO chat, editor assistant, CMO jobs W1–W9 |
| Supabase | SQL | auth, storage, RLS, every write (RPC), credits, queues, memory |
| Modal | Python | the only clock, clipping, export, 3D |

The editor packages run in the browser and on the server, and the assistant's tools are
`editor-core` ops. A Python backend would need a second copy of them, so the backend stays
TypeScript.

### Scheduling

```
Modal cmo_schedule  (00:05 UTC daily) ──GET──▶ /api/cron/cmo           enqueue the loops due today
Modal sweep()       (every minute)    ──POST─▶ /api/internal/cmo/run   ×N, one per claimable run (max 10)
Modal cleanup       (03:00 UTC daily) ──GET──▶ /api/cron/cleanup
```

Enqueue stays **once a day**. The loops are daily, and `cmo_enqueue` only dedupes runs still
queued or running, so enqueuing every 15 minutes (the artifact's first idea) would run a finished
loop again. Only dispatch runs every minute.

### Providers, one per function

| Function | Provider |
|---|---|
| Agent LLM | one default: `CMO_LLM_PROVIDER` (web) = `OPENCMO_LLM_PROVIDER` (engine) |
| Moderation | OpenAI moderations (free) |
| Image, video, voice | fal as the main door (Gemini media and ElevenLabs move later, see G) |
| Transcripts | Groq Whisper |
| Social reading · payments · errors | ScrapeCreators · Polar · Sentry |

---

## 2. What each phase changed

### P0: Modal schedules, Vercel runs in parallel

Why: one Vercel Cron ran once a day as a single 300 s function walking every user in turn; the end
of the queue waited until the user opened the app.

- `apps/web/lib/cmo/schedule.ts`: `enqueueDueLoops()`, the enqueue half of the old cron.
- `apps/web/app/api/cron/cmo/route.ts`: enqueue only.
- `apps/web/app/api/internal/cmo/run/route.ts`: `cronAuthorized`, answers 202, drains inside
  `after()` through `kickCmoQueue` (`lib/cmo/jobs/start.ts`).
- `apps/web/vercel.json`: no `crons`.
- `packages/engine/opencmo/worker/cmo_dispatch.py`: `count_dispatchable` (same rule as
  `claim_cmo_run`), `dispatch`, `call_cron`.
- `packages/engine/modal_app.py`: `_dispatch_cmo()` at the end of `sweep()`, plus `cmo_schedule`
  and `cleanup` crons.
- `apps/web/lib/agent/cmo-tools.ts`: `read_site` capped at `SITE_READS_PER_TURN = 3`.
- `apps/web/lib/cmo/jobs/eval-w2.ts` (`npm run cmo:eval`) and `memory-store.ts`, the in-memory
  store shared by checks and evals.
- Tests: `packages/engine/tests/test_cmo_dispatch.py`.
- Env: `CRON_SECRET` (Vercel and Modal), `OPENCMO_WEB_URL` (Modal).

### P1: memory in three tiers

- Migration `supabase/migrations/20261109090000_cmo_memory_tiers.sql`:
  - `cmo_memories` + `kind`, `topic`, `importance`, `expires_at`, `source_run`;
  - trigger `cmo_memories_classify` files skip reasons by topic with a 90-day expiry;
  - `cmo_remember(p_body, p_topic default 'general')`, still callable with `p_body` only;
  - table `cmo_lessons` and RPC `cmo_save_lessons` (service role);
  - kind `summarize_memory` (free, 1/day);
  - `cmo_enqueue` now takes its valid kinds from `cmo_job_daily_limit`.
- `apps/web/lib/cmo/jobs/summarize-memory.ts`, Sunday loop `memory-summary` in `lib/cmo/loops.ts`.
- `lib/cmo/jobs/context.ts`: `recall()` reads lessons and the top notes for one topic (W1 all, W2
  post, W4 sales, W5 video).
- `lib/cmo/jobs/store.ts`: `memories(…, topic)`, `memoryEvents`, `lessons`, `saveLessons`.
- Tests: `supabase/tests/139_cmo_memory_tiers.test.sql`; `lib/cmo/jobs/jobs.check.ts` (W8).

### P1+: one default LLM

- `apps/web/lib/cmo/agents/registry.ts`: `CMO_LLM_PROVIDER` is every agent's default; a
  per-agent `CMO_AGENT_<ID>_PROVIDER` still wins.
- `packages/engine/opencmo/config.py`: `OPENCMO_LLM_PROVIDER` picks the moment-selection provider.
- Tests: `registry.check.ts`, `packages/engine/tests/test_llm_provider.py`.

### P2: weekly goal loop

- Migration `supabase/migrations/20261110090000_cmo_weekly_goals.sql`:
  - table `cmo_goals`;
  - RPCs `cmo_set_week_goal` (founder, through chat), `cmo_propose_goal` (service),
    `cmo_decide_goal` (founder), `cmo_record_goal_result` (service);
  - kind `review_week` (free, 1/day).
- `apps/web/lib/cmo/jobs/review-week.ts`, Sunday loop `weekly-review`; W1 reads the approved goal
  (`goalBlock`).
- Chat tools `get_run_result` and `set_week_goal`, at the end of `CMO_TOOL_SPECS` so the prompt
  cache keeps working.
- UI: `components/cmo/workspace/GoalCards.tsx`, API `app/api/v1/cmo/goals/[id]/route.ts`.
- Tests: `supabase/tests/140_cmo_weekly_goals.test.sql`; `jobs.check.ts` (W9).

### P3: CMO → editor assistant bridge

- Migration `supabase/migrations/20261111090000_cmo_video_briefs.sql`:
  - table `cmo_video_briefs`;
  - `cmo_create_video_brief`, only for the founder's own jobs that have clips;
  - `cmo_decide_video_brief`: a skip reason becomes a video memory.
- Chat tool `create_video_brief`; `list_approvals` now returns each pack's `job_id`.
- UI and API:
  - `components/cmo/workspace/BriefCards.tsx`;
  - `app/api/v1/cmo/video-briefs/[id]/route.ts` (GET returns the prompt; POST approve or skip);
  - `app/app/projects/[id]/page.tsx` reads `?brief=` and passes it to `ProjectView` →
    `ProjectAssistant`, which opens with the brief in the box.
- The founder sends the brief themselves, and every edit still needs the assistant's approval
  card. Nothing applies automatically.
- Tests: `supabase/tests/141_cmo_video_briefs.test.sql`.

---

## 3. Todo list for the local session

Work top to bottom. Tick boxes in this file as you go and commit it with your fixes.

### A. Set up

- [ ] `git fetch origin && git checkout claude/cmo-architecture-plan && npm install`
- [ ] Use the Supabase CLI pinned in CI (**2.117.0**), not a newer `npx supabase` (CLAUDE.md).
- [ ] Engine: `cd packages/engine && .venv312/bin/pip install -e '.[dev,face]'`

### B. Build and test

- [ ] `npm run db:reset && npm run db:test`: migrations 20261109–20261111 apply, all pgTAP passes.
- [ ] `bash scripts/dump-schema.sh`, then `git diff supabase/schema/current.sql`. The committed dump
      came from Postgres 16 in the cloud session; commit the PG17 version if anything differs.
- [ ] `npm run typecheck && npm run build`
- [ ] `cd apps/web && npm run check:contracts` (includes `jobs.check`, `registry.check` and the
      fake W2 eval)
- [ ] `cd packages/engine && .venv312/bin/python -m pytest -q && .venv312/bin/python -m ruff check .`
      (stop `npm run dev` first: two engine tests fail while it runs)

### C. Check by looking (`npm run dev`, signed in as a test user)

- [ ] `curl -X POST localhost:3000/api/internal/cmo/run` answers **401** without
      `Authorization: Bearer $CRON_SECRET` and **202** with it.
- [ ] `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/cmo` returns
      `{ users, queued }` and does not run jobs itself.
- [ ] Goal card: ask the CMO chat "set a goal of 3 posts this week". Then check that:
  - [ ] the card appears in Approvals;
  - [ ] changing the target and approving saves the new target;
  - [ ] the progress bar moves after approving an X post;
  - [ ] "Not this one" removes the card.
- [ ] `get_run_result`: ask "did the last task finish?"; the chat answers from the real run.
- [ ] `remember` with a topic: "remember: never use emojis in X posts". The row in
      `cmo_memories` has `topic = 'post'` and `importance = 3`.
- [ ] Video brief (needs a project with clips):
  - [ ] ask "write a video brief for my latest clips"; the brief card appears;
  - [ ] "Open in assistant" goes to `/app/projects/<id>?brief=<id>` with the assistant open and
        the brief in the box;
  - [ ] sending it ends in an approval card; nothing changes before Approve;
  - [ ] skipping with a reason adds a `video` memory.
- [ ] Jobs: from SQL, `select public.enqueue_cmo_run_for('<user>', 'summarize_memory', '{}')`
      and `'review_week'`, then trigger `/api/internal/cmo/run`. Check rows in `cmo_lessons` and a
      proposed goal for next week.
- [ ] Mobile width and dark mode: goal and brief cards stay readable, nothing overflows.

### D. Fix, push, keep CI green

- [ ] Fix anything B or C found, with small commits on the same branch. Push; CI must stay green.

### E. Deploy (in this order)

- [ ] 1. `supabase db push` to production (migrations 20261109, 20261110, 20261111).
- [ ] 2. Modal dashboard → Secrets → `opencmo`: add `OPENCMO_WEB_URL` (production URL) and
      `CRON_SECRET` (same value as Vercel).
- [ ] 3. `modal deploy packages/engine/modal_app.py`.
- [ ] 4. Mark PR #21 ready, merge. Vercel deploys; check in Vercel → Settings → Cron Jobs that
      the old crons are gone.
- [ ] 5. Watch Modal logs:
  - [ ] `sweep` logs `AI CMO: N waiting, N dispatched` when runs are queued;
  - [ ] `cmo_schedule` runs at 00:05 UTC;
  - [ ] `cleanup` runs at 03:00 UTC.

### F. Choose the default LLM

- [ ] `cd apps/web && npm run cmo:eval -- --provider gemini --yes` and
      `npm run cmo:eval -- --provider anthropic --yes` (real API calls; costs money).
- [ ] Set the winner as `CMO_LLM_PROVIDER` on Vercel and `OPENCMO_LLM_PROVIDER` in the Modal
      secret; redeploy both.

### G. Follow-ups (not built yet)

- [ ] Check that fal offers image, video and voice with **word timestamps** for voiceover
      captions. Only then move the Gemini media and ElevenLabs entries in
      `packages/contracts/ai-models.json` to fal.
- [ ] Optional: `workflow_dispatch` GitHub Actions for `supabase db push` and `modal deploy`, so
      deploys work from a phone (needs `SUPABASE_ACCESS_TOKEN`, the DB password,
      `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` in GitHub Secrets).
- [ ] pgvector for memory search, but only once a user passes about 200 memory rows; filtering by
      topic is enough until then.

---

## 4. Rollback

- **Web**: redeploy the previous production build in Vercel. If the Modal side is not live yet,
  restore the two `crons` in `apps/web/vercel.json` (`/api/cron/cleanup` `0 3 * * *`,
  `/api/cron/cmo` `5 0 * * *`). Note: the old cron route also drained the queue; after this
  change it only enqueues.
- **Modal**: `modal deploy` from `main`.
- **Database**: the migrations only add tables, columns, functions and a trigger. Old code keeps
  working on the new schema (`cmo_remember` still accepts `p_body` alone), so no down migration is
  needed.

## 5. Known limits

- The cloud session could not open the UI in a browser; section C has not been done yet.
- `supabase/schema/current.sql` was regenerated from Postgres 16 with a minimal Supabase stand-in;
  regenerate it locally (B).
- `npm run check:api` also fails on `main` because it needs a live API; it is not part of this
  change.
- The W2 eval grades with code only (finished runs, versions passing the checks, time). Judge the
  drafts by eye too before choosing the LLM.
