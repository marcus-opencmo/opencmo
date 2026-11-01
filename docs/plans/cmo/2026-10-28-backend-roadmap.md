# Backend roadmap after wave 1: five phases, one PR each

Status: **P2–P5 merged into `cmo-build`** (#124, #125, #126, #127; 2026-10-29 → 10-31); **P6 ready** (#128). Real
posting through Zernio still waits on the owner gates of P4 (owner, 2026-10-30: its own phase). Written 2026-10-28. Owner decision: keep building the new OpenCMO on `cmo-build`, do not merge it to
`main` yet, and build the remaining backend in phases, one PR per phase. Each phase branch is cut from `cmo-build`,
its PR targets `cmo-build`, and it merges there when its acceptance passes. `cmo-build` goes to `main` only when the
owner says so.

Phase names come from `docs/architecture/` (`brain.md` §11, `approval.md` §11, `studio.md` §11,
`schedule-publish.md` §10, `writer.md` §10, `research-sales.md` §9). Wave 1 (PR #122) built B0, B1, B2, A0 and all
the UI: 4 of 28 backend phases.

| Phase | Branch / PR | Builds | Backend after it | The founder gets |
|---|---|---|---|---|
| **P2 Studio joins the brain** (plan: [`2026-10-28-p2-studio-brain-plan.md`](2026-10-28-p2-studio-brain-plan.md)) | `cmo-p2` → `cmo-build` | B3 registry + event rules + Studio adapter, S1 finished state + shorts as their own edits, A1 Studio cards, S2 Shorts squad | 8 of 28 ≈ 29% | the week plan includes a video; its cards (storyboard, price, finished video) land in the Dashboard queue; every finished video becomes a batch of 3 shorts |
| **P3 Writer for every platform** (plan: [`2026-10-28-p3-writer-plan.md`](2026-10-28-p3-writer-plan.md), on `cmo-p3`) | `cmo-p3` → `cmo-build` | W0 No AI Slop guidance + post rules, W1 platform profiles (Threads, LinkedIn), W2 voice notes into the Library, W3 words for Studio (captions, hashtags, YouTube title, video brief, slide text) | 12 of 28 ≈ 43% | posts per platform in their voice; shorts with captions and hashtags; Library Voice and Skills live |
| **P4 Schedule and Publish** (plan: [`2026-10-28-p4-schedule-publish-plan.md`](2026-10-28-p4-schedule-publish-plan.md), on `cmo-p4`) | `cmo-p4` → `cmo-build` | P0 Zernio checks + account connect, P1 scheduled posting through Zernio, A3 schedule cards with expiry | 15 of 28 ≈ 54% | posts and shorts go out at the time they approved, on their own accounts; the Schedule page and Settings accounts live |
| **P5 Research, Sales and the rest of Studio** (plan: [`2026-10-28-p5-research-sales-slides-plan.md`](2026-10-28-p5-research-sales-slides-plan.md), on `cmo-p5`) | `cmo-p5` → `cmo-build` | R0 data terms, R1 Sales safety, R2 niche video research, S3 slideshow + post image squads | 19 of 28 ≈ 68% | subreddit rules and rare product mentions; video briefs from niche research; slideshows |
| **P6 Quality and reach** (plan: [`2026-10-28-p6-quality-reach-plan.md`](2026-10-28-p6-quality-reach-plan.md), on `cmo-p6`) | `cmo-p6` → `cmo-build` | A2 email + push + phone-first queue, P2 best time, P3 Zernio metrics, R3 reply outcomes + Zernio metrics, R4 Hacker News, S4 look check, B4 brain evals, W4 X threads | 27 of 28 (the 28th, S0 finishing the long take on production, runs on the editor roadmap) | the Analytics page live on every account; digest by email; measured brain quality |

Rules for every phase (from `CLAUDE.md`, "Working style"):
- One branch and one PR per phase, created with the plan before any session starts; every session of the phase works
  there.
- Each session has its own checklist file in `<plan>-sessions/<session>.md` with a numbered todo list, the paths it
  owns, its order and what it waits on. Building blocks two sessions need are built once, first, by one named session.
- Commit and push as you go; every commit green on its own.
- The planning session reviews at the phase's milestones and before the phase PR merges into `cmo-build`.
- Plans P3–P6 were drafted early (owner, 2026-10-28), each in its own draft PR. Before a phase's sessions start, the
  planner merges `cmo-build` (with the phases before it) into that phase's branch and refreshes the plan's §3 from
  what was actually built.
- Migration prefixes per phase keep files in order: P3 `20261229`, P4 `20261230`, P5 `20261231`, P6 `20270101`.
