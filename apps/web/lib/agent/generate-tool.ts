/**
 * Tool `generate_media` của Assistant trong editor (spec AI Studio P9).
 *
 * Luôn qua THẺ DUYỆT hiện giá: sinh media tốn credit thật, nên model chỉ đề
 * xuất — người dùng thấy loại, prompt, model và số credit rồi mới Approve.
 * Approve thì: tạo generation (cùng `createGeneration` với ô Generate — đặt
 * trước credit + task) → áp op `add_generated` (khai báo `generate.*` đúng
 * spec đó) vào clip. Editor phân giải khai báo, server nhận ra cùng spec và
 * trả lại lượt vừa tạo — không trừ lần hai.
 */

import { randomInt, randomUUID } from "node:crypto";

import { z } from "zod";
import {
  describeOp,
  planStudio3d,
  planVoiceover,
  STUDIO_MODEL,
  studio3dToolInput,
  voiceoverToolInput,
  type Op,
  type Studio3dInput,
  type VoiceoverInput,
} from "@opencmo/editor-core";
import { MAX_CODE_CHARS, THEMES } from "@opencmo/clip-three";
import { priceOf, type AiModel, type GenerationKind, type GenerationSpec } from "@opencmo/editor-core/generate";

import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import { createGeneration, normalizeSpec } from "@/lib/generate/create";
import { briefMisuse, briefShape, composePrompt, type Brief } from "@/lib/generate/brief";
import { availableModels } from "@/lib/generate/models";

import { sanitize, type ToolOutcome, type ToolSpec } from "./tools";

/**
 * Ảnh/video: BRIEF có cấu trúc (câu trích + ý + chủ thể…), server ghép prompt
 * (`lib/generate/brief.ts`). Giọng đọc/âm thanh: `prompt` như cũ (chữ cần đọc,
 * tiếng cần tạo). Object phẳng: JSON schema của tool cần `properties` ở trên cùng.
 */
export const generateInput = z
  .object({
    kind: z.enum(["image", "video", "voice", "audio"]),
    prompt: z.string().trim().min(1).max(5000).optional().describe("voice: the exact words to speak; audio: the sound to make. Not used for image/video."),
    quote: briefShape.quote.optional(),
    idea: briefShape.idea.optional(),
    subject: briefShape.subject.optional(),
    action: briefShape.action,
    setting: briefShape.setting,
    style: briefShape.style,
    camera: briefShape.camera,
    mood: briefShape.mood,
    avoid: briefShape.avoid,
    model: z.string().max(100).optional(),
    aspect_ratio: z.string().max(10).optional(),
    duration: z.number().int().min(1).max(60).optional(),
    voice: z.string().max(100).optional(),
    start: z.number().finite().min(0).optional().describe("Clip seconds. Omit for image/video: it starts on the quote."),
    resolution: z.string().max(20).optional().describe("Video/image resolution, when the model lists resolutions. Higher costs more."),
    start_image: z
      .string()
      .max(500)
      .optional()
      .describe("Video only: library path of an image saved to the cloud (list_library: a finished AI image, an upload, or a frame from save_frame) to use as the first frame."),
    end_image: z.string().max(500).optional().describe("Video only: library path of a saved image to end on (models that support a last frame)."),
    references: z
      .array(z.string().max(500))
      .min(1)
      .max(8)
      .optional()
      .describe(
        "Library paths of saved images the result must follow (a product, a character, a logo the user owns, a style). Only for models that list reference images; refer to them in the brief as image 1, image 2… in the same order.",
      ),
    length: z
      .number()
      .min(0.5)
      .max(60)
      .optional()
      .describe("Image/video: seconds it stays on the clip (B-roll: 1.5-4). A video is still generated and paid for its full duration."),
    muted: z.boolean().optional().describe("Video: mute its own sound (always for B-roll)."),
    fit: z.boolean().optional().describe("Video: speed it up so the WHOLE generated video plays within length — for an AI transition that must reach its end_image."),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "image" || value.kind === "video") {
      for (const key of ["quote", "idea", "subject"] as const) {
        if (!value[key]) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required for an AI ${value.kind}: fill the brief from <clip_context>.` });
      }
    } else if (!value.prompt) {
      ctx.addIssue({ code: "custom", path: ["prompt"], message: value.kind === "voice" ? "prompt: the exact words to speak." : "prompt: the sound to make." });
    }
  });

/** Tool chỉ có khi máy chủ bật ít nhất một model — không mời model gọi thứ luôn hỏng. */
export function generateToolSpec(): ToolSpec | null {
  // Model sửa video cần video nguồn: không thuộc lượt sinh từ brief.
  const models = availableModels().filter((model) => !model.limits.scene && !model.limits.sourceVideo);
  if (!models.length) return null;
  const listing = models
    .map((model) => {
      const refs = model.limits.maxReferences ? `; up to ${model.limits.maxReferences} reference images` : "";
      const extra = (model.limits.voices ? `; voices: ${model.limits.voices.join(", ")}` : "") + refs;
      const ratios = model.limits.aspectRatios ? `; aspect ratios: ${model.limits.aspectRatios.join(", ")}` : "";
      const durations = model.limits.durations ? `; durations: ${model.limits.durations.join(", ")}s` : "";
      return `${model.id} (${model.kind}${ratios}${durations}${extra})`;
    })
    .join("; ");
  return {
    name: "generate_media",
    description:
      `Create new media with AI and place it on the clip: an image or a short video of a concrete real-world scene, a voice-over (kind "voice", prompt = the exact text to speak) or a sound effect (kind "audio", prompt = the sound). It costs credits, so the user sees the price and must approve before anything is created. Only use it when the user asks for new media. For image/video fill the brief from <clip_context> (read_guide "script"): quote = the words it illustrates (it starts when they are spoken), idea, subject, action, setting, style, camera, mood, avoid; the server writes the final prompt. Never use it for diagrams, charts, numbers, text or "3D explanations": draw those with add_diagram/add_chart/add_graph, or write a 3D animation (add_3d_scene). The result appears on the clip when it is ready (seconds for images and voice, minutes for video). Available models: ${listing}.`,
    schema: sanitize(z.toJSONSchema(generateInput, { io: "input" })).schema as Record<string, unknown>,
    strict: true,
    approval: true,
  };
}

export type PreparedGeneration = {
  model: AiModel;
  spec: GenerationSpec;
  op: Op;
  credits: number;
  /** Câu người nói mà ảnh/video minh hoạ — hiện trên thẻ duyệt. */
  quote?: string;
};

/** Tìm mốc CLIP của câu trích; ném lỗi đọc được khi không có trong clip. */
export type LocateQuote = (quote: string) => Promise<{ start: number; end: number }>;

const NOUN: Record<GenerationKind, string> = { image: "image", video: "video", voice: "voice-over", audio: "sound effect" };

/**
 * Chọn model + kiểm brief + ghép prompt + chuẩn hoá spec + tính giá. Chuỗi =
 * lỗi đọc được cho model. `locate` tìm câu trích trong transcript clip.
 */
/** Đường dẫn thư viện của một ảnh AI đã xong → tên object media (null = không dùng được). */
export type LookupImage = (path: string) => Promise<string | null>;

export async function prepareGeneration(input: unknown, locate?: LocateQuote, lookupImage?: LookupImage): Promise<PreparedGeneration | string> {
  const parsed = generateInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "Invalid input."}`;
  }
  const request = parsed.data;
  // Model 3D Studio cần dữ liệu cảnh — chỉ đi qua tool `add_3d_studio`.
  const models = availableModels().filter((model) => model.kind === request.kind && !model.limits.scene && !model.limits.sourceVideo);
  const model = request.model ? models.find((candidate) => candidate.id === request.model) : models[0];
  if (!model) {
    return request.model
      ? `Model "${request.model}" is not available for ${NOUN[request.kind]}s.`
      : `Creating ${NOUN[request.kind]}s is not available.`;
  }

  // Clip của OpenCMO là khung dọc: mặc định 9:16 khi model nhận.
  const ratios = model.limits.aspectRatios ?? [];
  const aspectRatio = request.aspect_ratio ?? (ratios.includes("9:16") ? "9:16" : ratios[0]);
  const seed = randomInt(0, 2_147_483_647);
  let prompt = request.prompt ?? "";
  let start = request.start;
  if (request.kind === "image" || request.kind === "video") {
    const brief = request as Brief & typeof request;
    const misuse = briefMisuse(brief);
    if (misuse) return misuse;
    if (locate) {
      try {
        const found = await locate(brief.quote);
        start ??= found.start;
      } catch (err) {
        return (err as Error).message;
      }
    }
    prompt = composePrompt(brief, request.kind, {
      maxChars: model.limits.maxPromptChars ?? 2000,
      aspectRatio,
      duration: request.kind === "video" ? (request.duration ?? model.limits.durations?.[0]) : undefined,
    });
  }
  const raw: Record<string, unknown> = { prompt, seed };
  if (request.kind === "image" || request.kind === "video") raw.aspectRatio = aspectRatio;
  if (request.kind === "video") raw.duration = request.duration ?? model.limits.durations?.[0];
  if (request.kind === "audio") {
    const low = model.limits.minSeconds ?? 1;
    const high = model.limits.maxSeconds ?? 22;
    raw.duration = Math.min(high, Math.max(low, request.duration ?? 5));
  }
  if (request.kind === "voice") raw.voice = request.voice ?? model.limits.voices?.[0];
  if ((request.kind === "image" || request.kind === "video") && request.resolution) raw.resolution = request.resolution;
  // Frame đầu/cuối: model phải nhận, và ảnh phải là ảnh AI đã xong (có bản trên Storage).
  const frames: { start_frame?: string; end_frame?: string } = {};
  for (const [field, key, cap] of [["start_image", "startImage", "firstFrame"], ["end_image", "endImage", "lastFrame"]] as const) {
    const path = request[field];
    if (!path) continue;
    if (request.kind !== "video" || !model.limits[cap]) return `${field}: ${model.name} cannot ${cap === "firstFrame" ? "start" : "end"} on an image.`;
    const object = lookupImage ? await lookupImage(path) : null;
    if (!object) return `${field}: "${path}" is not an image saved to the cloud yet. Use a finished AI image, an uploaded image, or save_frame, and wait until it is ready.`;
    raw[key] = object;
    frames[field === "start_image" ? "start_frame" : "end_frame"] = path;
  }

  // Ảnh tham chiếu (G2): model phải nhận, và mỗi ảnh phải đã lên Storage — cùng luật với frame.
  let refs: string[] | undefined;
  if (request.references?.length) {
    if (request.kind !== "image" && request.kind !== "video") return "references: only images and videos take reference images.";
    const cap = model.limits.maxReferences ?? 0;
    if (!cap) return `references: ${model.name} does not take reference images.`;
    if (request.references.length > cap) return `references: ${model.name} takes up to ${cap} reference images.`;
    const objects: string[] = [];
    for (const path of request.references) {
      const object = lookupImage ? await lookupImage(path) : null;
      if (!object) return `references: "${path}" is not an image saved to the cloud yet. Use a finished AI image or an uploaded image, and wait until it is ready.`;
      objects.push(object);
    }
    raw.references = objects;
    refs = request.references;
  }

  let spec: GenerationSpec;
  try {
    spec = normalizeSpec(model, raw);
  } catch (err) {
    return err instanceof ApiError ? err.message : "Invalid input.";
  }
  const op = {
    op: "add_generated",
    kind: request.kind,
    model: model.id,
    prompt: spec.prompt,
    seed,
    ...(spec.aspectRatio ? { aspect_ratio: spec.aspectRatio } : {}),
    ...(spec.duration ? { duration: spec.duration } : {}),
    ...(spec.voice ? { voice: spec.voice } : {}),
    ...(spec.resolution ? { resolution: spec.resolution } : {}),
    ...frames,
    ...(refs ? { refs } : {}),
    ...(start ? { start } : {}),
    ...((request.kind === "image" || request.kind === "video") && request.length ? { length: request.length } : {}),
    ...(request.kind === "video" && request.muted ? { muted: true } : {}),
    ...(request.kind === "video" && request.fit ? { fit: true } : {}),
  } as Op;
  return { model, spec, op, credits: priceOf(model, spec), ...(request.quote ? { quote: request.quote } : {}) };
}

export function generateCard(prepared: PreparedGeneration, clipId: string) {
  const credits = `${prepared.credits} ${prepared.credits === 1 ? "credit" : "credits"}`;
  return {
    clips: [{ id: clipId, label: "This clip" }],
    changes: [
      // Giọng phải có tên trên thẻ: "with ElevenLabs voice" không cho biết đang duyệt giọng nào.
      `${describeOp(prepared.op)} with ${typeof prepared.spec.voice === "string" ? `the voice ${prepared.spec.voice}` : prepared.model.name} · ${credits}`,
      ...(prepared.quote ? [`For the line: “${prepared.quote}”`, `Prompt: ${prepared.spec.prompt}`] : []),
    ],
    credits: prepared.credits,
  };
}

// ------------------------------------------------------------------ 3D Studio

/** Tool có khi model `studio-3d` bật (GPU Modal, CLI local, hoặc bản fake). */
export function studioToolSpec(): ToolSpec | null {
  if (!availableModels().some((model) => model.id === STUDIO_MODEL)) return null;
  return {
    name: "add_3d_studio",
    description:
      'Render a premium 3D scene (studio lighting, glossy materials, camera move) as a short video on the clip, for credits after the user approves the price. Templates: "bars" (2-6 labelled values, highlight the key one), "number" (one big number counting up, with prefix/suffix like $ or %), "rise" (3-12 values over time as a glowing growth line), "product" (a 3D object on a turntable: phone, laptop, coin, gift, trophy, rocket, lightbulb, globe, box, bottle). Use it when a number or result the speaker says deserves a hero moment, or when the user asks for premium/3D visuals; the data must come from the script (quote = the words it illustrates). For free, instant visuals use add_chart/add_3d instead. It appears when rendered (about half a minute). read_guide "3d".',
    schema: sanitize(z.toJSONSchema(studio3dToolInput, { io: "input" })).schema as Record<string, unknown>,
    strict: false,
    approval: true,
  };
}

/** Dựng kế hoạch (mốc, vị trí, spec) trên document hiện tại của clip. */
export type PlanStudio = (input: Studio3dInput) => Promise<Awaited<ReturnType<typeof planStudio3d>>>;

export async function prepareStudio(input: unknown, plan: PlanStudio): Promise<PreparedGeneration | string> {
  const parsed = studio3dToolInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "Invalid input."}`;
  }
  const model = availableModels().find((candidate) => candidate.id === STUDIO_MODEL);
  if (!model) return "3D Studio is not available.";
  const request = { op: "add_3d_studio" as const, ...parsed.data };
  let planned: Awaited<ReturnType<PlanStudio>>;
  try {
    planned = await plan(request);
  } catch (err) {
    return (err as Error).message;
  }
  let spec: GenerationSpec;
  try {
    spec = normalizeSpec(model, planned.spec);
  } catch (err) {
    return err instanceof ApiError ? err.message : "Invalid input.";
  }
  // Ghim mốc + tỉ lệ vào op: áp sau khi duyệt ra ĐÚNG spec đã báo giá.
  const op = { ...request, start: planned.start, end: planned.end, aspect_ratio: spec.aspectRatio } as unknown as Op;
  return { model, spec, op, credits: priceOf(model, spec), ...(request.quote ? { quote: request.quote } : {}) };
}

// ------------------------------------------------------------------ Cảnh code (spec code-scenes)

const sceneRegion = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.05).max(1), height: z.number().min(0.05).max(1) })
  .strict();

/** add_3d_scene: code three.js agent đã preview_3d và sửa xong, đặt lên clip như một video. */
export const sceneToolInput = z.object({
  title: z.string().trim().min(1).max(40).describe("Short name of the animation (price card, layer and file name), e.g. \"Effort staircase\"."),
  code: z.string().min(1).max(MAX_CODE_CHARS).describe("The scene code exactly as last previewed with preview_3d."),
  quote: z.string().trim().min(2).max(300).optional().describe("Exact words from <clip_context> the animation plays over; it starts on them."),
  start: z.number().finite().min(0).optional().describe("Clip seconds; give only to adjust the quote timing."),
  end: z.number().finite().min(0).optional(),
  region: sceneRegion.optional().describe("Where it sits (0-1 of the frame). Default: the panel of a split, else the visual area."),
  theme: z.enum(THEMES).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
});

export function sceneToolSpec(): ToolSpec | null {
  if (!availableModels().some((model) => model.id === STUDIO_MODEL)) return null;
  return {
    name: "add_3d_scene",
    description:
      'Put a 3D animation you wrote as three.js code on the clip: it renders on our GPUs as a short video (about half a minute) for credits after the user approves the price. Only send code you have checked with preview_3d (no errors, no layout issues). read_guide "3d" first.',
    schema: sanitize(z.toJSONSchema(sceneToolInput, { io: "input" })).schema as Record<string, unknown>,
    strict: false,
    approval: true,
  };
}

/** Mọi chữ trong các chuỗi của code: font brand được subset theo chúng (chữ nằm trong code, không trong field). */
export function codeGlyphs(code: string): string | undefined {
  const literals = code.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];
  const chars = [...new Set(literals.map((literal) => literal.slice(1, -1)).join("").replace(/\s/g, ""))].join("");
  return chars ? chars.slice(0, 400) : undefined;
}

/**
 * Lưu code (scene_codes, theo sha256) rồi đi ĐÚNG đường của 3D Studio với
 * `{template: "code", code_ref}`: kế hoạch đặt, giá, thẻ duyệt, generation.
 * Code không bao giờ nằm trong spec/document — chỉ tham chiếu.
 */
export async function prepareScene(input: unknown, plan: PlanStudio, save: (code: string) => Promise<string>): Promise<PreparedGeneration | string> {
  const parsed = sceneToolInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "Invalid input."}`;
  }
  // Không nhận aspect_ratio: server lấy đúng hình vùng đặt cảnh. Agent từng truyền
  // 9:16 (theo guide cũ) trên clip 16:9 → cảnh thành dải dọc giữa khung (02/10).
  // kit.frame() tự canh camera theo tỉ lệ nên code đã preview ở tỉ lệ khác vẫn đúng.
  const { code, title, theme, ...placement } = parsed.data;
  let hash: string;
  try {
    hash = await save(code);
  } catch (err) {
    return err instanceof ApiError ? err.message : "Could not save the scene code.";
  }
  const glyphs = codeGlyphs(`${title} ${code}`);
  return prepareStudio(
    { ...placement, template: "code", code_ref: hash, title, ...(theme ? { theme } : {}), ...(glyphs ? { glyphs } : {}) },
    plan,
  );
}

// ------------------------------------------------------------------ Voiceover

/** Giọng dùng được lúc này; tên giọng là duy nhất trên mọi model (giọng quyết định model). */
const voiceModels = () => availableModels().filter((model) => model.kind === "voice");

/** Tool có khi máy chủ bật ít nhất một model giọng. */
export function voiceoverToolSpec(): ToolSpec | null {
  const voices = voiceModels().flatMap((model) => model.limits.voices ?? []);
  if (!voices.length) return null;
  return {
    name: "add_voiceover",
    description: `Put a new AI voice on the clip, for credits after the user approves the price. mode "replace": the new voice replaces the speaker for the whole clip (original speech muted, its captions hidden, new captions follow the new voice) — use it to repurpose a clip with a new script; the script should fit the clip at about 3 words per second. mode "overlay": a short line plays over the clip at start (or after quote) while the original audio is lowered by duck_db. Voices: ${voices.join(", ")}. read_guide "voiceover" first. Only when the user asks for a voiceover, narration or a new script.`,
    schema: sanitize(z.toJSONSchema(voiceoverToolInput, { io: "input" })).schema as Record<string, unknown>,
    strict: false,
    approval: true,
  };
}

export type PlanVoiceover = (input: VoiceoverInput) => Promise<Awaited<ReturnType<typeof planVoiceover>>>;

export async function prepareVoiceover(input: unknown, plan: PlanVoiceover): Promise<PreparedGeneration | string> {
  const parsed = voiceoverToolInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "Invalid input."}`;
  }
  const model = voiceModels().find((candidate) => candidate.limits.voices?.includes(parsed.data.voice));
  if (!model) return `voice: choose one of ${voiceModels().flatMap((entry) => entry.limits.voices ?? []).join(", ")}.`;
  const request = { op: "add_voiceover" as const, ...parsed.data, seed: parsed.data.seed ?? randomInt(0, 2_147_483_647) };
  let planned: Awaited<ReturnType<PlanVoiceover>>;
  try {
    planned = await plan(request);
  } catch (err) {
    return (err as Error).message;
  }
  let spec: GenerationSpec;
  try {
    spec = normalizeSpec(model, planned.spec);
  } catch (err) {
    return err instanceof ApiError ? err.message : "Invalid input.";
  }
  // Ghim mốc + seed vào op: áp sau khi duyệt ra ĐÚNG spec đã báo giá.
  const op = { ...request, start: planned.start } as unknown as Op;
  return { model, spec, op, credits: priceOf(model, spec), ...(request.quote ? { quote: request.quote } : {}) };
}

type GenerateEnv = {
  supabase: SupabaseClient;
  jobId: string;
  clipId: string;
  /** Áp op lên clip qua đường ghi chung (CAS + checkpoint), như mọi tool ghi. */
  applyOp: (op: Op) => Promise<ToolOutcome>;
};

/** Người dùng đã Approve: tạo lượt sinh rồi đặt khai báo lên clip. */
export async function runGeneration(env: GenerateEnv, prepared: PreparedGeneration): Promise<{ outcome: ToolOutcome; generationId?: string }> {
  let generation: { id: string; credits_reserved: number };
  try {
    ({ generation } = await createGeneration(env.supabase, {
      jobId: env.jobId,
      clipId: env.clipId,
      model: prepared.model.id,
      spec: prepared.spec,
      requestId: randomUUID(),
    }));
  } catch (err) {
    const message = err instanceof ApiError && err.status < 500 ? err.message : "The generation could not be started.";
    if (!(err instanceof ApiError)) console.error("[agent] generate_media lỗi", err);
    return { outcome: { ok: false, content: JSON.stringify({ error: message }), summary: message } };
  }

  // Op đã chốt lúc chuẩn bị (`add_generated`, hoặc `add_3d_studio` với mốc và
  // tỉ lệ ghim sẵn): khai báo nó ghi ra đúng spec vừa tạo generation.
  const applied = await env.applyOp(prepared.op);
  if (!applied.ok) {
    // Không đặt được lên clip (vd clip vừa đổi ở tab khác): huỷ lượt sinh để
    // hoàn credit, thay vì để nó chạy ra một file không ai thấy.
    await rpcOrThrow(env.supabase, "cancel_generation", { p_id: generation.id }).catch(() => undefined);
    return { outcome: applied };
  }
  const credits = `${generation.credits_reserved} ${generation.credits_reserved === 1 ? "credit" : "credits"}`;
  return {
    generationId: generation.id,
    outcome: {
      ok: true,
      content: JSON.stringify({
        ok: true,
        generation_id: generation.id,
        credits: generation.credits_reserved,
        note: "Generation started. The media appears on the clip when it is ready; the user does not need to do anything.",
      }),
      summary: `Started ${NOUN[prepared.model.kind]} (${credits})`,
      version: applied.version,
    },
  };
}
