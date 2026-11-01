import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, withApi } from "@/lib/api/handler";
import { renderSlideshow } from "@/lib/departments/studio/slideshow/build";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

const body = z.object({}).strict();

/**
 * "Render again" (P5 review #1): a slideshow edited after its card was raised (a quick text edit on the card, or the
 * Slides view) gets a new MP4 and PNG set of the document as it is; `studio_slideshow_rerender` closes the old card
 * and the render rule raises a new one. Under the founder's session, so the export RPCs check ownership and the caps.
 */
export const POST = withApi(
  { body, rateLimit: { bucket: "project-write", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, user, params }) => {
    if (!UUID.test(params.clipId ?? "")) throw new ApiError(404, "Slideshow not found.");
    const clipId = params.clipId!;
    const { data: step, error } = await supabase
      .from("studio_steps")
      .select("id, card")
      .eq("clip_id", clipId)
      .eq("kind", "slideshow")
      .eq("status", "waiting")
      .maybeSingle<{ id: string; card: { title?: string; aspect?: string | null } | null }>();
    if (error) throw new ApiError(500, "Could not read this slideshow. Please try again.");
    if (!step) throw new ApiError(409, "This slideshow is not waiting on you, so there is nothing to render again.");
    const render = await renderSlideshow(supabase, user.id, clipId);
    if (!render.slides.length) throw new ApiError(409, "This slideshow has no slides. Add one in Slides first.");
    await rpcOrThrow(supabase, "studio_slideshow_rerender", {
      p_step: step.id,
      p_mp4_task: render.mp4TaskId,
      p_stills_task: render.stillsTaskId,
      p_card: { title: step.card?.title ?? "", aspect: step.card?.aspect ?? null, slides: render.slides.slice(0, 20), mp4_path: render.mp4Path, png_set_path: render.pngSetPath },
    });
    return { stepId: step.id, mp4TaskId: render.mp4TaskId, stillsTaskId: render.stillsTaskId };
  },
);
