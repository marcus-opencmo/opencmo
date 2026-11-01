# Session A: Sales safety, niche research, loaders

Plan: [`../2026-10-28-p5-research-sales-slides-plan.md`](../2026-10-28-p5-research-sales-slides-plan.md) · rules: [`README.md`](README.md).

## You own

- `supabase/migrations/20261231*`, `supabase/tests/` for them, `supabase/schema/current.sql`
- `packages/contracts/capabilities.json` (new entries), the `render_stills` row in `task-kinds.json`
- `apps/web/lib/cmo/jobs/sales-scan.ts`, `competitor-research.ts`, new `niche-video-research.ts`, `apps/web/lib/cmo/social/`
- `apps/web/lib/screens/` (types, fixtures, loaders, registry), `apps/web/app/api/v1/screens/`
- `docs/research/growth/` (the R0 report, in Vietnamese per `docs/research/README.md`), `docs/plans/cmo/2026-10-28-p5-acceptance/`

## Order

A0 → (push, M1) → A2 → A1 (once R0 names the rules source) → A3 (after B3) → A4. Post "M1/M2/M3 ready for review" on the PR.

## Todo

- [x] **A0 Contracts (push first)**
  - [x] 1. Migration skeleton with grants, RLS and pgTAP: `subreddit_rules` (subreddit, verdict
        `mention_ok|help_only|skip`, summary, read_at; shared cache, written only by the service role),
        `sales_settings` (user, excluded subreddits, co-occurrence pairs), `cmo_draft_outcomes.mentioned_product`,
        `cmo_insights.kind` gains `niche_video`, `clips.kind` gains `slideshow`, `deliverables.kind` gains `image`,
        `tasks.kind` gains `render_stills` (plus its `task-kinds.json` row). `approvals.kind` already has `slideshow`
        and Studio cards use `ref_kind = 'studio_step'`: no change there.
  - [x] 2. Snapshot types: `slideshow` (slides with text and still, MP4 preview, PNG set), Sales card states
        (help only + why, skipped + why); screen types for `sales.mentions`, `sales.stuck`, Research niche.
- [x] **A2 Niche video research (R2)**: `niche_video_research` job: the strategy's topics → top shorts on TikTok and
      YouTube Shorts (outliers vs median; Reels only if R0 finds an Instagram search), transcripts for the top few,
      hooks with their URL; store text, metrics and URL only, never the video; budget per run; an insight without a
      URL is dropped; runs when the plan has a video item; Writer's brief reads it.
- [x] **A1 Sales safety (R1)**: a new reader call for subreddit rules (none exists; source per R0) → classify the rules
      page as data → cache 7 days; `mentioned_product` set in code from the final approved text in
      `cmo_decide_opportunity` (last 10 approved replies, 1-in-10 rule → help only); excluded subreddits and
      co-occurrence applied before scoring; reply checks in code (no links, < 120 words); voice notes in Sales drafts
      (No AI Slop is already loaded). Tests: a hostile rules page; a help-only draft edited to name the product counts.
- [x] **A3 Loaders, rules and publish**: `sales.mentions`, `sales.stuck`, Research niche, Studio slideshows and images;
      event rule: slideshow or image approved → schedule (P4); the P4 publish step handles `slideshow` (MP4 via its
      clip) and `image` (attached to its post), with pgTAP; flip `live`.
- [~] **A4 Acceptance** (fake-provider run passed, `2026-10-28-p5-acceptance/README.md`; screenshots, the real slideshow and R0 open) with fake providers (F13), one real slideshow made in the Slides view kept as landing material, peak RSS of the slideshow render and stills, screenshots at 1440 and
      390 into `docs/plans/cmo/2026-10-28-p5-acceptance/`; the R0 report with the owner's decision.

## Requests

(Others append `[from → A] what, why`; answer here with the commit.)

- [from B → A] Bucket `exports` allows only `video/*`: add `image/png` and `application/zip`, or `render_stills` uploads are refused.
- [from B → A] An RPC to queue `render_stills`, like `request_document_export` (ownership, daily limit, sets the destination), e.g. `request_stills_export`. Input and output: `RenderStillsInput`, `RenderStillsOutput` in `apps/web/lib/departments/studio/types.ts`.
- [from B → A] Order kinds `build_slideshow` and `build_post_image` and their branch in `lib/cmo/jobs/studio-orders.ts`; B writes the adapter functions (B3, B4).
- [from B → A] `capabilities.json` rows for `build_slideshow` and `build_post_image` (callers `brain`, effect `write`, approval `founder`, credits 0): the squads spend no credits. Needed when B3 adds them to `STUDIO_ACCESS`.
  → [A] Done in A0 (commit below): bucket mimes, `request_stills_export(clip, revision, request)` (payload matches
  `RenderStillsInput`, plus `still_prefix` = `<user>/<clip>/<task>` for `-01.png`…), and the order kinds
  `build_slideshow` / `build_post_image` in SQL (claimed, moved, charged and departed like `build_video`). The
  `studio-orders.ts` branch and the two `capabilities.json` rows go in **B's** B3/B4 commits, with the adapter
  functions and `STUDIO_ACCESS` they must match (A agrees to B editing those two places for this).

- [A, A0] Done in `20261231090000_p5_contracts.sql` (pgTAP `221`), beyond the list above, for B and C:
  `create_slideshow(name, aspect)` (a `clips.kind = 'slideshow'` edit, renamable like a blank one);
  `studio_steps.kind` `slideshow` and its card snapshot (`SlideshowSnapshotSchema`; the hash follows the document);
  `opportunities.rule` / `rule_why` (a `skip` thread has no draft and no card); `sales_settings_save(excluded, pairs)`;
  `request_stills_export(clip, revision, request)` queuing `render_stills` with `<user>/<clip>/<task>.zip` and
  `still_prefix` for `<task>-01.png`…; bucket `exports` takes `image/png` and `application/zip`; order kinds
  `build_slideshow` and `build_post_image` claimed, moved and charged like `build_video` (Studio), and
  `niche_video_research` (Research). `render_stills` has a stub handler that fails the task until B2 replaces it.
  The `capabilities.json` rows for `buildSlideshow` / `buildPostImage` and the `studio-orders.ts` branch land with
  B's adapter functions (B0/B3), since both must change with `STUDIO_ACCESS`.
- [from B → A] Add `render_stills` to the deletion enumerators (`current.sql` kind lists `client_export, finalize, render_document` in job deletion and the task-delete trigger). B2's output lists every object in `output.manifest.files`, but those kinds skip it, and a crashed attempt has no output: use `still_prefix` for it. Without this, PNGs and zips outlive a deleted job. Please add a pgTAP case.
- [from B → A] The B3 SQL pieces sent by message: `studio_slideshow_rendering` holding the step, the render rule raising the card when both tasks are done, approving finishing the order with its deliverable, and `write_slides` feeding `build_slideshow`.
  → [A] Both done in `20261231100000_p5_slideshow_card.sql` (pgTAP `222`). `studio_slideshow_rendering(order, clip,
  input, card, mp4_task, stills_task)` returns the step id: brain JWT, owned `slideshow` clip, open `build_slideshow`
  order, both tasks this clip's; the step is tool `make_slideshow`, kind `slideshow`, price 0, status `running` (no card).
  `tasks_studio_rules` settles it (`studio_slideshow_settle`): a failed render fails step and order with the task's
  error; both done for the current document hash → the step turns `waiting` (card raised) and the order waits on the
  founder; renders of an older document fail it (`document_changed`, retryable). `approval_decide` takes `approve`
  (step done, `slideshow` deliverable on the clip, order done) or `send_back` (order failed with the reason);
  `studio_steps_claim` skips slideshow steps. `write_slides` done → each queued `build_slideshow` depending on it gets
  `brief.slides` (Writer's `[{heading, body}]`), `brief.slides_reason` and `brief_from: writer`; a failed or bad output
  drops the dependency. Nothing orders the `write_slides` + `build_slideshow` pair yet: the week plan has no slideshow
  item (`content_items.department` is post/sales/video), so that comes with A3. Deletion: `render_stills` is in
  `enqueue_job_objects` and the task-delete trigger, and PNGs are found by `still_prefix` in `storage.objects`.
- [from B → A] `lib/screens/studio.ts:60` and `load.ts:930` list clip kinds as `full | blank | short`: a founder with a slideshow edit may break the Studio screen's parse. Please add `slideshow` (found in the B3 run, not reproduced on the screen).
- [from C → A] A slideshow edited after its card was raised (a quick text edit on the card runs `set_slide_text` through
  `POST /editor/ops`; the Slides view does the same) leaves the step waiting on renders of the old document, and nothing
  renders it again. Please re-render (MP4 + stills) when a waiting slideshow card's `document_hash` no longer matches the
  edit and raise a new card, e.g. in the card loader or a "render again" RPC the card can call. Until then the card says
  "Text changed", disables Approve and offers Send back and Open in Slides.
- [from C → A] A help-only reply fixture for the inbox and e2e: `REPLY_CARD` with `rule: { kind: "help_only", text: "r/startups bans self-promotion: help only" }`
  (a second card, e.g. `REPLY_HELP_ONLY_CARD`, in `SAMPLE_CARDS`), so the help-only state shows outside a seeded database.
- [A] B4's SQL is in `20261231120000_p5_post_image.sql` (pgTAP `224`): `create_post_image_edit(name, aspect,
  source_clip default null)` (brain only; a `slideshow`-kind edit in the source video's job, owner checked, else a
  job of its own); `studio_post_image_rendering(order, clip, post, stills_task)` returns the step id (kind
  `post_image`, no card); the still done for the current document → `image` deliverable on the edit's clip with
  `deliverables.post_id` = the post (new column, required exactly for `image`; the newest per post wins), order done;
  a failed still fails the order. Also from B's note: `slideshow` added to the clip kinds in `lib/screens/studio.ts`
  and `load.ts`.
- [from C → A] For A3: C2 added `POST /api/v1/sales/settings` (`app/api/v1/sales/settings/route.ts`, zod → `sales_settings_save`,
  answers `{excludedSubreddits, pairs}`); the Sales screen saves through it once `live.settings` is true, so the loader's
  `settings` part only has to read `sales_settings` (`excluded_subreddits`, `co_occurrence`). Research's new "What works
  on video in your niche" table reads `scope = "niche_video"` insights and their `video` fields; the fixture's niche rows
  have no `video` yet (length and format show "—"): please add one with `video: { views, outlier, seconds, format }`.
- [A] A1 (owner 2026-10-31: fix, do not upgrade Sales yet; the multi-platform Sales finder is its own PR #133): the rules
  source is the provider's `subreddit/details` (`rules` text, cached 7 days by the provider and in `subreddit_rules`),
  classified as data by a `check_rules` step (an inbox step too, for mode B). One mention per scan while none of the
  last ten posted replies named the product, else help only with why. Excluded subreddits and pairs before scoring;
  code drops drafts with a link, over 120 words, or the product named in a help-only reply. `cmo_decide_opportunity`
  takes the posted text (`p_text`); `product_mentioned` reads it. pgTAP `227`.
- [from C → A] Schedule card image: add `preview.imageUrl` (nullable, signed from `snapshot.image.object` in `exports`) to
  `ScheduleBody` and sign it where the schedule cards are enriched; C then shows the image above the post's words.
- [from C → A] FYI, found while running e2e: on `cmo-p5` as of `b5f389a`, `ui-v2-schedule` fails "connect Threads through
  the fake Zernio" (no "Connect Threads" button in Settings → Accounts) and "dragging its slot … asks again" (no "New time
  saved" toast). Both fail the same way without C's changes.

- [C → A] Code review fixes (2026-10-31, owner: C fixes all, A and B pull before editing these again). C touched A's
  files: new migration `20261231160000_p5_review_fixes.sql` + pgTAP `228` (slideshow re-render, fresh renders only,
  cancelled renders settle, rename keeps the upload's name, CMO renders skip the daily export limit, stills in the
  export cap, `create_slideshow(name, aspect, order)`); `221` and `182` follow the new signatures; `current.sql`
  regenerated; `sales-scan.ts` (a waiting mention draft counts; rules read four at a time), `store.ts`/`types.ts`/
  `memory-store.ts` (`waitingMentions`), `jobs.check.ts`, `social/research.ts` (+check: bare YouTube array, one per URL),
  `load-workspace.ts` and `agent/cmo-tools.ts` (skipped threads are not conversations). The re-render request above is
  done: `POST /api/v1/studio/[clipId]/slideshow-render`.
