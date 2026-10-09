# @opencmo/web

The Next.js web app: landing page, sign-in, the AI CMO workspace, video projects, the clip
editor, billing, and the `/api/v1` API.

## Layout

```
app/
  page.tsx                  landing
  login/                    Google OAuth, no passwords
  auth/callback|signout/    exchange the OAuth code for a session, sign out
  app/                      signed-in workspace — every screen has its own URL
    editor/                 clip editor
    projects/               project library, progress and results
    brand/                  Brand Kit
    settings/  billing/     account, API keys, plans
  api/
    webhooks/polar/         payments → credits (one atomic RPC)
    cron/cleanup/           expired projects and unpaid accounts → durable deletion queue
    cron/cmo/               the AI CMO's daily schedule
    mcp/                    MCP server (personal API keys)
  api/v1/                   app API: every read under RLS, every write through an RPC
components/
  editor/                   editor shell, canvas, timeline, inspector, library, assistant
  clipping/                 workspace shell and screens
lib/
  api/handler.ts            `withApi`: auth, cross-site checks, body limits, rate limits, error mapping
  agent/                    editor assistant (tools = editor-core operations)
  generate/                 AI media generation (catalog, moderation, spec hashing)
  cmo/                      AI CMO job engine
  editor/document.ts        the only place that reads/saves clip documents
  upload-tus.ts             resumable uploads straight to Storage
  storage.ts                storage wrapper — the app never calls the SDK directly
  supabase/{server,client,admin,middleware}.ts
```

Migrations and pgTAP tests live at the **repository root** (`supabase/migrations/`,
`supabase/tests/`), not in this folder. Run the Supabase CLI from the root.

## Six rules of the web app

1. **The app never inserts directly into product tables.** Charging credits and creating work
   must happen in one transaction, so every entry point is an RPC (`create_job()`, …).
2. **Don't filter by `user_id` in queries as a substitute for RLS.** RLS already filters, and
   unlike a hand-written condition it cannot be forgotten.
3. **The app never proxies media.** It signs a URL and redirects.
4. **`SUPABASE_SERVICE_ROLE_KEY` only lives in webhooks, crons, the CMO runner, the MCP key
   lookup and the worker.** No component imports `lib/supabase/admin.ts`; grepping
   `SERVICE_ROLE` in `.next/static` must find nothing.
5. **User uploads never go through a server action or route handler.** Vercel caps bodies at
   4.5 MB. Browsers upload straight to Supabase with TUS (`lib/upload-tus.ts`); the server only
   issues a reservation and object name (`POST /api/v1/uploads`), and Storage RLS rejects
   objects without one.
6. **Everything the user sees is English** — including ledger reasons and SQL `raise`
   messages, which reach the screen verbatim.

## Running

From the **repository root**, not this folder:

```bash
cp apps/web/.env.example apps/web/.env.local
npm install
npm run dev          # Docker → Supabase → Next.js + worker
```

`npm run dev:web` runs only Next.js when Supabase and the worker are already running.

Create migrations with `supabase migration new <name>` so the CLI generates the
`<YYYYMMDDHHmmss>_name.sql` filename it expects. Use `gen_random_uuid()` (core Postgres), not
`uuid_generate_v4()`: Supabase installs extensions into the `extensions` schema.

```bash
supabase link --project-ref <ref>   # once per machine
npm run db:push:dry                 # preview
npm run db:push
```

### Google sign-in

Create an OAuth client (Web application) in Google Cloud with the redirect URI
`https://<ref>.supabase.co/auth/v1/callback`, enable the Google provider in Supabase Auth, add
`<site>/auth/callback` to the Redirect URLs, and disable the Email provider. Locally, set
`SUPABASE_AUTH_GOOGLE_CLIENT_ID` / `SUPABASE_AUTH_GOOGLE_SECRET` (redirect
`http://127.0.0.1:54321/auth/v1/callback`).

## Connecting the worker

The web app wakes the Modal worker through the `submit` endpoint in
`packages/engine/modal_app.py`:

```
MODAL_SUBMIT_URL     # printed by `modal deploy modal_app.py`
OPENCMO_WORKER_TOKEN # must MATCH the value in the Modal secret `opencmo`
```

Without these the app still works: jobs stay `queued` until `sweep()` — Modal's
every-minute cron — picks them up.
