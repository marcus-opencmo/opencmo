# OpenCMO — Architecture

This document records the technical decisions and **the reasons** behind them. Read §2
before adding any dependency.

---

## 1. System shape

A web app. Heavy work runs on a serverless worker, never inside an HTTP request.

```
┌──────────────┐  create job  ┌──────────────┐
│  Next.js     │─────────────▶│  API routes  │
│  (Vercel)    │              │  (Vercel)    │
└──────┬───────┘              └──────┬───────┘
       │ realtime                    │ insert jobs(status='queued')
       │ job status                  ▼
       │              ┌───────────────────────────────────────────┐
       └─────────────▶│                Supabase                   │
                      │  Auth · Postgres · Storage · RLS · Queue   │
                      └───────────┬───────────────────▲───────────┘
                       claim_next_job()               │ write clips + status
                                  ▼                   │
                      ┌───────────────────────────────┴───────────┐
                      │        Python worker (Modal)              │
                      │        scale-to-zero, ships ffmpeg        │
                      │  transcript → LLM → ffmpeg render         │
                      └───────────────────────────────────────────┘
```

The queue needs no separate service: the `jobs`/`tasks` tables plus `claim_*` functions using
`for update skip locked` are enough at this scale.

**Why the worker cannot live in Supabase or Vercel** — a technical constraint, not a taste:

| | Can it run ffmpeg? |
|---|---|
| Supabase Edge Functions | **No.** Deno blocks subprocesses; also a 400 s wall-clock and 2 s CPU limit |
| Vercel Functions | Duration is enough, but the runtime has no ffmpeg/yt-dlp, `/tmp` is small, and web-request compute pricing is the wrong tool for batch video |
| **Modal** | Right tool: a custom image with ffmpeg, per-second billing, true scale-to-zero |

Modal is Python-native: the image is defined in Python, so there is no Dockerfile or registry
to manage, and deploying is one command. No jobs means no cost.

The worker lives in `packages/engine/modal_app.py` and has **two entry points**, on purpose:

| | When | Why |
|---|---|---|
| `submit` endpoint → spawn | the web app calls it when the user starts a job | main path, no delay |
| `sweep()` | cron every minute | safety net: picks up jobs stuck in `queued` if the web call failed or the network dropped |

A job **never stays in `running`**: every failure path ends in `failed` and **refunds the
credits**. The ledger is append-only, so a refund is a new credit row, not an edit of the
debit.

---

## 1b. Web data model and security

### Why Next API + Supabase + Modal, not FastAPI on Modal

| Option | Why rejected |
|---|---|
| FastAPI on Modal as the main API | One more process owning auth, sessions, CORS and rate limits — all of which Supabase + Next already provide. Modal's scale-to-zero also means the first request pays a cold start, even for a one-row read |
| Supabase Edge Functions | Deno blocks subprocesses: no ffmpeg (see §1) |
| **Next API routes + Supabase + Modal worker** | Chosen. Heavy work on Modal, light work where the session already is, and RLS is the single permission layer that has to be right |

### Four data decisions

**Immutable revisions.** `clip_revisions` is insert-only (a trigger blocks updates). A queued
export points at a specific revision; editing a revision would change the content of a file
the user thinks they already locked. Drafts are a pointer to "which revision this clip is on".

**Leased task queue.** `tasks` and `jobs` share one pattern: `claim` sets `lease_until` and an
`attempt_id`, the worker heartbeats, and a reconciler reclaims expired leases. `attempt_id` is
a fencing token — a worker that lost its lease can come back and try to write, but
`complete_task` rejects the stale attempt.

**Hash-based dedupe.** `settings_hash` is the sha256 of the settings canonicalized with JCS
(RFC 8785). Same clip + same settings renders once. Python and TypeScript must produce **the
same string**, which is why JCS and not `JSON.stringify`.

**Append-only ledger.** `credit_ledger` is insert-only; refunds are new rows.
`profiles.credit_balance` is a materialized balance updated by trigger in the same
transaction, so reading a balance is O(1). Only the credit module (`credit_hold`,
`credit_settle`, `credit_refund`) writes ledger rows, each tagged with the `(ref_kind,
ref_id)` it belongs to.

### Security model

**Two actors, two paths.** Signed-in users go through RLS; the worker goes through the
service role. There is no third path. Every user write is a `security definer` RPC with an
ownership check — RLS alone is not enough because many operations (charge credits + create
job) must be atomic. The MCP server maps a personal API key to a five-minute user JWT, so its
tools also run under RLS.

**Storage by uid.** The first path segment is always the user id, so a storage policy is a
string comparison, not a query. All buckets are private; reads are short-lived signed URLs.

**Three validation layers.** zod in the route → limits in the RPC → parsing in the worker.
The repetition is deliberate: any layer may be the only one left after a refactor, and the
SQL layer is the one a client cannot skip.

**Untrusted media.** ffmpeg chooses a demuxer from file content, so a user "video" can be an
HLS playlist that makes the worker fetch arbitrary URLs or read local files. User media is
read through stdin (`image2pipe`), with a forced format (`-f mov`), or with a demuxer
allowlist (`USER_MEDIA_FORMATS`); Lottie files that reference external assets are rejected.

**Retention is a queue, not a sweep.** Deleting an expired project first records every object
path in `storage_deletions`, then deletes the files, and deletes the rows last. That table
deliberately has no foreign keys: its rows must survive the very cascade that created them
(deleting an account removes jobs, clips and tasks in one transaction). Accounts that never
make a purchase are deleted 30 days after sign-up through the same queue.

---

## 2. Resource budget — hard constraints

> ### Peak RAM per job < 2 GB
> ### 45-minute video → 5 clips in under 3 minutes

These are **constraints**, not goals. Changes that break them are rejected.

RAM matters twice in the cloud: it sets the container size, and the container size sets the
bill.

### Non-negotiable rules

1. **Never load video frames into application memory.** Every transform is a streaming
   `ffmpeg` subprocess; ffmpeg uses constant memory regardless of video length.
2. **No MoviePy** or any frame-by-frame Python library. MoviePy keeps frames as numpy arrays;
   one raw 1080p frame is ~6 MB, and a few hundred of them is gigabytes. This is the main
   reason other open-source clipping tools crash machines.
3. **No Whisper `large` fp32 locally** — the weights alone are ~6 GB. Transcription uses an
   API.
4. **Never download the whole source video.** See §3.
5. **Cap parallel work** by available cores and memory.

> Full RAM → swap → everything slows down by an order of magnitude. Most "30 minutes per
> video" numbers from older tools are a machine fighting swap, not computing. **Fix RAM and
> speed follows.**

---

## 3. Pipeline

The key idea: **transcript first, video second.** Never download a 45-minute video.

```
1. Probe metadata                                          │ 2–5 s
                    ↓
2. Get a transcript
   a. Try the platform's existing captions (a few KB)      │ 2–5 s
   b. None → download AUDIO ONLY (~40 MB) → speech-to-text │ 20–40 s
                    ↓
3. LLM reads the transcript → picks N moments              │ 5–10 s
   returns [{start, end, hook, score, reason}]
                    ↓
4. DOWNLOAD ONLY THOSE SECTIONS (~50 MB)                   │ 20–40 s
                    ↓
5. Per clip: reframe to 9:16 + burn captions + preview     │ 30–60 s
   (parallel, capped)
                    ↓
                 ~2 minutes total
```

**2a before 2b** is the second-biggest optimization: many videos already have captions, which
skips both the audio download and the transcription call.

**Step 4 is the biggest:** ~1 GB becomes ~90 MB — bandwidth, disk and time in one move.

Uploaded files follow the same order on a local proxy copy.

---

## 4. ffmpeg traps

**Position of `-ss`** — for a clip near the end of a long video this is a 10× difference:

```bash
# WRONG — decodes from 0 to 1800 s before cutting
ffmpeg -i in.mp4 -ss 1800 -t 20 out.mp4

# RIGHT — seeks straight to the position (input seeking)
ffmpeg -ss 1800 -i in.mp4 -t 20 out.mp4
```

**Hardware encoders** — 5–20× faster than `libx264`:

| Environment | Encoder |
|---|---|
| NVIDIA | `h264_nvenc` |
| Intel iGPU (Linux) | `h264_qsv` or `h264_vaapi` |
| AMD (Linux) | `h264_vaapi` |
| macOS | `h264_videotoolbox` |
| Cloud container without GPU | `libx264 -preset veryfast` |

> ⚠️ **`ffmpeg -encoders` lists what was COMPILED IN, not the hardware you have.** A typical
> build lists `h264_nvenc` on a machine with only an Intel iGPU, and calling it fails at run
> time. **Always probe with a real one-frame test encode** and cache the result — see
> `packages/engine/opencmo/media/encoder.py`.

**Captions** — generate an `.ass` file and burn it with the `subtitles` filter so ffmpeg
renders text in C. Never draw text onto frames from Python.

**Face tracking** — detect at **3–5 frames per second**, then interpolate and smooth the crop
path. Faces don't move faster than that; this cuts inference by ~90% and gives a smoother
result.

---

## 5. Stack

### Web (`apps/web`)

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js App Router + TypeScript | |
| Auth | **Supabase Auth** (Google OAuth) | |
| DB | **Supabase Postgres** | |
| Storage | **Supabase Storage** | **RLS applies to files too** — see below |
| Queue | **Postgres** (`claim_*` functions) | No separate service; `for update skip locked` handles contention |
| Billing | Polar (merchant of record) | Handles VAT/sales tax |
| Errors | Sentry (optional) | |
| Landing hero 3D | `three` (same version as `packages/clip-three`) | Loaded with `import()` after first paint; static SVG fallback without WebGL or with reduced motion |

**One provider for auth + DB + storage + queue.** The strongest reason is not price but that
**Row Level Security applies to files**: "only the owner can read their clips" is a SQL
policy, not permission logic we write (and can get wrong) in the app. `lib/storage.ts` wraps
storage behind a few functions, so the provider can still be swapped.

### Engine (`packages/engine`)

| Layer | Choice | Why |
|---|---|---|
| Language | Python 3.11+ (3.12 for face tracking) | The video and AI ecosystem lives here |
| Video download | `yt-dlp` | Supports the platforms users publish on |
| Video processing | `ffmpeg` subprocess | Streaming, constant RAM |
| Face tracking | MediaPipe — **required** | See the warning below |
| Transcript | Groq `whisper-large-v3-turbo` | ~20 s per video |
| Moment selection | Gemini Flash **or** Claude Haiku | Whichever key is present; Gemini preferred |
| Runtime | Modal | Scale-to-zero |

> ⚠️ **Face tracking is not optional, even though the code can fall back.** Without
> MediaPipe the engine falls back to a centre crop and still produces an mp4 — so it is easy
> to think it works. On a real TEDx talk that produced a clip with **the speaker cut in half
> at the left edge**. With face tracking, the face centre measured at x = 0.37 and the speaker
> was framed correctly. Across one interview, face centres of 5 clips ranged from 0.46 to
> 0.87 — a centre crop ruins at least two of them.
>
> MediaPipe needs **Python ≤ 3.12**, and version 1.0 removed `mp.solutions` — use the Tasks
> API only.

**Why two languages:** video processing and AI live in Python; auth, billing and UI live in
TypeScript. Forcing one language costs more than it saves.

---

## 6. Video sources

In order of preference — **lowest risk first**:

| Priority | Source | Notes |
|---|---|---|
| 1 | Direct upload (resumable, straight to Storage) | The main path |
| 2 | Cloud storage / meeting recordings the user owns | Legitimate by construction |
| 3 | A link to the user's **own** video | Requires the "Is this your video?" confirmation, recorded with the job |

OpenCMO only processes video the user owns. There is no field on the landing page for pasting
someone else's video, and link imports are gated by the ownership confirmation.

---

## 7. Two levers built in from day one

1. **Storage behind a small wrapper** (`lib/storage.ts`) — the app never calls a provider SDK
   directly, so the storage provider can be swapped when egress costs demand it.
2. **Low-resolution previews + full-quality downloads.** Users watch many clips to choose;
   every view is egress. A ~500 kbps preview cuts egress 5–10×.

Plus: **clips are deleted 7 days after a project finishes.** It keeps storage bounded and
avoids keeping copies of video indefinitely.

---

## 8. Repository layout

```
opencmo/
├── apps/
│   └── web/                      # Next.js
│       ├── app/                  # pages + app/api/v1 routes
│       └── lib/
│           ├── storage.ts        # storage wrapper — the app never calls the SDK directly
│           ├── agent/            # the editor assistant
│           ├── generate/         # AI media generation
│           ├── cmo/              # the AI CMO job engine
│           ├── mcp/              # MCP server
│           └── supabase/
├── packages/
│   ├── clip-doc/                 # clip document JSON — the only thing persisted (§10)
│   ├── clip-render/              # renders the document: Canvas 2D in browser + Node
│   ├── clip-export/              # server export: document → MP4
│   ├── clip-assets/              # media library manifest
│   ├── clip-icons/ clip-media/ clip-three/
│   ├── editor-core/              # operations on the document — the only write path
│   ├── editor-parity/            # golden images + comparison scripts
│   ├── contracts/                # JSON contracts shared by Python and TypeScript
│   └── engine/                   # Python engine
│       ├── opencmo/
│       │   ├── pipeline.py       # orchestration; step order is the main optimization
│       │   ├── media/            # probe, encoder detection, ffmpeg command building
│       │   ├── steps/            # download, transcribe, select, reframe, captions, render
│       │   ├── ai/               # generation providers + moderation
│       │   └── worker/           # queue loop: claim, process, render/export/generate
│       ├── modal_app.py
│       └── tests/
└── supabase/                     # migrations, pgTAP tests, local config
```

**The engine is a standalone CLI that knows nothing about the web.** It takes a URL or file
and returns clips. It can be tested without any web infrastructure, and deploying to Modal is
only packaging.

---

## 9. The editor: a document, rendered the same way everywhere

The editor's single source of truth is a **clip document**: JSON validated by a zod schema
(`packages/clip-doc`), with a generated JSON Schema for Python. It is the only thing stored
(`editor_projects.document`).

- **Writes**: every write path — buttons, API routes and the AI assistant — is an
  `editor-core` operation on the document, validated by `validate()`. There is no other way to
  change a clip.
- **Rendering**: `clip-render` draws the document to Canvas 2D with the same code in the
  browser (preview, assistant frame captures) and in Node (`@napi-rs/canvas`, export). Golden
  images in `packages/editor-parity` keep both targets pixel-close.
- **Export**: the `render_document` task — the Python worker fetches exactly the media the
  document needs, the Node exporter (`clip-export`) renders segments in parallel and joins them
  with ffmpeg, and the worker applies the watermark for free accounts. Users' machines never
  encode.
- **Revisions**: `snapshot_editor_revision` checks `document_hash` (sha256 of the document
  text, computed by SQL and returned on every read/write). The client sends back the exact
  string the server returned, so there are no two hash implementations to keep in sync.

The engine's own render path still delivers the first clips of every job; every later export
goes through the document.

The editor targets desktop browsers (Chrome, Edge, Safari 17+, Firefox). `DeviceCheck` detects
**features**, not browser names; phones get a guidance screen.

---

## 10. 3D scenes: Chromium + three.js in a separate GPU container

Two rules from §2 still hold:

- **Not in the worker.** The `generate` task spawns the Modal function `render_three` (an L4
  GPU with its own image containing Chromium, three.js and a Vulkan ICD) and polls it. The GPU
  container is separate from the job, so its memory does not count against the worker's 2 GB
  budget, and the worker image does not grow by a browser.
- **Frames never pass through Python.** The page renders, posts pixels to a Node HTTP server,
  and Node streams them straight into ffmpeg's stdin (respecting `drain`).

A 3D scene is just another generation: its spec hash (JCS) is the cache key, and the editor
and exporter treat the result like any generated video. three.js does not run inside the
exporter because software WebGL measured 178–531 ms per frame, far above the 150 ms budget.

---

## 11. AI CMO: scheduling, memory, goals and providers

Implemented in PR #21. The review with diagrams (in Vietnamese) is the "Kiến trúc AI CMO"
artifact linked there.

### Language boundary

> **TypeScript for product logic. Python only for video. Postgres for data and money.**

| Question when adding a feature | Answer |
|---|---|
| Does it touch ffmpeg, MediaPipe, a GPU or large video files? | Python on Modal (`packages/engine`) |
| Everything else: agents, CMO jobs, API, editor | TypeScript on Vercel (`apps/web`, `packages/*`) |
| Does it write data or move credits? | An RPC in Supabase |

The editor packages (`editor-core`, `clip-doc`, `clip-render`) run in the browser and on the
server, and the editor assistant's tools are `editor-core` ops. A Python backend would need a
second copy of them, so the backend stays TypeScript. TypeScript and Python meet only through
`packages/contracts/*.json` and JCS hashes.

### Scheduling: Modal is the only clock

`apps/web/vercel.json` has no crons. Modal (`packages/engine/modal_app.py`) keeps time and
dispatches; CMO jobs stay TypeScript and run on Vercel, in parallel:

```
Modal cmo_schedule  (00:05 UTC daily) ──GET──▶ /api/cron/cmo           enqueue the loops due today
Modal sweep()       (every minute)    ──POST─▶ /api/internal/cmo/run   ×N, one per claimable run (max 10)
Modal cleanup       (03:00 UTC daily) ──GET──▶ /api/cron/cleanup
```

- Enqueue stays **once a day** on purpose: the loops are daily and `cmo_enqueue` only dedupes runs
  still queued or running, so enqueuing more often would run a finished loop again.
- `/api/internal/cmo/run` answers 202 and drains inside `after()`; each call claims its own lease,
  so an extra call does nothing. `sweep()` counts claimable runs with the same rule as
  `claim_cmo_run` (`opencmo/worker/cmo_dispatch.py`).
- Both directions authenticate with `CRON_SECRET`; Modal also needs `OPENCMO_WEB_URL`.

### Memory in three tiers

| Tier | Where | Read by |
|---|---|---|
| 1. Profile | the four `marketing_documents` | every job and the chat |
| 2. Events | `cmo_memories` with `kind`, `topic`, `importance`, `expires_at` | each job reads its own topic + `general`, most important first, unexpired |
| 3. Lessons | `cmo_lessons`, one per topic per week | every job and the chat, before events |

`summarize_memory` (Sunday, free) writes the topic lessons; `review_week` writes the `general`
lesson. Skip reasons expire after 90 days; notes the founder typed do not.

### Weekly goal loop

`cmo_goals` holds at most one goal per week, counted in `posts`, `replies`, `clips` or `views`.
The CMO proposes (chat tool `set_week_goal`, or `review_week` for next week); it becomes the goal
only when the founder approves the card in Approvals. `review_week` (Sunday, free) records the
result, writes the lesson and proposes the next goal; W1 plans around the approved goal. Chat tool
`get_run_result` lets the CMO check on work it handed out.

### CMO → editor assistant

Chat tool `create_video_brief` writes a brief (hook, b-roll, visuals, pacing) for a project the
founder already clipped from their own video. Approving the card opens the project with the brief
prefilled in the project assistant; the founder sends it and approves each change there. The CMO
never applies edits.

### Providers: one per function

| Function | Provider | Called from |
|---|---|---|
| Agent LLM | one default: `CMO_LLM_PROVIDER` (web) = `OPENCMO_LLM_PROVIDER` (engine); choose with `npm run cmo:eval` | Vercel, Modal (moment selection) |
| Moderation | OpenAI moderations (free) | Vercel, Modal |
| Image, video, voice, sound generation | fal for every model, including Veo, Nano Banana, Gemini TTS and ElevenLabs (voice with word timestamps, sound effects, music); the direct Gemini and ElevenLabs adapters stay only as a fallback | Modal |
| Transcripts | Groq Whisper | Modal |
| Social reading · payments · errors | ScrapeCreators · Polar · Sentry | Vercel |

### Deploy order

1. Apply migrations (`supabase db push`): 20261109–20261111 add memory tiers, goals and briefs.
2. Add `OPENCMO_WEB_URL` and `CRON_SECRET` to the Modal secret `opencmo`, then `modal deploy`.
3. Merge: Vercel deploys and drops the old crons.
4. Run `npm run cmo:eval -- --provider gemini --yes` and `-- --provider anthropic --yes`, then set
   `CMO_LLM_PROVIDER` (Vercel) and `OPENCMO_LLM_PROVIDER` (Modal) to the winner.
