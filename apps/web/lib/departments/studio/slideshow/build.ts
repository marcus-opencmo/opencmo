/**
 * The Slideshow squad (P5 B3, `studio.md` §7): Writer's slides → Reviewer (code) → Visuals → Builder (slide ops, Brand
 * Kit) → MP4 and PNG set from one revision. SQL raises the one card when both renders are done.
 *
 * Nothing here spends credits (owner, 2026-10-30): visuals are the founder's captured pages or the Brand Kit
 * background, and an AI image is the founder's own `/image`. Text is always a layer. Every write is the founder's own
 * under RLS, through the ops.
 */

import { slideSpans, type ClipDocument } from "@opencmo/clip-doc";
import { activeScene, CAPTURE_SRC_PREFIX, SLIDE_LAYERS, SLIDE_SECONDS, SLIDE_TEXT_MAX } from "@opencmo/editor-core";

import { clipContext } from "@/lib/api/clips";
import { firstRow, rpcOrThrow } from "@/lib/api/handler";
import { defaultBrandKit } from "@/lib/brand";
import type { Slide } from "@/lib/cmo/writer/types";
import { applyToClip, readEditorProject } from "@/lib/editor/apply";
import { exportPlan, startDocumentExport } from "@/lib/editor/export";
import { ensureProject } from "@/lib/editor/project";
import { wakeWorker } from "@/lib/modal";

import { renderRequestId, requestIdFrom } from "../render";
import { SlideshowBriefSchema, type BuiltSlideshow, type SlideshowBrief, type StudioContext } from "../types";

/** Writer's own checks hold the facts and the words to avoid; this is what the frame holds, on any brief. */
export function reviewSlides(slides: readonly Slide[]): string[] {
  const issues: string[] = [];
  slides.forEach((slide, index) => {
    if (slide.heading.trim().length > SLIDE_TEXT_MAX.heading) issues.push(`Slide ${index + 1}'s heading is over ${SLIDE_TEXT_MAX.heading} characters.`);
    if (slide.body.trim().length > SLIDE_TEXT_MAX.body) issues.push(`Slide ${index + 1}'s body is over ${SLIDE_TEXT_MAX.body} characters.`);
  });
  return issues;
}

/** Long enough to read at about 3 words a second, never under 3 s. */
export function slideSeconds(slide: Slide): number {
  const words = `${slide.heading} ${slide.body}`.trim().split(/\s+/).length;
  return Math.min(SLIDE_SECONDS.max, Math.max(3, Math.ceil(words / 3)));
}

/**
 * One `add_slide` per slide. The hook and the call to action stay on the plain background, where they read best; the
 * slides between take the founder's captured pages in order, then the plain background.
 */
export function slideOps(slides: readonly Slide[], captureIds: readonly string[]) {
  const queue = [...captureIds];
  return slides.map((slide, index) => {
    const middle = index > 0 && index < slides.length - 1;
    const capture = middle ? queue.shift() : undefined;
    return {
      op: "add_slide",
      heading: slide.heading.trim(),
      ...(slide.body.trim() ? { body: slide.body.trim() } : {}),
      duration: slideSeconds(slide),
      ...(capture ? { background: { src: `${CAPTURE_SRC_PREFIX}${capture}` } } : {}),
    };
  });
}

export const stillsRequestId = (clipId: string, hash: string): string => requestIdFrom("render_stills", clipId, hash);

type CardSlide = { text: string; still_path: string; seconds: number };
type Node = { id?: string; name?: string; text?: unknown; children?: Node[] };

/** Each slide's words (heading, then the body on the next line) and length, read from the document as rendered. */
export function cardSlides(document: ClipDocument, stillPrefix: string): CardSlide[] {
  const groups = new Map(((activeScene(document) as unknown as Node).children ?? []).map((node) => [node.id, node]));
  return slideSpans(document).map((span, index) => {
    const layer = (name: string) => groups.get(span.id)?.children?.find((child) => child.name === name)?.text;
    const heading = typeof layer(SLIDE_LAYERS.heading) === "string" ? (layer(SLIDE_LAYERS.heading) as string) : "";
    const body = typeof layer(SLIDE_LAYERS.body) === "string" ? (layer(SLIDE_LAYERS.body) as string) : "";
    return {
      text: (body ? `${heading}\n${body}` : heading).slice(0, 300),
      still_path: `${stillPrefix}-${String(index + 1).padStart(2, "0")}.png`,
      seconds: Math.round((span.end - span.start) * 1e4) / 1e4,
    };
  });
}

export type SlideshowRender = { mp4TaskId: string; stillsTaskId: string; slides: CardSlide[]; mp4Path: string; pngSetPath: string };

/**
 * The MP4 and the PNG set of the slideshow as it is saved now, from one revision. Request ids follow the document, so
 * a retry gets the tasks already queued. Shared by the squad and by "render again" after the founder's edit.
 */
export async function renderSlideshow(supabase: StudioContext["supabase"], userId: string, clipId: string): Promise<SlideshowRender> {
  const project = await readEditorProject(supabase, clipId);
  const revision = await rpcOrThrow<{ id: string }>(supabase, "snapshot_editor_revision", { p_clip_id: clipId, p_document_hash: project.document_hash });
  const { resolution } = await exportPlan(supabase, userId);
  const mp4 = await startDocumentExport(supabase, clipId, revision.id, renderRequestId(clipId, project.document_hash), resolution);
  const stills = firstRow(await rpcOrThrow<{ id: string } | { id: string }[]>(supabase, "request_stills_export", { p_clip_id: clipId, p_revision_id: revision.id, p_request_id: stillsRequestId(clipId, project.document_hash) }));
  if (!stills) throw new Error("request_stills_export returned no task.");
  await wakeWorker({ task_id: stills.id });
  const prefix = `${userId}/${clipId}/${stills.id}`;
  return { mp4TaskId: mp4.id, stillsTaskId: stills.id, slides: cardSlides(project.document, prefix), mp4Path: `${userId}/${clipId}/${mp4.id}.mp4`, pngSetPath: `${prefix}.zip` };
}

async function readyCaptures(ctx: StudioContext, wanted: number): Promise<string[]> {
  const { data, error } = await ctx.supabase.from("page_captures").select("id").eq("status", "ready").order("created_at", { ascending: false }).limit(wanted);
  if (error) throw new Error(`page_captures read: ${error.message}`);
  return ((data ?? []) as { id: string }[]).map((row) => row.id);
}

export async function buildSlideshow(ctx: StudioContext, input: SlideshowBrief): Promise<BuiltSlideshow> {
  const brief = SlideshowBriefSchema.parse(input);
  const issues = reviewSlides(brief.slides);
  if (issues.length) return { kind: "invalid", message: issues.slice(0, 3).join(" ") };

  // One edit per order: a retry after a failed render reuses it (and its slides) instead of making another.
  const clipId = await rpcOrThrow<string>(ctx.supabase, "create_slideshow", { p_name: brief.idea.slice(0, 60), p_aspect: brief.aspect, p_order: ctx.orderId ?? null });
  const context = await clipContext(ctx.supabase, clipId);
  // Nobody opens this edit before the render, so the project the editor would create is made here.
  const existing = await ensureProject(ctx.supabase, context, clipId);
  if (!slideSpans(existing.document).length) {
    const kit = await defaultBrandKit(ctx.supabase);
    // Brand last: its logo must sit on top of the slides, and it recolours what they drew.
    const ops = [...slideOps(brief.slides, await readyCaptures(ctx, brief.slides.length)), ...(kit ? [{ op: "apply_brand", kit: kit.kit, frame: false }] : [])];
    await applyToClip(ctx.supabase, context, clipId, ops, { checkpoint: null });
  }

  const render = await renderSlideshow(ctx.supabase, ctx.userId, clipId);
  const card = { title: brief.idea.slice(0, 200), aspect: brief.aspect, slides: render.slides, mp4_path: render.mp4Path, png_set_path: render.pngSetPath };
  await rpcOrThrow(ctx.supabase, "studio_slideshow_rendering", {
    p_order_id: ctx.orderId ?? null,
    p_clip_id: clipId,
    p_input: { idea: brief.idea, aspect: brief.aspect },
    p_card: card,
    p_mp4_task: render.mp4TaskId,
    p_stills_task: render.stillsTaskId,
  });
  return { kind: "rendering", clipId, mp4TaskId: render.mp4TaskId, stillsTaskId: render.stillsTaskId };
}
