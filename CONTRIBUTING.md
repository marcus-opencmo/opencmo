# Contributing to OpenCMO

Thanks for helping. This guide covers how to propose a change, the rules every change must
keep, and how to verify your work before opening a pull request.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bugs** — open an issue with steps to reproduce, what you expected, and what happened.
  For anything security-related, do **not** open an issue; follow [SECURITY.md](SECURITY.md).
- **Features and larger changes** — open an issue (or a discussion) first and describe the
  problem. OpenCMO keeps a deliberately narrow scope; agreeing on the approach up front saves
  you from a pull request that cannot be merged.
- **Small fixes** (typos, docs, an obvious bug with a test) can go straight to a pull request.

## Licensing of contributions

OpenCMO is licensed under [AGPL-3.0-only](LICENSE). By submitting a contribution you agree
that it is licensed under the same terms (inbound = outbound). There is no CLA. Only submit
code you wrote or have the right to submit under the AGPL; do not copy code from projects
with incompatible licenses.

## Development setup

Follow [Getting started](README.md#getting-started). In short: `npm ci`, a Python 3.12 venv
for the engine, `cp apps/web/.env.example apps/web/.env.local`, then `npm run dev`.

Two engine tests (`test_worker_e2e_local`, `test_web_sql_concurrency`) claim tasks on the
local Supabase stack; stop `npm run dev` before running them or the dev worker takes the task
first.

## Rules every change must keep

These are hard constraints, not preferences. A change that breaks one will not be merged.

### Engine (Python)

1. **Peak RAM per job < 2 GB, and a 45-minute video → 5 clips in under 3 minutes.**
   Measure with `/usr/bin/time -v` after any change to the pipeline and include the numbers
   in your pull request.
2. **Never load video frames into Python memory.** Every transform runs through `ffmpeg` as a
   streaming subprocess. MoviePy and other frame-by-frame Python libraries are not allowed.
3. **Never download the whole source video.** Transcript first, then only the selected
   sections.
4. **Put `-ss` before `-i`** (input seeking).
5. **Detect hardware encoders with a real one-frame test encode**, not `ffmpeg -encoders`.
6. **User media is untrusted.** ffmpeg picks a demuxer from file content, so user files are
   read with an explicit format or a demuxer allowlist (`USER_MEDIA_FORMATS` /
   `USER_INPUT` in `opencmo/media/ffmpeg.py` and `packages/clip-export/src/inputs.ts`).
   Keep those guards on any new ffmpeg call that reads user files.

### Web app and database

1. **Every write goes through a Postgres RPC that checks ownership.** The app does not
   `insert`/`update` product tables directly; charging credits and creating work happen in one
   transaction.
2. **Reads run under RLS.** Do not add `user_id` filters as a substitute for policies.
3. **Validate in three layers**: zod in the route, limits in the RPC, and the worker's own
   parsing. Any one of them may be the only one left after a refactor.
4. **Files never pass through Next.js.** Browsers upload straight to Storage (TUS) with a
   server-issued reservation; downloads are signed URLs with a 303 redirect.
5. **Money only moves through the credit module** (`credit_hold` / `credit_settle` /
   `credit_refund`). No other function may insert into `credit_ledger`.
6. **The service-role key never reaches the browser.** `lib/supabase/admin.ts` is only for
   webhooks, crons, the CMO job runner and MCP key lookup.
7. **Every migration ships with a pgTAP test** in `supabase/tests/`. Create migrations with
   `supabase migration new <name>`; never edit a migration that has already been released —
   add a new one.
8. **Hash settings with JCS (RFC 8785)** so Python and TypeScript produce identical hashes.

### Editor

- The clip **document JSON** (`packages/clip-doc`) is the only thing persisted. Every write —
  buttons, API routes and the AI assistant — is an `editor-core` operation validated by
  `validate()`.
- Rendering changes must keep the golden-image parity checks green
  (`npm run test:clip-render`, `npm run parity:*`).

### Product rules

OpenCMO assists; it does not act on the user's behalf. Contributions must not add:

- automatic posting, liking, following, commenting, multiple accounts or fake engagement;
- downloading videos the user does not own (links require the "Is this your video?"
  confirmation; uploads are the main path);
- voice cloning, dubbing or lip-sync of real people, or AI images/video of identifiable real
  people or other brands' logos. Every generation goes through moderation
  (`lib/generate/moderation.ts`, `opencmo/ai/moderation.py`).

## Language and style

- **Everything in the repository is English**: code, comments, docs, commit messages, pull
  requests, and all user-facing text — including SQL `raise exception` messages and worker
  errors, because they reach the user's screen verbatim.
- Some older comments are still in Vietnamese. If you touch a file, feel free to translate
  the comments you change; there is no need to translate unrelated code in the same PR.
- Some comments reference internal design documents (for example `docs/specs/…`) that are not
  part of this repository. Treat them as context, not as files you are missing.
- Comments explain **why**, not **what**. Match the style of the surrounding code.
- Python: `ruff check .` must pass. TypeScript: `npm run typecheck` must pass.

## Commits and pull requests

- Write commit messages in English, in the imperative mood, with a short summary line
  (≤ 72 characters) and a body explaining why when it isn't obvious:

  ```
  Reject Lottie files that reference external assets

  Skottie resolves `assets[].p` against the worker's filesystem, so an uploaded
  Lottie could read local files during export.
  ```

- Keep pull requests focused: one logical change per PR. Large features are easier to review
  as a short series of stacked PRs.
- Fill in the pull request template: what changed, why, how you verified it, and screenshots
  or exported frames for UI, caption, reframe or render changes.
- **Look at the output.** Green tests do not prove a clip is usable — the worst bugs here are
  silent (a cropped speaker, captions off-screen, a file with no video frames). After touching
  reframe, captions, render or export, extract a frame and look at it:

  ```bash
  ffmpeg -v error -y -ss 8 -i "clips/out/00-<clip-name>.mp4" -frames:v 1 /tmp/check.png
  ```

## Verification checklist

Run what is relevant to your change:

| Area | Command |
|---|---|
| Database | `npm run db:reset && npm run db:test && npm run db:lint` |
| Engine | `cd packages/engine && .venv312/bin/python -m pytest -q && .venv312/bin/python -m ruff check .` |
| Web types and build | `npm run typecheck && npm run build` |
| Contracts | `cd apps/web && npm run check:contracts` |
| API contract | `cd apps/web && npm run check:api` (local Supabase + a server started with `OPENCMO_AGENT_FAKE=1 OPENCMO_AI_FAKE=1`) |
| Editor core | `npm run test:editor-core` |
| Clip document | `npm run check:clip-doc && npm run test:clip-doc` |
| Renderer parity | `npm run test:clip-render`, then the `parity:*` scripts |
| Exporter | `npm run check:clip-export && npm run test:clip-export` |
| End-to-end | `cd apps/web && npm run test:e2e` |

Heavy suites (`build`, `test:e2e`, Modal runs) use a lot of memory; run them one at a time.

## Reviews

A maintainer reviews every pull request. Expect questions about the constraints above,
especially RAM, security and the product rules. Once approved and green, a maintainer merges
it.
