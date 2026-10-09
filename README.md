# OpenCMO

**An AI CMO for solo founders.** Paste your website, and OpenCMO learns your business, plans
the week, and drafts the work across three departments — you approve everything that goes out.

- **Video** — turn your own long-form video into vertical 9:16 clips with captions and face
  tracking, polish them in a full timeline editor, and write per-platform captions.
- **Post** — draft X posts from your strategy; you review, approve and publish to your own account.
- **Sales** — find Reddit threads where people need what you sell, score them with evidence,
  and draft replies that **you** post yourself.

OpenCMO drafts and assists; it never posts, likes, follows or comments on its own.

The hosted version runs at [opencmo.io](https://opencmo.io). This repository is the full source
of the web app, the editor and the video engine, released under the
[GNU AGPL-3.0](LICENSE).

## Architecture

```
Browser ──► Next.js app + /api/v1 (Vercel) ──► Supabase (Auth · Postgres/RLS · Storage · Realtime)
                                                   ▲
                       Modal worker (Python + ffmpeg + Node exporter) ── claims queued tasks
```

- **`apps/web`** — Next.js app: landing, workspace, the AI CMO, the clip editor, and the
  `/api/v1` routes. Every read runs under Row Level Security; every write goes through a
  Postgres RPC that checks ownership.
- **`packages/engine`** — Python engine: transcript first, then download only the selected
  sections, face-tracked reframe and burned-in captions via streaming `ffmpeg`. Runs as a CLI
  locally and as a [Modal](https://modal.com) worker in production.
- **`packages/clip-*` / `editor-core`** — the editor stack: a JSON clip document
  (`clip-doc`), operations on it (`editor-core`), a Canvas 2D renderer shared by the browser
  preview and the server exporter (`clip-render`, `clip-export`), icons, media and 3D scenes.
- **`supabase/`** — migrations, pgTAP tests and local config. The database schema is the
  contract between the web app and the worker.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the decisions behind this shape, including the
two hard budgets every change must respect: **peak RAM per job < 2 GB** and **a 45-minute
video → 5 clips in under 3 minutes**.

## Getting started

Requirements: Node 22+, Docker (for the local Supabase stack), the
[Supabase CLI](https://supabase.com/docs/guides/cli), [`uv`](https://docs.astral.sh/uv/),
and FFmpeg/ffprobe.

```bash
npm ci
uv venv --python 3.12 packages/engine/.venv312
uv pip install --python packages/engine/.venv312/bin/python -e 'packages/engine[face,worker,dev]'
cp apps/web/.env.example apps/web/.env.local   # fill in what you need; most keys are optional
npm run dev                                    # web on http://127.0.0.1:3000
```

`npm run dev` checks Docker, starts the local Supabase stack if needed, loads its keys, and
runs Next.js and the worker together. Without the worker, jobs sit in `queued` with no error.

Use Python **3.12**: MediaPipe (face tracking) has no wheel for newer versions, and without it
the engine silently falls back to a centre crop.

Sign-in is Google OAuth. For local sign-in through the UI, create an OAuth client and set
`SUPABASE_AUTH_GOOGLE_CLIENT_ID` / `SUPABASE_AUTH_GOOGLE_SECRET` (see `supabase/config.toml`);
the test suites sign in with a password through the Auth API and need no Google setup.

AI features need provider keys (Gemini or Anthropic for the agents, Groq for transcripts, and
optional media providers). With `OPENCMO_AGENT_FAKE=1` and `OPENCMO_AI_FAKE=1` the app runs
with deterministic fake providers, which is what the tests use.

## Testing

```bash
npm run db:reset && npm run db:test                 # migrations + pgTAP
cd packages/engine && .venv312/bin/python -m pytest -q && .venv312/bin/python -m ruff check .
cd ../.. && npm run typecheck && npm run build
npm run test:editor-core && npm run test:clip-doc && npm run test:clip-render
cd apps/web && npm run check:contracts && npm run test:e2e
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full list and what each check covers.

## Contributing

Issues and pull requests are welcome — start with [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as described in
[SECURITY.md](SECURITY.md).

## License

OpenCMO is licensed under the **GNU Affero General Public License v3.0 only**
([LICENSE](LICENSE)). If you run a modified version as a network service, the AGPL requires you
to offer its source code to that service's users.

Bundled fonts, icons, emoji and animations keep their own licenses — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The OpenCMO name and logo are trademarks of the OpenCMO project and are not licensed under the
AGPL. Forks must use a different name and logo.
