# Provider spend ledger: what every provider call costs OpenCMO

> **For agentic workers:** branch **`plan/provider-spend-ledger`**, PR into `cmo-build`. One session, in the order of
> §5. Source: the chat-control audit ([`../../research/agents/2026-11-01-cmo-chat-control-audit.md`](../../research/agents/2026-11-01-cmo-chat-control-audit.md),
> recommendation 4 and "3rd-party API" §5), and the R5 review (#148), which left the owner four pricing questions
> that need real numbers.

## 0. Scope

OpenCMO pays several providers:
- LLM APIs;
- ScrapeCreators;
- fal (images and video);
- ElevenLabs (voice and Scribe).

Only two places record USD:
- `agent_usage` (Assistant turns);
- `work_order_usage` (Studio orders).

CMO jobs record nothing. ScrapeCreators is only counted for chat and MCP calls (`cmo_read_hit` buckets), in calls,
not money. The engine's `Provider.cost()` is in credits, not USD. Nobody can answer "what did founder X cost us this
week", and the owner's pending decisions need that number:
- the Annual plan's credits;
- refunds on an empty `sales_scan`;
- refunds on blocked moderation;
- Assistant usage past the hold.

This phase records every paid provider call in one ledger, in micro-USD, and gives the owner a read-only view and a
safety cap.

**Status:** plan, owner go-ahead 2026-11-02.

**Not in this phase:** changing prices or credits (owner decisions); billing users for provider spend.

## 1. Goal and decisions

**Goal:** a query, or an owner page, answers:
- the cost per founder per day, per provider and per job kind;
- the cost per approved deliverable.

A runaway founder or bug is stopped by a daily USD cap before the bill grows.

**Decisions:**
1. **One table, `provider_usage`:**
   - columns: `id`, `user_id`, `provider` (anthropic, gemini, groq, openai_compat, scrapecreators, fal,
     elevenlabs), `model_or_endpoint`, `units` (jsonb: tokens, calls, seconds, characters), `micro_usd`, `ref_kind`
     and `ref_id` (cmo_run, agent_turn, generation, task, work_order), `created_at`;
   - written by the service role only, through `provider_usage_record(...)`;
   - no user grants (internal cost data).
2. **Prices live in one place:** `provider_prices` (provider, model or endpoint pattern, unit prices, valid from),
   seeded in the migration from COSTS.md (internal repo) and `lib/eval/prices.ts`. `agent_model_prices` keeps
   serving credits for the Assistant; the plan notes where both must agree.
3. **What is recorded:**
   - **CMO job LLM calls:** `structured()` already fans usage out to `onLlmUsage`, so the runner registers one listener
     per run and writes the usage with `ref_kind = 'cmo_run'`.
   - **ScrapeCreators:** `scGet` records one call per request with its endpoint. A 402 or 404 is recorded at 0, and a
     cache hit when the provider says `cached: true`.
   - **fal and ElevenLabs:** the worker records each paid call with the provider's own unit (seconds, characters) and
     a USD figure from `provider_prices`, next to `complete_generation`.
   - **Assistant turns:** keep `agent_usage`; a view unions it in, rather than writing twice.
4. **A daily safety cap per founder in USD**, default $5 a day across all providers. Past it, new paid calls are
   refused with "Your CMO reached today's limit. It will continue tomorrow." It is checked in
   `provider_usage_record` and in the read paths before a call (`scGet`, the job runner). Owner gate 1 sets the
   number.
5. **The owner view** is a page under `/app/settings/costs`, visible only to `OPENCMO_OWNER_EMAILS`. It shows
   yesterday and the last 7 days per provider, the top 20 founders, and cost per approved card.

## 2. What ships

| # | Feature | Who sees it | Done when |
|---|---|---|---|
| F1 | `provider_usage` + `provider_prices` | — | Migration with RLS on and no user grants, pgTAP for the record RPC and the cap, `current.sql` regenerated. |
| F2 | CMO job LLM spend | owner | Every `structured()` call in a run writes a row (`ref_kind cmo_run`). |
| F3 | ScrapeCreators spend | owner | Every `scGet` writes a row, from jobs, chat and MCP alike. |
| F4 | fal and ElevenLabs spend | owner | The worker writes a row per paid call (engine: `opencmo/ai/providers/*`, `generate_task.py`). |
| F5 | Daily cap | founder (a clear message) | Past the cap, `scGet` and job model calls refuse, the run fails with a refund, and the chat says so. |
| F6 | Owner costs page | owner | Totals for 7 days by provider and by job kind, the top founders, and cost per approved deliverable. |
| F7 | Acceptance | | A fake run of each job kind writes rows. The cap trips in a test. The page renders at 1440 and 390. |

## 3. What exists (cmo-build `5a99ddd`)

- **Assistant usage:** `agent_usage` (`agent_record_usage_for`), with prices in `agent_model_prices` and
  `agent_micro_usd`.
- **Studio usage:** `work_order_usage` (`studio_record_usage`).
- **LLM usage hooks:** `lib/cmo/jobs/llm.ts` has `onUsage` per call and `onLlmUsage` listeners; only the eval
  runner uses them. `think.ts` records nothing.
- **ScrapeCreators:**
  - `lib/cmo/social/scrapecreators.ts` `scGet`: `ScBudget` is in memory, and `SocialReadError.kind` exists since R2;
  - `cmo_read_hit` buckets `chat_social`, `mcp_social` and `social_day` (R4) count calls for chat and MCP only.
- **Engine:** `packages/engine/opencmo/ai/providers/base.py` `Provider.cost()` returns credits;
  `worker/generate_task.py` passes them to `complete_generation(p_credits)`. No USD is stored.
- **Prices:** `apps/web/lib/eval/prices.ts` holds the eval price table. COSTS.md is in the internal repo.

## 4. Research

- **Langfuse and Helicone** (MIT and Apache-2.0) record a cost row per LLM call with model, tokens and computed USD,
  and keep prices in a table with a valid-from date so old rows keep their old price. **Learn:** store the computed
  `micro_usd` at write time, never recompute history from today's prices.
- **OpenAI and Anthropic usage APIs** give per-key totals but no per-founder breakdown. Our ledger is per founder by
  construction.
- **A cap where the money is spent:** checking in the record RPC alone would let the call through and refuse
  afterwards. The read paths also check `provider_spend_today(user) < cap` before calling.

## 5. Tasks

| Task | What | Waits on |
|---|---|---|
| **A0** | **Contracts.** Migration `20270104010000_provider_spend.sql`: `provider_prices` (seed rows), `provider_usage`, `provider_usage_record`, `provider_spend_today`, `provider_spend_cap` (config row), RLS and grants. pgTAP `243_provider_spend`. TS `lib/spend/record.ts` (`recordSpend`, `spendAllowed`) and Python `opencmo/backends/supabase/spend.py`. | — |
| A1 | **CMO jobs.** The runner registers an `onLlmUsage` listener per run and writes rows. `think.ts` passes nothing new; `structured()` already fans out. | A0 |
| A2 | **ScrapeCreators.** `scGet` takes a recorder (user id and ref) and checks `spendAllowed` first. The callers in jobs, the chat scope and MCP pass it. | A0 |
| A3 | **Engine providers.** fal and ElevenLabs record after each paid call, with units and USD. A unit test with a fake store. | A0 |
| A4 | **Cap behaviour.** The job runner turns a cap refusal into a refunded failure with the founder message; the chat's research tools return it as a tool error. | A1, A2 |
| A5 | **Owner page.** `/app/settings/costs`, owner-only, reading through a service-role server component limited to `OPENCMO_OWNER_EMAILS`. This is a deliberate exception: add it to `lib/supabase/admin.ts`'s allowed callers and to CLAUDE.md's list. | A0 |
| A6 | **Checks and acceptance.** `/code-review` on the diff. | A1–A5 |

## 6. Owner gates

1. The daily cap per founder (default $5) and whether paid plans get a higher cap.
2. The seed prices: confirm the COSTS.md figures for each provider and model before the migration merges.
3. The service-role exception for the owner page (CLAUDE.md lists the allowed callers).

## 7. Review focus

- `provider_usage` is never readable by users. The record RPC is service-role only.
- Recording never blocks a user's result when it fails: write it after the call, log any error, never throw into the
  job, except the cap check before a call.
- Prices are stored with each row; a price change never rewrites history.
- The cap refuses before money is spent and refunds the founder's credits for the refused run.
