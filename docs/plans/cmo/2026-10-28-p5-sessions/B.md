# Session B: slide ops, stills, Slideshow and Post image squads

Plan: [`../2026-10-28-p5-research-sales-slides-plan.md`](../2026-10-28-p5-research-sales-slides-plan.md) · rules: [`README.md`](README.md).

## You own

- `packages/editor-core/src/ops/slides.ts` (new) and its tests, the slide entries in the ops registry
- `packages/clip-doc/` only if B0 finds a schema change unavoidable (with its migration)
- `packages/engine/opencmo/worker/render_stills_task.py` (new) and the Node still exporter in `packages/clip-export/`
- `apps/web/lib/departments/studio/` (`buildSlideshow`, `buildPostImage`, the squads)
- `apps/web/lib/cmo/agents/registry.ts` (slideshow visuals agent only, if one is needed)

## Order

B0 → (push, M1) → B1 → B2 → B3 → B4.

## Todo

- [x] **B0 Contracts (push first)**: slide op signatures (`add_slide`, `move_slide`, `delete_slide`,
      `set_slide_duration`, `set_slide_text`) and the slideshow document shape (each slide a timed span on one
      timeline, built from the groups and markers `clip-doc` already has; a `clip-doc` schema change only if
      unavoidable, then B owns it with a `clip-doc` migration and flags it at M1); adapter types `buildSlideshow(brief)` and `buildPostImage(brief)`; `render_stills` task input and
      output (one PNG per slide, a cover index).
- [x] **B1 Slide ops** in `editor-core` with golden-document tests; listed in the ops registry so the Assistant and
      MCP get them; a slideshow document validates with `clip-doc`.
- [x] **B2 `render_stills`**: one still per slide from `clip-render` (Node) at the slide's midpoint, on top of
      `clip-export/src/look.ts`'s single-frame path with text kept (not a second exporter), PNG set zipped;
      measure peak RSS; MP4 keeps going through `render_document`.
- [x] **B3 Slideshow squad**: `write_slides` (P3) → reviewer (code: text fits the frame, no invented numbers, words to
      avoid; sends back once) → visuals (captured pages and the founder's screenshots first, `/image` with
      moderation otherwise, never text inside the image) → builder (slide ops, Brand Kit) → MP4 + PNG set → one
      `slideshow` card through A's step RPC.
- [x] **B4 Post image squad**: a frame of the founder's video or a captured page + a title layer; generate only when
      none fits; aspect per platform; Brand Kit; an `image` deliverable attached to its post.

## Notes for M1

- **No automatic AI images (owner, 2026-10-30):** B3 uses the founder's screenshots, captured pages and Brand Kit
  backgrounds, so nothing spends credits before a card. An AI image is the founder's own `/image`, priced as always.
  B4 follows the same rule, a session decision to keep credits behind approval. Both differ from the plan's F10 and
  F11 and from `studio.md` §7 and §8, which allow generating.
- **No `clip-doc` schema change:** only a pure helper, `slideSpans`, shared by the slide ops and the still export.
- `buildSlideshow` and `buildPostImage` join `STUDIO_ENTRIES` and `StudioAdapter` in B3, with their rows in
  `capabilities.json` (A), so `capabilities.check.ts` stays green; B0 ships their types only.
- `render_stills` must honour `jobs.watermark`, or the PNG set would be a way round the free plan's watermark.
- **B2 measured (2026-10-31):** 35 slides at 1080×1920, half with a 1920×1920 image: peak RSS 497 MB, 3 s, 6.1 MB of
  PNG (`/usr/bin/time -v`, the Node drawing only). Slides 1 and 2 opened and looked at: right slide, text kept; that look
  added the scrim on image backgrounds. Not yet run: an upload to real Storage or `request_stills_export` end to end
  (fake store in `test_worker_render_stills.py`); A4's acceptance covers it. The worker's ffmpeg watermark ran on PNGs
  in the test.
- **B3 run (2026-10-31):** one `build_slideshow` order on the local stack with its worker
  (`slideshow/slideshow.e2e.ts`): one card with 5 slides, a 17 s 1080×1920 MP4 with audio, a zip of 5 PNGs in Storage,
  approve → order done, deliverable ready, no credits spent. A frame of the full-size MP4 and the PNGs were looked at:
  right slide, text and watermark on both. Real Storage upload is now covered. Not covered: captured-page backgrounds on
  a real order, and the `write_slides` → `build_slideshow` pair, which nothing orders until A3 (A's pgTAP 222 covers the rule). No real model ran.
- **B4 run (2026-10-31):** three `build_post_image` orders on the local stack (`slideshow.e2e.ts`): a captured page on X
  (1920×1080), the plain background on LinkedIn (1080×1080), TikTok (1080×1920); each an `image` deliverable on its post,
  looked at. The same run put a captured page behind a post image on a real order. **Not run: a real video frame.** It
  goes through `saveFrame`, which needs the deployed `look` endpoint; locally that is not set up, so the run only proved
  the fallback to the plain background. Check it once on a deployed worker. The title sits above centre with no body.
- **Visuals:** captured pages or the Brand Kit background. The founder's library screenshots are not used: a library
  belongs to one job, and a new slideshow edit starts with an empty one.

## Requests

(Others append `[from → B] what, why`; answer here with the commit.)

- [C → B] Code review fixes (2026-10-31, owner: C fixes all). C touched B's files: `slideshow/build.ts` (`renderSlideshow`
  shared with "render again", `cardSlides` reads the card from the document, `create_slideshow` gets the order so a
  retry reuses its edit and skips the slides already there), `render.ts` (`requestIdFrom`, ids unchanged and pinned in
  `squad.check.ts`). Pull before editing them again.
