# opencmo-engine

The core of OpenCMO's video department: takes a long-form video and returns vertical 9:16
clips with captions.

A standalone CLI that **knows nothing about the web**, so it can be tested without any
infrastructure, and deploying to Modal is only packaging.

## Install

```bash
# ffmpeg is required
sudo apt install ffmpeg          # Debian/Ubuntu
brew install ffmpeg              # macOS

# Face tracking needs Python <= 3.12 — see the warnings below.
uv venv --python 3.12 .venv && source .venv/bin/activate
pip install -e '.[face]'
```

> ⚠️ **Install `[face]`; don't skip it.** On paper it is optional: without MediaPipe the
> engine falls back to a centre crop and still writes an mp4. On a real TEDx talk that cut the
> speaker in half at the left edge. With face tracking the face centre measured x = 0.37 and
> the speaker was framed correctly. A centre crop only works when the speaker happens to stand
> in the middle.

> ⚠️ **`[face]` needs Python ≤ 3.12.** MediaPipe ships wheels a few Python versions behind.
> On newer Python, pip says `Could not find a version that satisfies the requirement
> mediapipe`, which looks like a network error. Create a 3.12 venv
> (`uv python install 3.12 && uv venv --python 3.12`); `opencmo doctor` tells you which case
> you are in.

The first run with face tracking downloads the MediaPipe model (~230 KB) to
`~/.cache/opencmo/`. Point `OPENCMO_FACE_MODEL` at an existing file to skip this — the worker
image bakes the model in that way.

## Configure

```bash
cp .env.example .env    # then export it, or use direnv
```

You need `GROQ_API_KEY` (transcripts) and **one of** `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`
(moment selection). With both, Gemini is preferred.

## Use

```bash
opencmo doctor                                   # check the environment first
opencmo clip "<url or file>" --clips 5 --out ./clips

# Useful when debugging
opencmo clip "<url>" --verbose --keep-work /tmp/work
opencmo clip "<url>" --no-face --no-preview
opencmo clip "<url>" --json
```

Only process video you own or have the right to edit.

## Pipeline

```
probe → existing captions? → (no) audio → speech-to-text → LLM picks moments
      → download ONLY the selected sections → cut + reframe 9:16 + burn captions
```

The order is the main optimization: because the transcript comes first, the engine **never
downloads the whole source** — for a 45-minute video, ~1 GB becomes ~90 MB. See
`ARCHITECTURE.md` §3.

## Two budgets to keep

| | Budget |
|---|---|
| Peak RAM per job | **< 2 GB** |
| 45-minute video → 5 clips | **< 3 minutes** |

The CLI prints per-step timings and flags budget overruns. To measure RAM:

```bash
/usr/bin/time -v opencmo clip "<url>" 2>&1 | grep "Maximum resident"
```

## Deploy the worker to Modal

In production the engine runs as a Modal worker — see `modal_app.py`.

```bash
pip install -e '.[worker]'

modal secret create opencmo \
    GROQ_API_KEY=... GEMINI_API_KEY=... \
    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...

modal run modal_app.py --url "<url>"   # try one video on Modal, no database needed
modal deploy modal_app.py
```

## Test

```bash
pip install -e '.[dev]'
pytest
```

Most tests cover pure logic — crop windows, caption timing, VTT parsing, transcript cutting —
and run without network access or API keys. Some tests render with a real ffmpeg, and two
(`test_worker_e2e_local`, `test_web_sql_concurrency`) need the local Supabase stack.
