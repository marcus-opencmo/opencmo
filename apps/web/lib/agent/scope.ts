/**
 * The scope of an Assistant session: CLIP (the editor) or CMO (the CMO chat).
 *
 * The loop does not know which one it runs: the scope gives it the tools, the system prompt, the
 * state appended after writes, and how each tool call is handled — run now, wait for the browser
 * (`capture_frames`), or wait for the user to approve (priced tools).
 */

import { activeScene, frameAspect, MASTER_SRC, planVoiceover, quoteRange, readBrand, speechSources, summarizeProject } from "@opencmo/editor-core";
import type { ClipDocument } from "@opencmo/clip-doc";

import type { ClipContext } from "@/lib/api/clips";
import { saveDocument } from "@/lib/editor/document";
import { ensureProject, startsEmpty } from "@/lib/editor/project";
import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import { resolveMediaRefs } from "@/lib/generate/create";
import { previewAssets } from "@/lib/motion/assets";
import { previewMotion } from "@/lib/motion/preview";
import { moderateText, specText } from "@/lib/generate/moderation";
import { skillIndex as cmoSkillIndex } from "@/lib/cmo/skills";
import { ScBudget } from "@/lib/cmo/social/scrapecreators";
import type { LlmUsage } from "@/lib/cmo/jobs/llm";

import { RESEARCH_CALLS_PER_TURN, RESEARCH_TOOLS, runResearchTool } from "./cmo-research";
import { CMO_TOOL_SPECS, cmoContext, cmoState, isCmoWrite, runCmoTool, type CmoTurn } from "./cmo-tools";
import { CMO_SYSTEM_PROMPT, SYSTEM_PROMPT, projectStateBlock } from "./prompt";
import type { ToolCall } from "./providers/types";
import { runSkillTool, SKILL_SPECS, SKILL_TOOLS, skillIndex } from "./skills";
import { styleIndex } from "./styles";
import { CAPTURE_TOOLS, captureToolSpecs, runCaptureTool } from "./capture-tool";
import { clipContextBlock, type ClipAbout } from "./clip-context";
import { dbWorkspace, type CheckpointHooks } from "./db-workspace";
import { libraryVideos, transcribing } from "./speech";
import {
  generateCard,
  generateToolSpec,
  prepareGeneration,
  prepareVoiceover,
  runGeneration,
  voiceoverToolSpec,
  type PreparedGeneration,
} from "./generate-tool";
import { addExplainerInput, explainerCard, explainerText, explainerToolSpecs, MOTION_TEMPLATE_TOOLS, prepareExplainer, runMotionTemplateTool, runPreviewExplainer } from "./explainer-tool";
import { EXPORT_TOOL, exportCard, prepareExport, runExport, type PreparedExport } from "./export-tool";
import { runTurnTool, TURN_TOOL_SPECS, TURN_TOOLS } from "./turn-tools";
import { runWaitForMedia, WAIT_TOOL_SPEC } from "./wait-tool";
import { BRAND_TOOL_SPEC, CAPTION_TOOL_SPECS, CAPTION_TOOLS, captionsCard, prepareCaptions, runBrandTool, runCaptions, type PreparedCaptions } from "./captions-tool";
import { backgroundToolSpec, prepareBackground } from "./background-tool";
import { editToolSpec, prepareEdit } from "./edit-tool";
import { createVideoToolSpec, GENERATION_ACTIVE_LIMIT, prepareCreateVideo, videoPieces } from "./create-video";
import { saveKeyframes } from "./keyframe-library";
import {
  animateVideoToolSpec,
  keyframeReader,
  prepareAnimateVideo,
  prepareRedoKeyframe,
  redoKeyframeToolSpec,
  redoSheetKeyframe,
  runRedoKeyframe,
  type ListKeyframe,
  type ContactSheet,
  type PreparedAnimate,
  type PreparedRedo,
} from "./long-take";
import type { Ledger } from "./ledger";
import { turnStatus } from "./loop";
import { screenPieces } from "./screen-pieces";
import { PLAN_VIDEO_TOOL, prepareVideo, type PreparedVideo, type VideoCard } from "./video-team";
import { BROWSER_INPUTS, OWN_VIDEO_TOOLS, TOOL_SPECS, applyOpTool, askInput, isWriteTool, runCheck, runTool, type ToolOutcome, type ToolSpec } from "./tools";

/**
 * Kiểm lời của lượt sinh LÚC BÁO GIÁ: lời bị chặn thì không hiện thẻ duyệt cho
 * một thứ chắc chắn bị từ chối. `createGeneration` vẫn kiểm lại lúc chạy.
 */
async function screen(prepared: PreparedGeneration): Promise<Plan | null> {
  try {
    // Each model kind has its own policy, so each spec is judged on its own (variants share the prompt).
    await Promise.all(
      [{ model: prepared.model, spec: prepared.spec }, ...(prepared.extra ?? [])].map((item) =>
        moderateText(specText(item.spec).join("\n"), { kind: item.model.kind }),
      ),
    );
    return null;
  } catch (err) {
    const message = err instanceof ApiError ? err.message : "Could not check this request. Please try again.";
    return { kind: "invalid", content: JSON.stringify({ INVALID_INPUT: message }), summary: message };
  }
}

/** Tool tốn credit: đi qua thẻ duyệt giá rồi `runGeneration`. */
const PRICED_TOOLS = new Set(["generate_media", "add_voiceover", "replace_background", "create_video", "edit_video", "add_explainer", "animate_video"]);

/** Tool call sau khi phạm vi xem xét nó. */
export type Plan =
  | { kind: "run" }
  | { kind: "browser"; input: unknown }
  | {
      kind: "approval";
      input: unknown;
      card: (ReturnType<typeof generateCard> & { sheet?: ContactSheet }) | Awaited<ReturnType<typeof exportCard>> | VideoCard | ReturnType<typeof explainerCard>;
    }
  | { kind: "input"; input: unknown; card: QuestionCard }
  | { kind: "invalid"; content: string; summary: string };

/** Thẻ câu hỏi của `ask_user`, vẽ ở panel như AskUserQuestion của DS. */
export type QuestionCard = { question: string; options: string[]; multi: boolean };

/** Kết quả của một tool đã được duyệt/từ chối. `extra` lưu vào `agent_tool_calls.result`. */
export type Approved = { outcome: ToolOutcome; extra: Record<string, unknown>; wrote: boolean };

export interface Scope {
  kind: "clip" | "cmo";
  tools: ToolSpec[];
  system: string;
  /** Khối `<project_state>` nối sau câu lệnh và sau lượt ghi. */
  state(): Promise<string>;
  /** Nội dung clip (`<clip_context>`) — chỉ gắn vào câu lệnh đầu mỗi yêu cầu. */
  context?(): Promise<string>;
  plan(call: ToolCall): Promise<Plan>;
  run(call: ToolCall): Promise<ToolOutcome>;
  /** `redo`: the user redid one keyframe on `animate_video`'s contact sheet instead of approving it. */
  decide(call: ToolCall, input: unknown, approved: boolean, redo?: { index: number }): Promise<Approved>;
  isWrite(name: string): boolean;
}

type Turn = { id: string; prompt: string };

/** Checkpoint `agent` cho lượt ghi ĐẦU TIÊN của lượt; lượt đánh dấu "có ghi". */
function checkpointing(supabase: SupabaseClient, turn: Turn, already: boolean) {
  let taken = already;
  return {
    label: `Before assistant: ${turn.prompt}`.slice(0, 200),
    taken: () => taken,
    mark: async (revisionId: string) => {
      if (taken) return;
      taken = true;
      await rpcOrThrow(supabase, "agent_set_checkpoint", { p_turn_id: turn.id, p_revision_id: revisionId });
    },
  };
}

/** The clip scope's tools. New tools go at the END: tool order is the start of the prompt cache. */
export function clipToolSpecs(options: { blank?: boolean } = {}): ToolSpec[] {
  const priced = [generateToolSpec(), voiceoverToolSpec()].filter((spec) => spec !== null);
  const background = backgroundToolSpec();
  const video = createVideoToolSpec();
  const editTool = editToolSpec();
  const longTake = [animateVideoToolSpec(), redoKeyframeToolSpec()].filter((spec) => spec !== null);
  const base = options.blank ? TOOL_SPECS.filter((spec) => !OWN_VIDEO_TOOLS.has(spec.name)) : TOOL_SPECS;
  return [...base, ...priced, EXPORT_TOOL, ...SKILL_SPECS, ...TURN_TOOL_SPECS, ...CAPTION_TOOL_SPECS, BRAND_TOOL_SPEC, PLAN_VIDEO_TOOL, ...(background ? [background] : []), ...(video ? [video] : []), ...(editTool ? [editTool] : []), WAIT_TOOL_SPEC, ...explainerToolSpecs(), ...captureToolSpecs(), ...longTake];
}

/**
 * What a clip session needs from whoever drives it. The Assistant ties all of it to its turn
 * (`agent_turns`); the MCP server has no turn, so it brings its own (`packages/mcp-server`).
 */
export type ClipHost = {
  /** The checkpoint taken before the first write of the request, and where it is recorded. */
  checkpoint: CheckpointHooks;
  /** Charges the model calls of the video team (plan_video, create_video) to the request. */
  recordUsage: (usage: LlmUsage) => Promise<void>;
  /** Scene code previewed in this request: add_explainer only takes code that was looked at. */
  previewed: () => Promise<string[]>;
  /** False once the request is cancelled: a generation stops before it spends credits. */
  alive?: () => Promise<boolean>;
  /** The Assistant turn, for undo, read when the tool runs; absent over MCP, where undo is not offered. */
  readonly turnId?: string;
};

export async function clipScope(
  supabase: SupabaseClient,
  context: ClipContext,
  clipId: string,
  turn: Turn,
  checkpointed: boolean,
  ledger: Ledger,
): Promise<Scope> {
  const checkpoint = checkpointing(supabase, turn, checkpointed);
  return clipScopeWith(supabase, context, clipId, {
    checkpoint: {
      take: () => (checkpoint.taken() ? null : { kind: "agent" as const, label: checkpoint.label }),
      mark: checkpoint.mark,
    },
    recordUsage: async (usage) => {
      await ledger<number>("agent_record_usage", {
        p_turn_id: turn.id,
        p_model: usage.model,
        p_input: usage.input,
        p_output: usage.output,
        p_cache_read: usage.cacheRead,
        p_cache_write: usage.cacheWrite,
      });
    },
    previewed: async () => {
      const { data } = await supabase
        .from("agent_tool_calls")
        .select("input")
        .eq("turn_id", turn.id)
        .eq("name", "preview_explainer")
        .eq("status", "done")
        .order("created_at", { ascending: false });
      return ((data ?? []) as { input: { code?: unknown } }[]).map((row) => String(row.input?.code ?? ""));
    },
    alive: async () => (await turnStatus(supabase, turn.id))?.status === "running",
    // Read when a tool runs, like the hooks above: `startTurn` builds the scope before the turn
    // exists and fills its id in afterwards.
    get turnId() {
      return turn.id || undefined;
    },
  });
}

/** A blank New edit gets the cut-by-words tools once a video on it has a transcript to cut by. */
export const blankEdit = (context: ClipContext, document: ClipDocument): boolean =>
  startsEmpty(context.clip.kind) && !speechSources(document).length;

export async function clipScopeWith(supabase: SupabaseClient, context: ClipContext, clipId: string, host: ClipHost): Promise<Scope> {
  const workspace = dbWorkspace(supabase, context, clipId, host.checkpoint);
  const env = { workspace };
  /** Finished images in the clip's library (uploads, AI images, saved frames) → their `media` objects, under RLS. */
  const lookupImage = async (paths: readonly string[]): Promise<(string | null)[]> => {
    const snapshot = await workspace.read();
    const assets = ((snapshot.manifest as { assets?: unknown[] } | null)?.assets ?? []) as { path?: string; type?: string; state?: string; cloud?: { mediaId?: string } }[];
    const ids = paths.map((path) => assets.find((item) => item.path === path && item.type === "IMAGE" && !item.state && item.cloud?.mediaId)?.cloud?.mediaId ?? null);
    const resolve = async (id: string | null): Promise<string | null> => {
      if (!id) return null;
      const resolved = (await resolveMediaRefs(supabase, context.clip.job_id, { startImage: id }).catch(() => null)) as { startImage?: string } | null;
      return resolved?.startImage ?? null;
    };
    return Promise.all(ids.map(resolve));
  };
  const start = await workspace.read();
  const blank = blankEdit(context, start.document);
  return {
    kind: "clip",
    tools: clipToolSpecs({ blank }),
    system: SYSTEM_PROMPT,
    async context() {
      const snapshot = await workspace.read();
      const [ctx, about, skills] = await Promise.all([
        workspace.opContext(snapshot.document, snapshot.manifest),
        supabase.from("clips").select("hook, reason").eq("id", clipId).maybeSingle().then(({ data }) => data ?? {}),
        skillIndex(supabase).catch(() => ""),
      ]);
      const pending = await transcribing(libraryVideos(snapshot.document, snapshot.manifest), workspace.transcriptStatus);
      return `${await clipContextBlock(snapshot.document, ctx, about as ClipAbout, pending).catch(() => "")}${styleIndex()}${skills}`;
    },
    async state() {
      // One read serves both the summary and the check.
      const project = await workspace.read();
      const block = projectStateBlock({ version: project.version, ...summarizeProject(project.document) });
      // Lượt tự kiểm (spec agent-editor §3.4): model thấy lỗi mới ngay sau bước ghi.
      const report = await runCheck(workspace, project).catch(() => null);
      return report ? `${block}${checkBlock(report)}` : block;
    },
    async plan(call) {
      if (call.name === "ask_user") {
        const parsed = askInput.safeParse(call.input);
        if (!parsed.success) {
          return { kind: "invalid", content: JSON.stringify({ INVALID_INPUT: parsed.error.issues[0]?.message ?? "Invalid input." }), summary: "Could not ask" };
        }
        return {
          kind: "input",
          input: parsed.data,
          card: { question: parsed.data.question, options: parsed.data.options ?? [], multi: parsed.data.multi ?? false },
        };
      }
      if (CAPTION_TOOLS.has(call.name)) {
        // Báo giá ở đây: thứ người dùng duyệt (file, đoạn, số credit) đúng là thứ sẽ chạy.
        const snapshot = await workspace.read();
        const prepared = await prepareCaptions(supabase, clipId, call.name, call.input, snapshot);
        if (typeof prepared === "string") {
          return { kind: "invalid", content: JSON.stringify({ INVALID_INPUT: prepared }), summary: "Could not prepare the captions" };
        }
        return { kind: "approval", input: prepared, card: captionsCard(prepared, clipId) };
      }
      if (call.name === "plan_video") {
        // The team plans here, before the card: the user approves the exact storyboard that is
        // applied. Its model calls are charged on this turn like the Assistant's own steps.
        const snapshot = await workspace.read();
        const clipContext = await clipContextBlock(snapshot.document, await workspace.opContext(snapshot.document, snapshot.manifest)).catch(() => "");
        const planned = await prepareVideo(call.input, { document: snapshot.document, clipContext }, host.recordUsage);
        if (typeof planned === "string") {
          return { kind: "invalid", content: JSON.stringify({ INVALID_INPUT: planned }), summary: "Could not plan the intro" };
        }
        return { kind: "approval", input: planned.prepared, card: { ...planned.card, clips: [{ id: clipId, label: "This clip" }] } };
      }
      if (call.name === "request_export") {
        const prepared = await prepareExport(supabase, clipId, call.input);
        if (typeof prepared === "string") {
          return { kind: "invalid", content: JSON.stringify({ INVALID_INPUT: prepared }), summary: "Could not prepare the export" };
        }
        return { kind: "approval", input: prepared, card: await exportCard(supabase, clipId, prepared) };
      }
      if (call.name === "generate_media") {
        // Chuẩn bị ở ĐÂY (chọn model, seed, giá) và lưu vào input của tool: thứ
        // người dùng duyệt đúng là thứ sẽ được tạo, không tính lại sau khi bấm.
        // Câu trích phải có thật trong clip: ảnh/video gắn với điều người nói nói.
        const target = await workspace.read().then(({ document }) => {
          const scene = activeScene(document) as unknown as { width: number; height: number };
          return { aspect: frameAspect(Number(scene.width), Number(scene.height)), speaker: JSON.stringify(document).includes(`"${MASTER_SRC}"`) };
        });
        const prepared = await prepareGeneration(
          call.input,
          async (quote) => {
            const snapshot = await workspace.read();
            return quoteRange(snapshot.document, await workspace.opContext(snapshot.document, snapshot.manifest), quote, { min: 1.5, max: 5 });
          },
          lookupImage,
          target,
        );
        if (typeof prepared === "string") {
          return { kind: "invalid", content: JSON.stringify({ INVALID_INPUT: prepared }), summary: "Could not prepare the generation" };
        }
        const blocked = await screen(prepared);
        if (blocked) return blocked;
        return { kind: "approval", input: prepared, card: generateCard(prepared, clipId) };
      }
      if (call.name === "add_explainer") {
        // One check of everything the render shows or says: the script, and the words in the code
        // (the spec only holds the script, so `screen` alone would miss the labels). Before the code
        // is saved, so refused code never lands in `scene_codes`.
        const request = addExplainerInput.safeParse(call.input);
        if (request.success) {
          try {
            await moderateText(explainerText(request.data), { kind: "video" });
          } catch (err) {
            const message = err instanceof ApiError ? err.message : "Could not check this request. Please try again.";
            return { kind: "invalid", content: JSON.stringify({ INVALID_INPUT: message }), summary: message };
          }
        }
        const snapshot = await workspace.read();
        const accent = readBrand(snapshot.document)?.colors.accent;
        const prepared = await prepareExplainer(call.input, {
          // Code previewed in this turn: add_explainer only takes code the model has looked at.
          previewed: host.previewed,
          save: (code) => rpcOrThrow<string>(supabase, "save_scene_code", { p_code: code }),
          lookupImage,
          ...(accent ? { accent } : {}),
        });
        if (typeof prepared === "string") {
          return { kind: "invalid", content: JSON.stringify({ INVALID_INPUT: prepared }), summary: "Could not prepare the explainer" };
        }
        return { kind: "approval", input: prepared, card: explainerCard(prepared, clipId) };
      }
      if (call.name === "create_video") {
        // The director plans here, before the card; its model calls are charged on this turn.
        const snapshot = await workspace.read();
        const planned = await prepareCreateVideo(call.input, { document: snapshot.document }, host.recordUsage);
        if (typeof planned === "string") {
          return { kind: "invalid", content: JSON.stringify({ INVALID_INPUT: planned }), summary: "Could not plan the video" };
        }
        // Every piece starts on Approve: check the in-flight cap now, not after the user has approved.
        const needed = 1 + (planned.prepared.extra?.length ?? 0);
        const { count: running } = await supabase.from("generations").select("id", { count: "exact", head: true }).in("status", ["queued", "running"]);
        if ((running ?? 0) + needed > GENERATION_ACTIVE_LIMIT) {
          const message = `This video needs ${needed} generations at once and ${running} are still running. Wait for them to finish, or ask for a shorter video.`;
          return { kind: "invalid", content: JSON.stringify({ INVALID_INPUT: message }), summary: "Too many generations running" };
        }
        const blocked = await screenPieces(videoPieces(planned));
        if (blocked) return { kind: "invalid", ...blocked };
        return { kind: "approval", input: planned.prepared, card: { ...generateCard(planned.prepared, clipId), storyboard: planned.storyboard } };
      }
      if (call.name === "animate_video") {
        const snapshot = await workspace.read();
        const planned = await prepareAnimateVideo(call.input, {
          document: snapshot.document,
          readKeyframes: keyframeReader(supabase, context.clip.job_id),
          sign: async (paths) => {
            const { data } = await supabase.storage.from("media").createSignedUrls(paths, SHEET_URL_SECONDS);
            return paths.map((_path, index) => data?.[index]?.signedUrl ?? null);
          },
        });
        if (typeof planned === "string") {
          return { kind: "invalid", content: JSON.stringify({ INVALID_INPUT: planned }), summary: "Could not prepare the video" };
        }
        const needed = 1 + (planned.prepared.extra?.length ?? 0);
        const { count: running } = await supabase.from("generations").select("id", { count: "exact", head: true }).in("status", ["queued", "running"]);
        if ((running ?? 0) + needed > GENERATION_ACTIVE_LIMIT) {
          const message = `This video needs ${needed} generations at once and ${running} are still running. Wait for them to finish, then call animate_video again.`;
          return { kind: "invalid", content: JSON.stringify({ INVALID_INPUT: message }), summary: "Too many generations running" };
        }
        const blocked = await screenPieces(planned.pieces, "animate_video");
        if (blocked) return { kind: "invalid", ...blocked };
        return { kind: "approval", input: planned.prepared, card: { ...generateCard(planned.prepared, clipId), sheet: planned.sheet } };
      }
      if (call.name === "redo_keyframe") {
        const snapshot = await workspace.read();
        const prepared = prepareRedoKeyframe(call.input, snapshot.document);
        if (typeof prepared === "string") {
          return { kind: "invalid", content: JSON.stringify({ INVALID_INPUT: prepared }), summary: "Could not redo the keyframe" };
        }
        const blocked = await screenPieces([{ label: "The new keyframe", spec: prepared.image.spec, kind: "image" }], "redo_keyframe");
        if (blocked) return { kind: "invalid", ...blocked };
        return { kind: "approval", input: prepared, card: { clips: [{ id: clipId, label: "This clip" }], changes: prepared.lines, credits: prepared.credits } };
      }
      if (call.name === "replace_background") {
        const snapshot = await workspace.read();
        const prepared = prepareBackground(call.input, snapshot.document, await workspace.opContext(snapshot.document, snapshot.manifest));
        if (typeof prepared === "string") {
          return { kind: "invalid", content: JSON.stringify({ INVALID_INPUT: prepared }), summary: "Could not prepare the new background" };
        }
        const blocked = await screen(prepared);
        if (blocked) return blocked;
        return { kind: "approval", input: prepared, card: generateCard(prepared, clipId) };
      }
      if (call.name === "edit_video") {
        const snapshot = await workspace.read();
        const prepared = prepareEdit(call.input, snapshot.document, await workspace.opContext(snapshot.document, snapshot.manifest));
        if (typeof prepared === "string") {
          return { kind: "invalid", content: JSON.stringify({ INVALID_INPUT: prepared }), summary: "Could not prepare the video edit" };
        }
        const blocked = await screen(prepared);
        if (blocked) return blocked;
        return { kind: "approval", input: prepared, card: generateCard(prepared, clipId) };
      }
      if (call.name === "add_voiceover") {
        const prepared = await prepareVoiceover(call.input, async (input) => {
          const snapshot = await workspace.read();
          return planVoiceover(snapshot.document, input, await workspace.opContext(snapshot.document, snapshot.manifest));
        });
        if (typeof prepared === "string") {
          return { kind: "invalid", content: JSON.stringify({ INVALID_INPUT: prepared }), summary: "Could not prepare the voiceover" };
        }
        const blocked = await screen(prepared);
        if (blocked) return blocked;
        return { kind: "approval", input: prepared, card: generateCard(prepared, clipId) };
      }
      const schema = BROWSER_INPUTS[call.name];
      if (!schema) return { kind: "run" };
      const parsed = schema.safeParse(call.input);
      if (parsed.success) return { kind: "browser", input: parsed.data };
      return {
        kind: "invalid",
        content: JSON.stringify({ INVALID_INPUT: parsed.error.issues[0]?.message ?? "Invalid input." }),
        summary: "Invalid request to the editor",
      };
    },
    run: (call) =>
      call.name === "apply_brand_kit"
        ? runBrandTool(supabase, call.input, (op) => applyOpTool(op as never, env))
        : SKILL_TOOLS.has(call.name)
          ? runSkillTool(supabase, call)
          : CAPTURE_TOOLS.has(call.name)
            ? runCaptureTool(supabase, call)
            : TURN_TOOLS.has(call.name)
              ? runTurnTool(call.name, call.input, { supabase, clipId, ...(host.turnId ? { turnId: host.turnId } : {}) })
              : call.name === WAIT_TOOL_SPEC.name
                ? runWaitForMedia(call.input, { supabase, clipId })
                : MOTION_TEMPLATE_TOOLS.has(call.name)
                  ? Promise.resolve(runMotionTemplateTool(call.name, call.input))
                  : call.name === "preview_explainer"
                  ? workspace.read().then(({ document }) => {
                      const accent = readBrand(document)?.colors.accent;
                      return runPreviewExplainer(call.input, {
                        preview: previewMotion,
                        lookupImage,
                        signAssets: (refs) => previewAssets(supabase, refs),
                        ...(accent ? { accent } : {}),
                      });
                    })
                  : runTool(call.name, call.input, env),
    async decide(call, input, approved, redo) {
      // Where a long take's keyframes are listed: the project as it is now, saved with its manifest.
      const keyframeStore = {
        read: () => ensureProject(supabase, context, clipId),
        write: async (version: number, document: ClipDocument, manifest: unknown) => {
          await saveDocument(supabase, clipId, version, document, { manifest });
        },
      };
      const listKeyframe: ListKeyframe = (entry, id) =>
        saveKeyframes(keyframeStore, { model: entry.model, specs: [entry.spec], folder: entry.folder, names: [entry.name], ids: [id] });
      if (call.name === "animate_video" && !approved && redo) {
        const outcome = await redoSheetKeyframe({ supabase, jobId: context.clip.job_id, clipId, addToLibrary: listKeyframe }, input as PreparedAnimate, redo.index);
        return { outcome, extra: {}, wrote: false };
      }
      if (call.name === "redo_keyframe") {
        if (!approved) {
          return {
            outcome: { ok: false, content: JSON.stringify({ declined: true, message: "The user declined. The keyframe and its shots are unchanged; no credits were spent." }), summary: "Declined" },
            extra: {},
            wrote: false,
          };
        }
        const { outcome, generationId } = await runRedoKeyframe(
          {
            supabase,
            jobId: context.clip.job_id,
            clipId,
            applyOp: (op) => applyOpTool(op, env),
            ...(host.alive ? { alive: host.alive } : {}),
            addToLibrary: listKeyframe,
          },
          input as PreparedRedo,
        );
        return { outcome, extra: generationId ? { generation_id: generationId } : {}, wrote: outcome.ok && outcome.version !== undefined };
      }
      if (call.name === "plan_video") {
        if (!approved) {
          return {
            outcome: { ok: false, content: JSON.stringify({ declined: true, message: "The user declined the storyboard. Nothing was added." }), summary: "Declined" },
            extra: {},
            wrote: false,
          };
        }
        const prepared = input as PreparedVideo;
        const outcome = await applyOpTool(prepared.op as never, env);
        return { outcome, extra: {}, wrote: outcome.ok && outcome.version !== undefined };
      }
      if (call.name === "request_export") {
        if (!approved) {
          return {
            outcome: { ok: false, content: JSON.stringify({ declined: true, message: "The user declined the export. Nothing was rendered." }), summary: "Declined" },
            extra: {},
            wrote: false,
          };
        }
        const outcome = await runExport({ supabase, context, clipId }, input as PreparedExport);
        // `view` lưu cùng kết quả: tải lại trang vẫn còn nút Download.
        return { outcome, extra: outcome.view ? { view: outcome.view } : {}, wrote: false };
      }
      if (CAPTION_TOOLS.has(call.name)) {
        if (!approved) {
          return {
            outcome: { ok: false, content: JSON.stringify({ declined: true, message: "The user declined. No credits were spent." }), summary: "Declined" },
            extra: {},
            wrote: false,
          };
        }
        const outcome = await runCaptions(supabase, clipId, input as PreparedCaptions, (op) => applyOpTool(op, env));
        return { outcome, extra: {}, wrote: outcome.ok && outcome.version !== undefined };
      }
      if (!PRICED_TOOLS.has(call.name)) throw new Error(`Clip scope has no approval tool ${call.name}.`);
      const prepared = input as PreparedGeneration;
      if (!approved) {
        return {
          outcome: { ok: false, content: JSON.stringify({ declined: true, message: "The user declined this generation. No credits were spent." }), summary: "Declined" },
          extra: {},
          wrote: false,
        };
      }
      const { outcome, generationId } = await runGeneration(
        {
          supabase,
          jobId: context.clip.job_id,
          clipId,
          applyOp: (op) => applyOpTool(op, env),
          ...(host.alive ? { alive: host.alive } : {}),
          addToLibrary: (done, ids) =>
            saveKeyframes(keyframeStore, { model: done.model, specs: [done.spec, ...(done.extra ?? []).map((item) => item.spec)], folder: done.library!.folder, names: done.library!.names, ids }),
        },
        prepared as Parameters<typeof runGeneration>[1],
      );
      return { outcome, extra: generationId ? { generation_id: generationId } : {}, wrote: outcome.ok && outcome.version !== undefined };
    },
    isWrite: (name) => name === "undo" || name === "apply_brand_kit" || name === "plan_video" || CAPTION_TOOLS.has(name) || isWriteTool(name),
  };
}

/** Contact-sheet pictures stay viewable while the card waits, and a little after. */
const SHEET_URL_SECONDS = 6 * 60 * 60;

/** Kết quả `check` nối sau `<project_state>`: chỉ khi có issue, để tin nhắn gọn. */
function checkBlock(report: Awaited<ReturnType<typeof runCheck>>): string {
  if (!report.issues.length) return "<check>ok</check>";
  return `<check>${JSON.stringify({ ok: report.ok, issues: report.issues.slice(0, 20) })}</check>`;
}

/**
 * Phạm vi CMO chat: không clip, không project, không checkpoint. Tool chỉ đọc (tài liệu, lịch,
 * mạng xã hội qua ScrapeCreators) hoặc giao việc (`create_task`); không có thẻ duyệt vì không tool
 * nào tốn tiền ngoài credit của việc được giao, và không tool nào đăng gì. Ngân sách lời gọi
 * research tính theo YÊU CẦU (scope dựng lại mỗi lượt).
 */
/** The `cmo_read_hit` bucket a CMO chat tool counts against: social reads, website reads, the credit balance. */
export function chatReadBucket(name: string): "chat_social" | "chat_site" | "research_credits" | null {
  if (name === "read_site") return "chat_site";
  if (name === "research_credits") return "research_credits";
  return RESEARCH_TOOLS.has(name) ? "chat_social" : null;
}

export function cmoScope(supabase: SupabaseClient): Scope {
  const budget = new ScBudget(RESEARCH_CALLS_PER_TURN);
  const turn: CmoTurn = { siteReads: 0 };
  return {
    kind: "cmo",
    tools: CMO_TOOL_SPECS,
    system: `${CMO_SYSTEM_PROMPT}\n\nYour playbooks and marketing library (read one with read_skill before planning research, writing a brief or advising on strategy, and no-ai-slop before writing any text that goes out):\n${cmoSkillIndex("cmo")}`,
    context: () => cmoContext(supabase),
    state: () => cmoState(supabase),
    async plan() {
      return { kind: "run" };
    },
    async run(call) {
      // The in-memory caps above start again on every request (each continue rebuilds the scope); the founder's
      // counters in SQL do not, and the daily cap is shared with MCP (review R4).
      const bucket = chatReadBucket(call.name);
      if (bucket) {
        const { data: allowed, error } = await supabase.rpc("cmo_read_hit", { p_bucket: bucket });
        if (error || !allowed) {
          const message = error
            ? "Could not check the research limit. Try again in a minute."
            : "The research limit for now is reached. Work with what you have read, or try again later.";
          return { ok: false, content: JSON.stringify({ error: message }), summary: "Research limit reached" };
        }
      }
      return RESEARCH_TOOLS.has(call.name) ? runResearchTool(call.name, call.input, budget) : runCmoTool(supabase, call.name, call.input, turn);
    },
    async decide(call) {
      throw new Error(`CMO scope has no approval tool ${call.name}.`);
    },
    isWrite: isCmoWrite,
  };
}
