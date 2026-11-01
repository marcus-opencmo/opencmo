# P5 work split: three sessions, one branch, one PR

Plan: [`../2026-10-28-p5-research-sales-slides-plan.md`](../2026-10-28-p5-research-sales-slides-plan.md). Read it first; this folder says who
does what. **Branch `cmo-p5`, PR into `cmo-build`; every session works there.** No session opens its own branch or PR.

**Before any session starts:** done 2026-10-30. P4 merged into `cmo-build` (#126); `cmo-build` (`2304588`) is merged
into this branch and the plan's §3 is refreshed. Order is editor first: slideshows and niche research (M2) before
Sales safety (M3).

| Session | File | Builds | First push (others wait on it) |
|---|---|---|---|
| **A** (lead) | [`A.md`](A.md) | SQL, Sales safety, niche video research, loaders, R0 report, acceptance | A0 contracts |
| **B** | [`B.md`](B.md) | slide ops, still export, Slideshow and Post image squads | B0 slide and squad contracts |
| **C** | [`C.md`](C.md) | slideshow and Sales cards, New slideshow + Slides view, Sales settings, Research niche, e2e | — (starts on A0's and B0's types) |
| **Planner** | — | reviews M1, M2, M3 and the PR before it merges into `cmo-build` | — |

## Rules

1. **Own your paths** (in your file). Anything else: write a request in the owner's file under "Requests", never edit
   it yourself.
2. **One branch, no force.** `git pull --rebase origin cmo-p5` before every push; never `--force`, never rebase pushed
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
| `apps/web/lib/screens/approval-card.ts` | slideshow snapshot, Sales card states | A |
| `packages/contracts/task-kinds.json` | the `render_stills` row | A (B writes the handler) |
| `packages/editor-core/src/ops/index.ts` (registry) | the slide ops entries | B |
| `apps/web/components/editor/` | `slides/` and the New menu entry only | C |

## Prompts to start each session

Paste one into a new Claude Code session on this repository.

**Session A**
> You are Session A of `docs/plans/cmo/2026-10-28-p5-sessions/`. Read `README.md` and `A.md` there, the plan
> `docs/plans/cmo/2026-10-28-p5-research-sales-slides-plan.md`, and `docs/architecture/research-sales.md`. Work on branch `cmo-p5` (PR into `cmo-build`).
> Do A0 and push it first, then the rest of `A.md` in order. Tick only `A.md`; commit and push as you go.

**Session B**
> You are Session B of `docs/plans/cmo/2026-10-28-p5-sessions/`. Read `README.md` and `B.md` there, the plan
> `docs/plans/cmo/2026-10-28-p5-research-sales-slides-plan.md`, and `docs/architecture/studio.md` §7–§9 and the ops registry in `packages/editor-core/src/ops/index.ts`. Work on branch `cmo-p5` (PR into `cmo-build`).
> Do B0 and push it first, then the rest of `B.md` in order. Tick only `B.md`; commit and push as you go.

**Session C**
> You are Session C of `docs/plans/cmo/2026-10-28-p5-sessions/`. Read `README.md` and `C.md` there, the plan
> `docs/plans/cmo/2026-10-28-p5-research-sales-slides-plan.md`, and the frames `Sales.dc.html`, `Research.dc.html`, `Studio.dc.html` and `Cards.dc.html` in `docs/plans/cmo/2026-10-27-app-redesign-frames/`. Work on branch `cmo-p5` (PR into `cmo-build`).
> Start C0 once A0 and B0 are pushed, then the rest of `C.md` in order. Tick only `C.md`; commit and push as you go.
