# CLAUDE.md

Guidance for Claude Code and other coding agents working in this repository. Human
contributors: see [CONTRIBUTING.md](CONTRIBUTING.md) — the rules are the same.

## Project

OpenCMO is an AI CMO for solo founders: it learns a business from its website and runs three
departments — **Video** (your own long-form video → captioned vertical clips → editor →
per-platform captions), **Post** (X drafts you approve and publish), and **Sales** (Reddit
threads scored with evidence and draft replies the user posts themselves).

One system: Next.js web app + Supabase + a Modal worker. There is no second runtime; do not
build one.

## Product rules

- **Assist, never act.** Anything that goes out (posts, replies) runs only after the user
  approves it, on their own account. Never add automatic liking, following, commenting,
  multiple accounts or fake engagement. Sales has no post button.
- **Video must be the user's own.** Links go through the "Is this your YouTube video?"
  confirmation, recorded with the job; upload is the main path.
- **AI images/video only with moderation.** Prompts go through `lib/generate/moderation.ts`
  before credits are held; generated images and video frames go through
  `opencmo/ai/moderation.py` before upload. No identifiable real people, no other brands'
  logos, premade voices only — no cloning, dubbing or lip-sync.
- **Copy describes software, not a service**: "drafts you approve and publish", not "we grow
  your audience". Don't market model names (Gemini, Veo, ElevenLabs…) as features.
- **Don't ship "coming soon"**: anything on the landing page must work.

## Language

Everything in the repo is **English**: code, comments, docs, commits, PRs, and all
user-facing text. The easiest places to forget are SQL `raise exception` messages, errors the
worker writes to `jobs.error`, and route-handler error strings — all of them reach the user
verbatim. Older comments may still be Vietnamese; translate the ones you touch. Comments
explain **why**, not **what**.

## Hard budgets

> **Peak RAM per job < 2 GB** · **45-minute video → 5 clips in under 3 minutes**

Changes that break either are rejected. Measure with `/usr/bin/time -v` after any pipeline
change. Last measurement (54-minute interview, 5 clips): 155.5 s, 849 MB peak.

1. Never load video frames into Python memory — streaming `ffmpeg` subprocesses only.
2. No MoviePy or other frame-by-frame Python libraries.
3. Never download the whole source video: transcript first, then only selected sections.
4. `-ss` goes **before** `-i`.
5. Detect encoders with a real one-frame test encode.
6. Cap parallelism with `cfg.max_parallel` (~400 MB per ffmpeg process).
7. User media is untrusted: read it with an explicit format or the demuxer allowlist
   (`USER_MEDIA_FORMATS` / `USER_INPUT`). ffmpeg sniffs content, so an "upload" can be an HLS
   playlist pointing at arbitrary URLs or local files.

## Running

```bash
npm install
npm run dev                         # Docker → local Supabase → Next.js + worker (127.0.0.1:3000)

npm run db:reset && npm run db:test # migrations + pgTAP
npm run typecheck && npm run build
cd apps/web && npm run check:contracts && npm run test:e2e
```

Engine (use `.venv312`; MediaPipe has no wheel for Python 3.14):

```bash
cd packages/engine
set -a && source ../../.env.local && set +a   # the engine does not read .env itself
.venv312/bin/opencmo doctor
.venv312/bin/python -m pytest -q && .venv312/bin/python -m ruff check .
```

Use the pinned Supabase CLI version from CI, not `npx supabase` (a newer CLI builds a storage
schema the running storage container rejects with `42P10`). Run heavy suites one at a time.

Two engine tests (`test_worker_e2e_local`, `test_web_sql_concurrency`) fail while
`npm run dev` is running — the dev worker claims their tasks first.

## Verify by looking

Green tests don't prove a clip is usable; the worst failures are silent (half-cropped
speaker, captions off-screen, a section with no video frames). After touching reframe,
captions, render or export, extract a frame from the full-size file (not `*.preview.mp4`)
and look at it.

## Known traps

- Face tracking is not optional: without MediaPipe the engine falls back to a centre crop.
- MediaPipe 1.0 removed `mp.solutions`; use the Tasks API.
- yt-dlp's `bestvideo` may pick YouTube HLS, which yields zero-frame sections; keep the
  `protocol^=https` constraint in `SECTION_FORMAT`.
- YouTube auto-captions: cue settings after timestamps, whitespace-only lines, rolling
  duplicates — regression tests in `tests/test_transcript.py`.
- Don't wrap captions by character count; leave `WrapStyle: 0` to libass.

## Layout

```
packages/engine/        Python engine (CLI + Modal worker); knows nothing about the web
packages/contracts/     JSON contracts shared by Python and TypeScript (ai-models.json = model catalog)
packages/clip-doc/      clip document schema (zod), validation, migrations
packages/editor-core/   operations on the document — the ONLY write path (buttons, API, agent)
packages/clip-render/   Canvas 2D renderer (browser + Node)
packages/clip-export/   server export: document → MP4 (task `render_document`)
packages/clip-three/    3D scenes rendered on a GPU worker
packages/clip-icons/, clip-media/, clip-assets/, editor-parity/
apps/web/               Next.js app; app/api/v1 = API (reads under RLS, writes via RPC)
  lib/agent/            the editor assistant (tools = editor-core ops)
  lib/generate/         AI media generation
  lib/cmo/              the AI CMO job engine
  lib/mcp/              MCP server (API keys → short-lived user JWT under RLS)
  lib/supabase/admin.ts service role — only webhooks, crons, CMO runner, MCP key lookup
supabase/migrations/    at the repo ROOT; every migration needs a pgTAP test in supabase/tests/
scripts/dev.mjs         one-command dev stack
```

## Web rules

1. Every write goes through an ownership-checking RPC; charging credits and creating work
   happen in one transaction.
2. Validate in three layers: zod → RPC limits → worker parsing.
3. Files never pass through Next.js (Vercel caps bodies at 4.5 MB): TUS uploads with a
   reservation, signed-URL downloads.
4. Hash settings with JCS (RFC 8785) so Python and TypeScript agree.
5. Money only moves through `credit_hold` / `credit_settle` / `credit_refund` /
   `credit_held`. After a new migration, regenerate `supabase/schema/current.sql` with
   `scripts/dump-schema.sh`.

## Working style

- Don't expand scope. Note out-of-scope improvements in the PR or an issue instead.
- Commit only when asked. Commit messages in English.
