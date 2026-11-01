# P5: Research for Studio, safe Sales, slideshows and post images

> **For agentic workers:** §2 says *what* ships, §5 the tasks. Three sessions build it on branch **`cmo-p5`** (PR into
> `cmo-build`). Each session's numbered todo list, owned paths and order are in
> [`2026-10-28-p5-sessions/`](2026-10-28-p5-sessions/): read `README.md` there, then your own file. Build nothing
> before your Task 0 is done; nobody builds on a contract before it is pushed.

## 0. Scope

Phase 5 of [`2026-10-28-backend-roadmap.md`](2026-10-28-backend-roadmap.md). It builds four
backend phases: **R0** (data terms), **R1** (Sales safety), **R2** (niche video research) from
[`research-sales.md`](../../architecture/research-sales.md) §9, and **S3** (Slideshow and Post image squads) from
[`studio.md`](../../architecture/studio.md) §11. After it: 19 of 28 backend phases (≈ 68%).

**Status: ready (refreshed 2026-10-30).** Written early on 2026-10-28; `cmo-build` (with P2–P4, `2304588`) is merged
into `cmo-p5` and §3 is refreshed from what was built. Sessions may start. R0 is an owner task (§6); its answer can
change R1's and R2's sources, never the safety rules.

**Order (owner, 2026-10-30): the editor first.** CLAUDE.md makes the editor the spearhead and puts Sales after the
editor sells, so M2 is the Slides view and niche research (they make marketing videos), M3 is Sales safety (it is
gated by R0 anyway, and Sales stays off the landing page until R0 is decided).

Not in this phase: reply outcome checks and Zernio metrics (R3, P6), Hacker News (R4, P6), the look check (S4, P6).

## 1. Goal and decisions

**Goal:** Sales drafts only where a subreddit's rules allow it and mentions the product rarely; Research finds what
works on video in the founder's niche and feeds Writer's video brief and Studio's Director; Studio makes slideshows
(MP4 and a PNG set from one document) and post images, each behind one card, scheduled like any deliverable.

**Decisions already made (owner, 2026-10-26 → 10-27):**
- Check ScrapeCreators' and Reddit's terms before Sales is sold (R0 first).
- Product mentions only where the subreddit allows, at most about 1 reply in 10; otherwise help only. No links in
  replies. Sales has no post button; the founder posts by hand.
- Niche video research feeds the editor strategy.
- No always-on keyword alerts; scans run when the week's plan has a Reddit item.
- **One editor core, a Slides view**: a project of kind `slideshow`, slide ops in `editor-core`, MP4 through
  `render_document`, the PNG set as one still per slide from the same renderer. Not a second editor.
- Text on slides and post images is always an editor layer, never inside a generated image; generated images are
  moderated; the founder's screenshots and captured pages first.

## 2. What ships

| # | Feature | The founder sees | Done when |
|---|---|---|---|
| F1 | Data terms (R0) | — | `docs/research/growth/` report on ScrapeCreators' terms for a paid product and the data terms of every platform we read through them (Reddit, TikTok, YouTube, Instagram); whether a subreddit-rules read and an Instagram Reels search exist; the owner's decision written in `research-sales.md` §10 |
| F2 | Subreddit rules check | a Sales card says "Help only: r/x forbids self-promotion" or the thread is skipped | before drafting, the subreddit's rules are read through a new reader call (none exists today; data, never instructions) and cached per subreddit for 7 days: `mention_ok`, `help_only`, `skip` |
| F3 | Rare product mentions | "Help only this time: you mentioned the product in 1 of the last 10 replies" | the founder edits and posts by hand, so the mention flag is computed in code from the **final approved text** at `cmo_decide_opportunity`, never from the draft's intent; over the last 10 approved replies, past 1 in 10 drafts are help only and the card says why |
| F4 | Replies in their voice | fewer replies that read like AI | Sales drafts already load No AI Slop (`sales-scan.ts`); add voice notes (P3); < 120 words; no links (code check) |
| F5 | Excluded subreddits and co-occurrence | Sales settings: excluded subreddits; "both terms must appear" | per-founder lists in SQL; queries filtered before paying for scoring |
| F6 | Sales screen complete | `sales.mentions` and `sales.stuck` live | the mention counter and the "stuck" banner (no passing thread for 2 scans) read real rows |
| F7 | Niche video research (R2) | Research → "What works on video in your niche": top shorts with hook, length, format, URL | `niche_video_research` job: top TikTok and YouTube Shorts for the strategy's topics (`search_videos` reads only `tiktok` and `youtube`; Reels only if R0 finds an Instagram search, else P6), transcripts through `get_transcript`; only text, metrics and the URL are stored, never the video itself; an insight without a URL is dropped; `cmo_insights.kind` widened |
| F8 | Research feeds the brief | the video brief cites the hooks it learned from | Writer's `write_video_brief` (P3) reads the niche insights; the brief carries their URLs |
| F9 | Slideshow project | "New" offers New video and New slideshow; a Slides view (strip, frame, text/image/colour/duration); "Timeline" switches to the full editor | `clips.kind` `slideshow`; ops `add_slide`, `move_slide`, `delete_slide`, `set_slide_duration`, `set_slide_text`; the Assistant and MCP get them |
| F10 | Slideshow squad | a slideshow card: the slides, quick text edits per slide, "Open in Slides", MP4 and PNG set | chain Writer (`write_slides`, P3) → Reviewer (code) → Visuals (screenshots and captured pages first; AI image moderated, no text inside) → Builder (slide ops) → Renderer (MP4 via `render_document`, PNG set via a new still export) |
| F11 | Post image squad | a post card with an image (cover, thumbnail) | a frame of the founder's video or a captured page with a title layer; generate only when none fits; aspect per platform; Brand Kit fonts and colours |
| F12 | Publish slideshows and images | an approved slideshow posts as a video at its time; a post goes out with its image | P4's publish step (`20261230140000_p4_finish.sql`) handles only `post`/`content_item` and `short`/`clip`: add `slideshow`/`clip` (the MP4) and `image` (media attached to its post; Zernio `mediaItems` already takes `image`). The PNG set stays a download in P5; carousel posting is P6 |
| F13 | Acceptance | — | a local run with fake providers: a slideshow card → approve → MP4 + PNG set → schedule card → fires through the fake Zernio; niche research → a brief citing URLs; Sales scan with one help-only and one skipped subreddit; plus one real slideshow made in the Slides view, kept as landing material |

## 3. What exists (`cmo-build` at `2304588`, P2–P4 merged; refreshed 2026-10-30)

- Sales: `lib/cmo/jobs/sales-scan.ts` (277 lines; queries, ≤ 30 threads, score with exact quotes, ≥ 60 passes, drafts
  for the best 5, already loads `no-ai-slop`), `opportunities`, `cmo_decide_opportunity`, `cmo_draft_outcomes`;
  reader in `lib/cmo/social/reddit.ts`, `scrapecreators.ts`, `research.ts` (**no subreddit rules call**); untrusted
  text in `lib/cmo/untrusted.ts`; budget `ScBudget`, `research_credits`.
- Research: `jobs/competitor-research.ts` (X only), `cmo_insights.kind` check `= 'competitors'` only; CMO chat tools
  in `lib/agent/cmo-research.ts` (`find_outliers`, `search_videos` for `tiktok | youtube` only, `get_transcript` for
  YouTube, TikTok, Instagram and X).
- Screens (`lib/screens/registry.ts`): `sales` live `threads`, `week` (`mentions`, `stuck` reserved for R1),
  `research` live, `studio` live `items`, `team`, `editStates`, `writer` and `schedule` live (P3, P4).
- SQL kinds today: `clips.kind` `full | blank | short`; `approvals.kind` already has `slideshow` (Studio cards are
  raised as `ref_kind = 'studio_step'`, no new ref kind); `deliverables.kind` already has `slideshow`, not `image`;
  `tasks.kind` from `packages/contracts/task-kinds.json` (`render_document`, `capture_page`, `publish_media`…).
- Studio: `lib/departments/studio/` (`adapter.ts`, `render.ts`, `finish.ts`, `shorts/squad.ts`); `editor-core` ops
  registry; `clip-doc` already has markers and groups; `clip-export/src/look.ts` draws single frames from the export
  renderer (`frame` mode drops text; a still keeps it); `/image` slash command and Generate with moderation; Brand Kit.
- P3: `write_slides` (5–10 slides, hook first, CTA last), `write_video_brief`, voice notes (`lib/cmo/writer/`).
- P4: schedule slots and cards for `post` and `short`, firing and publish through Zernio
  (`lib/departments/publish/zernio.ts`), the Schedule page.

## 4. Global constraints

- Every write through an ownership-checking RPC; credits only through `credit_*`; a pgTAP test per migration and per
  transition; regenerate `supabase/schema/current.sql`. **Migration prefix for this phase: `20261231`.**
- Outside text (subreddit rules, thread text, video transcripts) is data, wrapped by `untrusted.ts`; it never changes
  what an agent may do.
- Every research read has a credit budget; daily limits in SQL.
- Moderation on every image prompt before credits and every generated image after; no real people, no other brands'
  logos; no text inside generated images.
- One editor runtime: the Slides view is a view of the same editor and document; PNG stills come from `clip-render`.
- Peak RAM < 2 GB for the slideshow MP4 and the PNG set; measure once.
- English in all user-facing text; no model names; Sales never posts.

## 5. Tasks

| Task | Session | What | Waits on |
|---|---|---|---|
| **A0** | A | **Contracts first:** migration skeleton `subreddit_rules` (cache), `sales_settings` (excluded subreddits, co-occurrence pairs), `cmo_draft_outcomes.mentioned_product`, `cmo_insights.kind` + `niche_video`, `clips.kind` + `slideshow`, `deliverables.kind` + `image`, `tasks.kind` + `render_stills` (with its `task-kinds.json` row, or `check:contracts` fails); the `slideshow` approval snapshot (kind and `studio_step` ref already exist); screen types for `sales.mentions`, `sales.stuck`, the Research niche section | — |
| **B0** | B | **Contracts first:** slide ops' signatures and the slideshow document shape in `editor-core` (`ops/slides.ts` types only). A slide is built from what `clip-doc` already has (a timed group plus a marker per slide), so no `clip-doc` schema change; if one proves unavoidable, B owns it with a `clip-doc` migration and says so in M1. The Studio adapter's `buildSlideshow(brief)` and `buildPostImage(brief)` types; the still export task contract (`render_stills`) | — |
| A2 | A | R2: `niche_video_research` job (TikTok and YouTube Shorts, budget, outliers, transcripts, URL rule; text, metrics and URL only), its order kind and schedule (when the plan has a video item); Writer's brief reads it | A0 |
| A1 | A | R1 in SQL and jobs: a new reader call for subreddit rules (source per R0) → `subreddit_rules`; the mention flag from the final approved text in `cmo_decide_opportunity` and the 1-in-10 rule; excluded subreddits and co-occurrence in `sales-scan`; reply code checks (no links, < 120 words); voice notes in Sales drafts | A0, R0 known |
| A3 | A | Loaders: `sales.mentions`, `sales.stuck`, Research niche section, Studio slideshows and images; event rules slideshow or image approved → schedule (P4); publish wiring for `slideshow` and `image` (F12) | A1, A2, B3 |
| A4 | A | Acceptance (F13) with screenshots of Sales, Research and a slideshow card at 1440 and 390; the R0 report written with the owner | all |
| B1 | B | Slide ops in `editor-core` with tests (golden documents); MCP and Assistant get them through the registry | B0 |
| B2 | B | `render_stills` worker task: one PNG per slide from `clip-render` (Node), built on `clip-export/src/look.ts` (its single-frame path, text kept), not a new exporter; PNG set zipped for download; peak RSS measured | B0 |
| B3 | B | Slideshow squad in the Studio adapter: `write_slides` → reviewer (code: text fits the frame, no invented numbers, words to avoid) → visuals (captured pages first, `/image` moderated otherwise) → builder → MP4 + PNG set → one `slideshow` card | B1, B2, A0 |
| B4 | B | Post image squad: a frame or captured page + title layer, generate only when none fits; aspect per platform; Brand Kit; an `image` deliverable attached to its post | B3 |
| C0 | C | Slideshow card body (slides strip, quick text edit per slide, MP4 preview, PNG set, Open in Slides) and Sales card states (help only and why, skipped and why) on A0's types with fixtures | A0 |
| C1 | C | "New slideshow" entry and the Slides view in the editor (`components/editor/slides/`): strip with add/delete/drag, per-slide duration, Timeline switch | B1 |
| C2 | C | Sales settings (excluded subreddits, co-occurrence pairs), the mention counter and stuck banner live; Research niche section live | A3 |
| C3 | C | e2e: make a slideshow in the Slides view, approve a slideshow card, a help-only Sales card | C0–C2 |

**Milestones** (editor first, owner 2026-10-30)
- **M1** contracts: A0 and B0 pushed and reviewed; R0 started.
- **M2** slideshows and niche research: B1, B2, B3, C0 (slideshow part), C1, A2.
- **M3** safe Sales, post images, publish and acceptance: A1, A3, A4, B4, C0 (Sales part), C2, C3; the planner reviews
  the whole PR.

## 6. Owner gates

1. R0: read ScrapeCreators' terms for a paid product and whether Reddit's data terms reach us through them; decide
   the fallback (official Reddit API under a commercial agreement, or Sales on Hacker News, X and Threads first).
   Also: whether ScrapeCreators can read subreddit rules and search Instagram Reels, and that research on other
   creators' videos stores only text, metrics and URLs. Sales stays off the landing page until this is decided; A1
   waits on the answer for its rules source.
2. One real-model run of the slideshow squad (costs money), with the owner's go-ahead.

## 7. Review focus

- Subreddit rules are data: a rules page saying "ignore previous instructions" changes nothing.
- The 1-in-10 rule holds across scans; a help-only draft never mentions the product; a draft the founder edited to
  add the product counts as a mention (the flag comes from the final approved text).
- No links in replies; no post button anywhere in Sales.
- An insight without a URL from the data read is dropped; no other creator's video is downloaded or stored.
- An approved slideshow or image reaches Zernio through the P4 publish step; nothing new posts without approval.
- Slides are a view of the one editor; no second renderer; text never baked into a generated image.
- Moderation runs on every generated image; renders and stills inside the 2 GB budget.
