import "server-only";

/**
 * Studio's orders (P2 A2, `brain.md` §7b): the brain briefs the Video agent team and never drives single tools. The
 * runner claims work with the service role (`studio_orders_claim`, `studio_steps_claim`, `studio_steps_ready`) and
 * drives B's adapter as the brain, under the founder's short-lived JWT (`clientFor`), so every write is the founder's
 * own under RLS and the service role never writes an editor document.
 *
 *   queued build_video  → buildVideo(brief)              → card 1                  (waiting_founder)
 *   approved step       → decide; keep `next` + `wait_for` → generations run         (waiting_order)
 *   generations done    → card 2 (plan, store), or the render of the long video; A3's rules raise card 3
 *   queued cut_shorts   → cutShorts(edit)                → short renders            (waiting_order)
 *   queued build_slideshow → buildSlideshow(brief)       → MP4 and PNG set renders  (waiting_order); SQL raises the card
 *   queued build_post_image → buildPostImage(brief)      → one still                (waiting_order); SQL writes the image
 *
 * The founder's decision on a card is recorded by `approval_decide`; this runner only carries it out. A step that
 * fails fails its order with the reason (the progress check replans from it).
 */

import { after } from "next/server";

import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import { studio } from "@/lib/departments/studio/adapter";
import { finishVideo } from "@/lib/departments/studio/finish";
import { runLookSendBacks } from "@/lib/departments/studio/look-redo";
import { renderEdit } from "@/lib/departments/studio/render";
import { PostImageBriefSchema, SlideshowBriefSchema, VideoBriefSchema, type StudioAdapter, type StudioContext } from "@/lib/departments/studio/types";
import type { LlmUsage } from "@/lib/cmo/jobs/llm";
import { balance } from "@/lib/cmo/mcp/account";
import { brainClientFor } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

type Order = { id: string; user_id: string; kind: string; brief: Record<string, unknown> };
type Step = {
  id: string;
  user_id: string;
  clip_id: string;
  tool: string;
  order_id: string;
  decision: "approve" | "redo" | "edit" | "cancel" | null;
  decision_payload: { index?: number } | null;
  next: { tool: string; input?: unknown; redoOf?: string } | null;
  wait_for: string[];
  plan_input: Record<string, unknown> | null;
};

/**
 * The adapter as the brain, for one order, under the founder's brain session. The Director's and the Clip editor's
 * model calls are charged to the order by their real tokens (`studio_record_usage`), as Assistant turns are.
 */
function brainStudio(userId: string, orderId: string): { ctx: StudioContext; adapter: StudioAdapter } {
  const ctx: StudioContext = { supabase: brainClientFor(userId), userId, caller: "brain", orderId };
  const recordUsage = async (usage: LlmUsage) => {
    await rpcOrThrow(ctx.supabase, "studio_record_usage", {
      p_order_id: orderId,
      p_model: usage.model,
      p_input: usage.input,
      p_output: usage.output,
      p_cache_read: usage.cacheRead,
      p_cache_write: usage.cacheWrite,
    });
  };
  return { ctx, adapter: studio(ctx, { recordUsage }) };
}

const message = (error: unknown) => (error instanceof ApiError ? error.message : "Studio could not finish this step.");

async function move(admin: SupabaseClient, orderId: string, to: "waiting_founder" | "waiting_order" | "failed", text: string, error?: { code: string; message: string }) {
  await rpcOrThrow(admin, "studio_order_move", {
    p_id: orderId,
    p_to: to,
    p_text: to === "failed" ? null : text,
    p_error: error ? { ...error, message: error.message.slice(0, 200), retryable: true } : null,
  });
}

/**
 * The order's brief → the adapter's brief. From the week plan's video item (objective, angle, seconds, aspect), or from
 * Writer's `write_video_brief` once it ran (P3: three hooks, key points, a call to action too; SQL copies them in).
 */
export function briefOf(order: Order) {
  const b = order.brief;
  return VideoBriefSchema.parse({
    objective: typeof b.objective === "string" && b.objective.trim().length >= 3 ? b.objective : "Show what the product does in one short video",
    angle: typeof b.angle === "string" ? b.angle.slice(0, 300) : "",
    ...(Array.isArray(b.hooks) ? { hooks: b.hooks.filter((h): h is string => typeof h === "string").slice(0, 3) } : {}),
    ...(Array.isArray(b.key_points) ? { keyPoints: b.key_points.filter((k): k is string => typeof k === "string").slice(0, 6) } : {}),
    ...(typeof b.cta === "string" ? { cta: b.cta.slice(0, 160) } : {}),
    ...(typeof b.seconds === "number" ? { seconds: Math.min(90, Math.max(5, Math.round(b.seconds))) } : {}),
    ...(b.aspect === "9:16" || b.aspect === "16:9" || b.aspect === "1:1" ? { aspect: b.aspect } : {}),
  });
}

async function runOrder(admin: SupabaseClient, order: Order): Promise<void> {
  const { ctx, adapter } = brainStudio(order.user_id, order.id);
  try {
    // The team's model calls are paid from the balance: with nothing left the order fails as needs_credits (nothing
    // re-queues it after a top-up yet; see the R2 review follow-ups).
    const credits = (await balance(ctx.supabase, order.user_id))?.credits;
    if (credits !== undefined && credits < 1) {
      return move(admin, order.id, "failed", "", { code: "needs_credits", message: "Top up credits so the video team can work." });
    }
    if (order.kind === "build_video") {
      const built = await adapter.buildVideo(briefOf(order));
      if (built.kind === "invalid") return move(admin, order.id, "failed", "", { code: "invalid_brief", message: built.message });
      return move(admin, order.id, "waiting_founder", "The storyboard waits on you");
    }
    if (order.kind === "build_slideshow") {
      const brief = SlideshowBriefSchema.safeParse(order.brief);
      if (!brief.success) return move(admin, order.id, "failed", "", { code: "invalid_brief", message: "This slideshow has no slides to build." });
      const built = await adapter.buildSlideshow(brief.data);
      if (built.kind === "invalid") return move(admin, order.id, "failed", "", { code: "invalid_brief", message: built.message });
      return move(admin, order.id, "waiting_order", "Rendering the slideshow");
    }
    if (order.kind === "build_post_image") {
      const brief = PostImageBriefSchema.safeParse(order.brief);
      if (!brief.success) return move(admin, order.id, "failed", "", { code: "invalid_brief", message: "This image has no post or title." });
      const built = await adapter.buildPostImage(brief.data);
      if (built.kind === "invalid") return move(admin, order.id, "failed", "", { code: "invalid_brief", message: built.message });
      return move(admin, order.id, "waiting_order", "Rendering the image");
    }
    const clipId = typeof order.brief.clip_id === "string" ? order.brief.clip_id : "";
    const cut = await adapter.cutShorts(clipId);
    if (cut.kind !== "cut") return move(admin, order.id, "failed", "", { code: "refused", message: "message" in cut ? cut.message : "Shorts could not be cut." });
    return move(admin, order.id, "waiting_order", `Rendering ${cut.shorts.length === 1 ? "1 short" : `${cut.shorts.length} shorts`}`);
  } catch (error) {
    console.error("[studio-orders] order", order.id, error);
    await move(admin, order.id, "failed", "", { code: "studio_error", message: message(error) });
  }
}

/** Generations of the edit still being made: the shots, voice and music `animate_video` queued. */
async function pendingGenerations(supabase: SupabaseClient, clipId: string): Promise<string[]> {
  const { data, error } = await supabase.from("generations").select("id").eq("clip_id", clipId).in("status", ["queued", "running"]);
  if (error) throw new Error(`generations read: ${error.message}`);
  return ((data ?? []) as { id: string }[]).map((g) => g.id);
}

/** Card 2's raw input with one keyframe swapped for its redone generation. */
export function withKeyframe(input: Record<string, unknown> | null, index: number, generationId: string): Record<string, unknown> | null {
  if (!input || !Array.isArray(input.keyframes) || !input.keyframes[index]) return null;
  const keyframes = input.keyframes.map((k, i) => (i === index ? { ...(k as object), generation_id: generationId } : k));
  return { ...input, keyframes };
}

async function runStep(admin: SupabaseClient, step: Step): Promise<void> {
  const { ctx, adapter } = brainStudio(step.user_id, step.order_id);
  const finish = (status: "running" | "done" | "failed", extra: { error?: string; generationId?: string; next?: unknown; waitFor?: string[] } = {}) =>
    rpcOrThrow(ctx.supabase, "studio_step_finish", {
      p_id: step.id,
      p_status: status,
      p_error: extra.error ?? null,
      p_generation_id: extra.generationId ?? null,
      p_next: extra.next ?? null,
      p_wait_for: extra.waitFor ?? null,
    });
  try {
    const redo = step.decision === "redo";
    const index = step.decision_payload?.index ?? 0;
    const decided = await adapter.decide({ stepId: step.id }, redo ? { kind: "redo", index } : { kind: "approve" });
    if (!decided.outcome.ok) {
      await finish("failed", { error: decided.outcome.summary || "The step could not start." });
      return move(admin, step.order_id, "failed", "", { code: "step_failed", message: decided.outcome.summary || "A Studio step could not start." });
    }
    if (redo) {
      // One keyframe again; the new contact sheet (a new card 2) comes when it is made.
      const input = decided.generationId ? withKeyframe(step.plan_input, index, decided.generationId) : null;
      if (!input || !decided.generationId) {
        await finish("failed", { error: "The keyframe could not be made again." });
        return move(admin, step.order_id, "failed", "", { code: "redo_failed", message: "The keyframe could not be made again." });
      }
      await finish("running", { generationId: decided.generationId, next: { tool: "animate_video", input, redoOf: step.id }, waitFor: [decided.generationId] });
      return move(admin, step.order_id, "waiting_order", `Making keyframe ${index + 1} again`);
    }
    if (decided.next) {
      await finish(decided.next.waitFor.length ? "running" : "done", { generationId: decided.generationId, next: decided.next, waitFor: decided.next.waitFor });
      return move(admin, step.order_id, "waiting_order", "Making the keyframes");
    }
    if (step.tool === "animate_video") {
      const waitFor = await pendingGenerations(ctx.supabase, step.clip_id);
      await finish(waitFor.length ? "running" : "done", { generationId: decided.generationId, next: { tool: "render" }, waitFor });
      return move(admin, step.order_id, "waiting_order", "Making the shots, voice-over and music");
    }
    // Nothing follows this step (a long take's step always has a next): the order would wait on nothing.
    await finish("failed", { error: "The step finished without its next step." });
    return move(admin, step.order_id, "failed", "", { code: "no_next_step", message: "Studio could not continue this video." });
  } catch (error) {
    console.error("[studio-orders] step", step.id, error);
    await finish("failed", { error: message(error) }).catch(() => undefined);
    await move(admin, step.order_id, "failed", "", { code: "studio_error", message: message(error) });
  }
}

async function runNext(admin: SupabaseClient, step: Step): Promise<void> {
  const { ctx, adapter } = brainStudio(step.user_id, step.order_id);
  try {
    if (step.wait_for.length) {
      const { data, error } = await ctx.supabase.from("generations").select("id, status, error").in("id", step.wait_for);
      if (error) throw new Error(`generations read: ${error.message}`);
      const rows = (data ?? []) as { id: string; status: string; error: string | null }[];
      // A generation the read did not return (deleted, not ours) counts as failed, never as done.
      const failed = step.wait_for.filter((id) => rows.find((g) => g.id === id)?.status !== "done");
      if (failed.length) {
        return move(admin, step.order_id, "failed", "", {
          code: "generation_failed",
          message: failed.length === 1 ? "A generation failed; its credits were refunded." : `${failed.length} generations failed; their credits were refunded.`,
        });
      }
    }
    const next = step.next!;
    if (next.tool === "replan") {
      // "Edit a beat" on card 1: the storyboard again with the founder's words (a finished plan, no Director).
      const planned = await adapter.plan(step.clip_id, "create_video", null, { store: true, editOf: step.id });
      if (planned.kind === "short") return move(admin, step.order_id, "failed", "", { code: "needs_credits", message: planned.message });
      if (planned.kind === "invalid") return move(admin, step.order_id, "failed", "", { code: "invalid_step", message: planned.message });
      return move(admin, step.order_id, "waiting_founder", "The edited storyboard waits on you");
    }
    if (next.tool === "render") {
      // What the open editor would have done when the voice arrived: captions and the squad's words.
      const finished = await finishVideo(ctx, step.clip_id);
      if (finished.waiting) console.warn(`[studio-orders] ${finished.waiting} voice-over(s) of ${step.clip_id} found no finished voice; rendering without their captions`);
      await renderEdit(ctx, step.clip_id);
      return move(admin, step.order_id, "waiting_order", "Rendering the video");
    }
    const planned = await adapter.plan(step.clip_id, next.tool, next.input, { store: true, ...(next.redoOf ? { redoOf: next.redoOf } : {}) });
    if (planned.kind === "short") return move(admin, step.order_id, "failed", "", { code: "needs_credits", message: planned.message });
    if (planned.kind === "invalid") return move(admin, step.order_id, "failed", "", { code: "invalid_step", message: planned.message });
    if (planned.stepId && next.input && typeof next.input === "object") {
      await rpcOrThrow(admin, "studio_step_plan_input", { p_id: planned.stepId, p_input: next.input });
    }
    return move(admin, step.order_id, "waiting_founder", "The contact sheet and video price wait on you");
  } catch (error) {
    console.error("[studio-orders] next", step.id, error);
    await move(admin, step.order_id, "failed", "", { code: "studio_error", message: message(error) });
  }
}

/** Carries out what is due, until nothing is or the time is up. */
export async function drainStudioOrders(admin: SupabaseClient, opts: { budgetMs?: number } = {}): Promise<number> {
  const deadline = Date.now() + (opts.budgetMs ?? 240_000);
  let done = 0;
  while (Date.now() < deadline) {
    const orders = (await rpcOrThrow<Order[]>(admin, "studio_orders_claim", { p_order: null, p_limit: 3 })) ?? [];
    for (const order of orders) await runOrder(admin, order);
    const steps = (await rpcOrThrow<Step[]>(admin, "studio_steps_claim", { p_limit: 5 })) ?? [];
    for (const step of steps) await runStep(admin, step);
    const ready = (await rpcOrThrow<Step[]>(admin, "studio_steps_ready", { p_limit: 5 })) ?? [];
    for (const step of ready) await runNext(admin, step);
    // P6 S4: a render the look check sent back gets its one redo (or its card, when nothing can be redone).
    const sentBack = await runLookSendBacks(admin, (userId, orderId) => brainStudio(userId, orderId ?? "").ctx).catch((error: unknown) => {
      console.error("[studio-orders] look send-backs", error);
      return 0;
    });
    const n = orders.length + steps.length + ready.length + sentBack;
    if (!n) break;
    done += n;
  }
  return done;
}

/** Runs the Studio queue after the response is sent (the approvals route, the internal run route). */
export function kickStudioOrders(budgetMs = 250_000): void {
  after(async () => {
    try {
      await drainStudioOrders(createAdminClient(), { budgetMs });
    } catch (error) {
      console.error("[studio-orders] drain", error);
    }
  });
}
