/**
 * The Studio adapter (P2 B1): `plan` and `decide`, extracted from MCP's studio group so the brain, MCP
 * and the founder's buttons run a priced Studio step the same way. `plan` prices it in the Assistant's
 * clip scope (`scope.plan`: model, seed, price, storyboard; nothing spent); `decide` runs it there
 * (`scope.decide`) once a card or a signed confirm code approves it.
 */

import { randomUUID } from "node:crypto";

import type { LongTakePlan } from "@opencmo/editor-core";

import { ApiError } from "@/lib/api/errors";
import { mediaCreditsShort } from "@/lib/cmo/mcp/account";

import { markFinished, orderShorts } from "./finished";
import { renderShort } from "./render";
import { buildPostImage } from "./slideshow/post-image";
import { buildSlideshow } from "./slideshow/build";
import { cutShorts } from "./shorts/cut";
import { raiseStep } from "./steps";
import { buildVideo } from "./video";
import { studioSession, type SessionOptions } from "./session";
import { mayCall, type PreparedStep, type StepRef, type StudioAction, type StudioAdapter, type StudioContext, type StudioDecision, type StudioEntry, type StudioPlan, type PlanOptions } from "./types";

export class StudioAccessError extends Error {}

function allow(ctx: StudioContext, entry: StudioEntry) {
  if (!mayCall(ctx.caller, entry)) throw new StudioAccessError(`Studio ${entry} is not open to the ${ctx.caller}.`);
}

/** The reason a plan was refused, without the JSON wrapping the model reads. */
export function problem(content: string): string {
  try {
    const value = JSON.parse(content) as { INVALID_INPUT?: unknown; error?: unknown };
    return String(value.INVALID_INPUT ?? value.error ?? content);
  } catch {
    return content;
  }
}

/** A stored step under RLS: only the founder's own row, only while a decision can still run it. */
async function storedStep(ctx: StudioContext, stepId: string): Promise<PreparedStep> {
  const { data, error } = await ctx.supabase.from("studio_steps").select("clip_id, tool, input, status").eq("id", stepId).maybeSingle();
  if (error) throw new Error(`studio_steps read: ${error.message}`);
  const row = data as { clip_id: string; tool: string; input: unknown; status: string } | null;
  if (!row) throw new ApiError(404, "This step no longer exists.");
  if (!["waiting", "approved"].includes(row.status)) throw new ApiError(409, "This step was already decided.");
  return { clipId: row.clip_id, tool: row.tool, input: row.input };
}

/**
 * Card 1 sent back with one beat rewritten (`edit {beat, text}`): the same plan with those words,
 * through `create_video` again as a finished plan, so the code Reviewer checks it and no Director runs.
 */
async function editedRequest(ctx: StudioContext, stepId: string): Promise<{ clipId: string; input: unknown; orderId: string | null } | string> {
  const { data, error } = await ctx.supabase.from("studio_steps").select("clip_id, tool, input, decision, decision_payload, order_id").eq("id", stepId).maybeSingle();
  if (error) throw new Error(`studio_steps read: ${error.message}`);
  const row = data as { clip_id: string; tool: string; input: { longTake?: { plan: LongTakePlan; aspect: string; seconds: number; model?: string; voice?: string } }; decision: string | null; decision_payload: { beat?: unknown; text?: unknown } | null; order_id: string | null } | null;
  if (!row) throw new ApiError(404, "This step no longer exists.");
  const longTake = row.input?.longTake;
  if (row.tool !== "create_video" || row.decision !== "edit" || !longTake) return "Only a storyboard sent back with an edited beat is planned again.";
  const beat = Number(row.decision_payload?.beat);
  const text = typeof row.decision_payload?.text === "string" ? row.decision_payload.text.trim() : "";
  if (!Number.isInteger(beat) || beat < 0 || beat >= longTake.plan.shots.length) return "That beat is not in the storyboard.";
  if (!text) return "Write the beat's words, then send it again.";
  const shots = longTake.plan.shots.map((shot, index) => (index === beat ? { ...shot, words: text } : shot));
  // The voice reads the script and each beat shows its words: they stay the same text.
  const plan = { ...longTake.plan, shots, script: shots.map((shot) => shot.words).join(" ") };
  const input = {
    prompt: `${plan.title}: ${plan.script}`.slice(0, 2000),
    seconds: Math.round(longTake.seconds),
    aspect: longTake.aspect,
    ...(longTake.model ? { model: longTake.model } : {}),
    ...(longTake.voice ? { voice: longTake.voice } : {}),
    plan,
  };
  return { clipId: row.clip_id, input, orderId: row.order_id };
}

export function studio(ctx: StudioContext, options: SessionOptions = {}): StudioAdapter {
  const session = (clipId: string) => studioSession(ctx.supabase, ctx.caller, clipId, options);

  async function plan(clipId: string, tool: string, input: unknown, planOptions: PlanOptions = {}): Promise<StudioPlan> {
    allow(ctx, "plan");
    if (planOptions.store && ctx.caller !== "brain") throw new StudioAccessError(`Only the brain stores Studio steps, not the ${ctx.caller}.`);
    if (planOptions.editOf) {
      if (!planOptions.store || tool !== "create_video") throw new ApiError(400, "An edited storyboard is planned again with create_video and stored.");
      const edited = await editedRequest(ctx, planOptions.editOf);
      if (typeof edited === "string") return { kind: "invalid", message: edited };
      return studio({ ...ctx, ...(edited.orderId ? { orderId: edited.orderId } : {}) }, options).plan(edited.clipId, tool, edited.input, { store: true });
    }
    const { scope } = await session(clipId);
    const planned = await scope.plan({ id: randomUUID(), name: tool, input });
    if (planned.kind === "invalid") return { kind: "invalid", message: problem(planned.content) };
    if (planned.kind !== "approval") return { kind: "invalid", message: "This tool could not be priced. Please try again." };
    const card = planned.card as { changes?: string[]; credits?: number; storyboard?: unknown; sheet?: unknown };
    const credits = card.credits ?? 0;
    // Short of credits: say how to top up now, not after the founder agreed to a price they cannot pay.
    const short = credits ? await mediaCreditsShort(ctx.supabase, ctx.userId, credits) : null;
    if (short) return { kind: "short", message: short, credits };
    const priced: StudioPlan = {
      kind: "priced",
      credits,
      lines: card.changes ?? [],
      ...(card.storyboard ? { storyboard: card.storyboard } : {}),
      ...(card.sheet ? { sheet: card.sheet } : {}),
      prepared: { clipId, tool, input: planned.input },
    };
    if (!planOptions.store) return priced;
    return { ...priced, ...(await raiseStep(ctx, priced, planOptions.redoOf ? { redoOf: planOptions.redoOf } : {})) };
  }

  async function decide(step: StepRef, action: StudioAction): Promise<StudioDecision> {
    allow(ctx, "decide");
    const prepared = "prepared" in step ? step.prepared : await storedStep(ctx, step.stepId);
    if (action.kind === "redo" && prepared.tool !== "animate_video") throw new ApiError(400, "Only the contact sheet can redo one keyframe.");
    const { scope } = await session(prepared.clipId);
    const approved = await scope.decide(
      { id: randomUUID(), name: prepared.tool, input: {} },
      prepared.input,
      action.kind === "approve",
      action.kind === "redo" ? { index: action.index } : undefined,
    );
    // A contact-sheet redo reports its new keyframe only in the outcome (the in-app card reads it there).
    const generationId = typeof approved.extra.generation_id === "string" ? approved.extra.generation_id : outcomeGeneration(approved.outcome.content);
    const view = approved.extra.view as { exports?: Record<string, unknown>[] } | undefined;
    const next = action.kind === "approve" && approved.outcome.ok ? nextStep(prepared.tool, approved.outcome.content) : undefined;
    const notes: string[] = [];
    // A brain-made video wears the founder's Brand Kit once it is built; the founder applies their own in the editor.
    if (ctx.caller === "brain" && prepared.tool === "animate_video" && action.kind === "approve" && approved.outcome.ok) {
      const branded = await scope.run({ id: randomUUID(), name: "apply_brand_kit", input: {} });
      if (!branded.ok) notes.push(problem(branded.content));
    }
    return {
      outcome: approved.outcome,
      wrote: approved.wrote,
      ...(generationId ? { generationId } : {}),
      ...(view?.exports ? { exports: view.exports } : {}),
      ...(next ? { next } : {}),
      ...(notes.length ? { notes } : {}),
    };
  }

  const adapter: StudioAdapter = {
    plan,
    decide,
    async buildVideo(brief) {
      allow(ctx, "buildVideo");
      return buildVideo(ctx, adapter, brief);
    },
    async cutShorts(clipId) {
      allow(ctx, "cutShorts");
      return ctx.caller === "ui" ? orderShorts(ctx, clipId) : cutShorts(ctx, clipId, options.recordUsage);
    },
    async markFinished(clipId, hash) {
      allow(ctx, "markFinished");
      return markFinished(ctx, clipId, hash);
    },
    async renderShort(shortClipId) {
      allow(ctx, "renderShort");
      return renderShort(ctx, shortClipId);
    },
    async buildSlideshow(brief) {
      allow(ctx, "buildSlideshow");
      return buildSlideshow(ctx, brief);
    },
    async buildPostImage(brief) {
      allow(ctx, "buildPostImage");
      return buildPostImage(ctx, brief);
    },
  };
  return adapter;
}

function outcomeGeneration(content: string): string | undefined {
  try {
    const value = (JSON.parse(content) as { generation_id?: unknown }).generation_id;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Card 1 approved: once its keyframes are done, card 2 is `animate_video` on what `create_video` returned. */
function nextStep(tool: string, content: string): StudioDecision["next"] {
  if (tool !== "create_video") return undefined;
  try {
    const value = JSON.parse(content) as { result?: { keyframes?: { generation_id: string }[] }; voice?: string };
    if (!value.result) return undefined;
    return {
      tool: "animate_video",
      input: { ...value.result, ...(value.voice ? { voice: value.voice } : {}) },
      waitFor: (value.result.keyframes ?? []).map((keyframe) => keyframe.generation_id),
    };
  } catch {
    return undefined;
  }
}
