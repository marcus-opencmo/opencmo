# Session C: slideshow and Sales cards, Slides view, Sales and Research live

Plan: [`../2026-10-28-p5-research-sales-slides-plan.md`](../2026-10-28-p5-research-sales-slides-plan.md) · rules: [`README.md`](README.md).

## You own

- `apps/web/components/cards/` (slideshow, Sales help-only and skipped states)
- `apps/web/components/editor/slides/` (new) and the New menu entry
- `apps/web/components/screens/sales/`, `apps/web/components/screens/research/`
- `apps/web/e2e/ui-v2-slides.spec.ts` (new), the e2e list in `apps/web/package.json`

## Order

Read the frames while A0 and B0 land → C0 (slideshow part first) → C1 (after B1) → C0 Sales part → C2 (after A3) → C3.

## Todo

- [x] **C0 Card bodies** on A0's types with fixtures: slideshow (slides strip, quick text edit per slide, MP4 preview,
      PNG set download, Open in Slides, approve, send back) and Sales states (help only and why, skipped and why).
      Axe clean at 1440 and 390.
- [x] **C1 Slides view**: "New" offers New video and New slideshow; strip on the left (add, delete, drag), frame in the
      middle, text/image/colour/duration on the right, timeline hidden, "Timeline" switches to the full editor;
      every change through B's slide ops.
- [x] **C2 Sales and Research live**: Sales settings (excluded subreddits, co-occurrence pairs), the mention counter and
      stuck banner; Research → "What works on video in your niche" with hook, length, format and URL.
- [x] **C3 e2e**: build a 5-slide slideshow in the Slides view, approve a slideshow card, a help-only Sales card shows
      why and has no post button.

## Requests

(Others append `[from → C] what, why`; answer here with the commit.)

- [from B → C] `components/editor/EditorHome.tsx:21` and `ClipPicker.tsx:87,167,172` test `kind === "blank"`, so a slideshow clip looks like an upload there. `startsEmpty(kind)` in `lib/editor/project.ts` is the server-side rule (project route, Assistant, Studio); that module is server code, so use the same test locally.
  → [C] Done in C1: `components/editor/slides/kind.ts` `startsEmpty` (client twin of the server rule), used by
  `EditorHome` and `ClipPicker`.
- [A → C] (94327693) Slideshow card body now has optional `captions` (CaptionSchema[], like a finished video). `edit_caption`
  works on slideshow cards in SQL; `components/cards/decide.ts` `editCaption`/`withCaption` only handle finished video and
  shorts, so please add the slideshow case and show the captions on the card. Schedule snapshot has optional `image`
  (`{clip_id, object, bytes}`) for a post with its image: the schedule card could show it (sign `object` in `exports`).
  → [C] Captions: done (`decide.ts` handles slideshow captions, `SlideshowBody` lists them with Edit; e2e edits one and
  approves with the new hash). Schedule image: the card cannot sign it (signing is in `lib/screens/`), so a request to A
  for `preview.imageUrl` is in `A.md`; C shows it once the field exists.
