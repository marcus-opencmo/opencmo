# P6 work split: three sessions, one branch, one PR

Plan: [`../2026-10-28-p6-quality-reach-plan.md`](../2026-10-28-p6-quality-reach-plan.md). Read it first; this folder says who
does what. **Branch `cmo-p6`, PR into `cmo-build`; every session works there.** No session opens its own branch or PR.

**Before any session starts:** the phase before this one has merged into `cmo-build`, the planner has merged
`cmo-build` into this branch and refreshed the plan's §3 from what was actually built.

| Session | File | Builds | First push (others wait on it) |
|---|---|---|---|
| **A** (lead) | [`A.md`](A.md) | SQL, Zernio metrics, best time, reply outcomes, card budget, loaders, acceptance | A0 contracts |
| **B** | [`B.md`](B.md) | look check, Studio and brain evals, Hacker News, X threads | B0 contracts |
| **C** | [`C.md`](C.md) | email and push, phone-first queue, Analytics and Brain measures live, thread card, e2e | — (C2 can start at once) |
| **Planner** | — | reviews M1, M2, M3 and the PR before it merges into `cmo-build` | — |

## Rules

1. **Own your paths** (in your file). Anything else: write a request in the owner's file under "Requests", never edit
   it yourself.
2. **One branch, no force.** `git pull --rebase origin cmo-p6` before every push; never `--force`, never rebase pushed
   commits, never push to `cmo-build` or `main`, never merge the PR.
3. **Commit and push as you go**, prefixed `[A]`, `[B]` or `[C]`, each green on its own (typecheck plus the tests of
   what it touches). Nothing stays only in your session.
4. **Tick only your own file.** Checklists and requests live per session, so no two sessions edit the same file.
5. **Contracts first.** Each session's Task 0 is small and pushed first; nobody builds on a contract before it is
   pushed, and a contract changes only through a request its owner accepts.
6. **Migrations belong to A**; A regenerates `supabase/schema/current.sql`. Migration names for this phase start with
   the prefix in the plan's §4, so they sort after the previous phase.
7. Heavy suites one at a time on one machine; real providers cost money and run only in the acceptance task, once,
   with the owner's go-ahead; no deploys.
8. At each milestone A posts one PR comment "M1 ready for review" (M2, M3) with commits and screenshots.

## Shared files (named blocks, one owner each)

| File | Block | Owner |
|---|---|---|
| `apps/web/package.json` | `check:contracts` additions | A |
| `apps/web/package.json` | e2e list | C |
| `apps/web/lib/screens/approval-card.ts` | thread and look-note fields | A |
| `apps/web/lib/departments/publish/zernio.ts` | thread posting only | B |
| `apps/web/lib/cmo/jobs/pull-metrics.ts` | the Zernio source | A |

## Prompts to start each session

Paste one into a new Claude Code session on this repository.

**Session A**
> You are Session A of `docs/plans/cmo/2026-10-28-p6-sessions/`. Read `README.md` and `A.md` there, the plan
> `docs/plans/cmo/2026-10-28-p6-quality-reach-plan.md`, and `docs/architecture/schedule-publish.md` §5 and §9, `research-sales.md` §6 and `brain.md` §10. Work on branch `cmo-p6` (PR into `cmo-build`).
> Do A0 and push it first, then the rest of `A.md` in order. Tick only `A.md`; commit and push as you go.

**Session B**
> You are Session B of `docs/plans/cmo/2026-10-28-p6-sessions/`. Read `README.md` and `B.md` there, the plan
> `docs/plans/cmo/2026-10-28-p6-quality-reach-plan.md`, and `docs/architecture/studio.md` §9–§10, `brain.md` §10 and `writer.md` §8. Work on branch `cmo-p6` (PR into `cmo-build`).
> Do B0 and push it first, then the rest of `B.md` in order. Tick only `B.md`; commit and push as you go.

**Session C**
> You are Session C of `docs/plans/cmo/2026-10-28-p6-sessions/`. Read `README.md` and `C.md` there, the plan
> `docs/plans/cmo/2026-10-28-p6-quality-reach-plan.md`, `docs/plans/cmo/2026-10-30-three-column-shell-plan.md` (every screen renders in its column 3), and `docs/architecture/approval.md` §7 and the frames `DashboardPhone.dc.html`, `Analytics.dc.html` and `Cards.dc.html` in `docs/plans/cmo/2026-10-27-app-redesign-frames/`. Work on branch `cmo-p6` (PR into `cmo-build`).
> Start with C2 at once, C0 and C1 once A0 is pushed, then the rest of `C.md` in order. Tick only `C.md`; commit and push as you go.
