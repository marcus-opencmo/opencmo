/**
 * Tool của Assistant ở trang project (spec AI Studio §2.2, P4).
 *
 * Hai tool đọc (`list_clips`, `get_clip`) chạy ngay. Tool ghi duy nhất là
 * `apply_to_clips {clip_ids, ops}` — cùng op của `@opencmo/editor-core`, chạy
 * qua `applyToClip` từng clip (CAS + checkpoint riêng từng clip) — và luôn qua
 * THẺ DUYỆT: lượt dừng `awaiting_approval`, người dùng thấy danh sách clip và
 * mô tả thay đổi, bấm Approve hay Cancel.
 */

import { z } from "zod";
import { AGENT_OP_INPUTS, OP_INPUTS, describeOp, isRemoved, loadCaptions, summarizeProject, type Op } from "@opencmo/editor-core";

import { ApiError } from "@/lib/api/errors";
import { clipContext } from "@/lib/api/clips";
import type { SupabaseClient } from "@/lib/api/handler";
import { applyToClip, serverOpContext } from "@/lib/editor/apply";
import { projectDocument } from "@/lib/editor/document";
import { ensureEditorProject } from "@/lib/editor/project";

import { sanitize, type ToolOutcome, type ToolSpec } from "./tools";

/** Trần clip mỗi lượt duyệt: một project có tối đa vài chục clip. */
const MAX_CLIPS = 50;

/**
 * Op áp được cho NHIỀU clip một lúc: những op có nghĩa như nhau trên mọi clip
 * (phụ đề, khung, chữ, cắt). Op timeline/inspector gọi element theo id của
 * MỘT clip — ở trang project chúng chỉ làm schema phình ra. Op `agent: false`
 * (vd `add_generated`) không đi qua thẻ duyệt không có giá này.
 */
const PROJECT_OPS = [
  "add_text",
  "delete_element",
  "edit_words",
  "merge_lines",
  "nudge_word",
  "remove_ranges",
  "remove_words",
  "restore_all",
  "restore_words",
  "set_caption_style",
  "set_frame",
  "split_line",
  "update_element",
].filter((name) => name in AGENT_OP_INPUTS);

const opSchema = z.object({ op: z.enum(PROJECT_OPS as [string, ...string[]]) }).passthrough();

export const applyInput = z.object({
  clip_ids: z.array(z.string().uuid()).min(1).max(MAX_CLIPS),
  ops: z.array(opSchema).min(1).max(20),
});

/** Schema `ops[]` cho model: mỗi phần tử là MỘT op trong registry (anyOf, giữ `op`). */
function opsItemsSchema(): { schema: Record<string, unknown>; open: boolean } {
  let open = false;
  const anyOf = [...PROJECT_OPS]
    .sort()
    .map((name) => {
      const next = sanitize(z.toJSONSchema(AGENT_OP_INPUTS[name]!, { io: "input", unrepresentable: "any" }));
      open ||= next.open;
      return next.schema;
    });
  return { schema: { anyOf }, open };
}

const EMPTY = { type: "object", properties: {}, additionalProperties: false };

export const PROJECT_TOOL_SPECS: ToolSpec[] = (() => {
  const items = opsItemsSchema();
  return [
    {
      name: "list_clips",
      description:
        "List every clip in this project with its id, number, hook, length, frame size and caption style.",
      schema: EMPTY,
      strict: true,
    },
    {
      name: "get_clip",
      description:
        "Read one clip in detail: its elements with ids, cuts, caption style, and its transcript lines with word ids.",
      schema: {
        type: "object",
        properties: { clip_id: { type: "string" } },
        required: ["clip_id"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      name: "apply_to_clips",
      description:
        "Apply the same editing operations to one or more clips. The user must approve every call: they see the clips and the changes first. Each item of `ops` is one operation with an `op` field naming it (set_caption_style, set_frame, add_text, remove_words, …), with the same fields as the single-clip editor. Word and element ids belong to ONE clip — only use them with that clip's id.",
      schema: {
        type: "object",
        properties: {
          clip_ids: { type: "array", items: { type: "string" } },
          ops: { type: "array", items: items.schema },
        },
        required: ["clip_ids", "ops"],
        additionalProperties: false,
      },
      strict: !items.open,
    },
  ].map((spec) => ({ ...spec, approval: spec.name === "apply_to_clips" }));
})();

export const isApprovalTool = (name: string): boolean => name === "apply_to_clips";

const asData = (value: unknown): string => JSON.stringify({ untrusted_data: value });

type ClipRow = { id: string; idx: number; hook: string | null; start_seconds: number; end_seconds: number };

export async function projectClips(supabase: SupabaseClient, jobId: string): Promise<ClipRow[]> {
  const { data } = await supabase
    .from("clips")
    .select("id, idx, hook, start_seconds, end_seconds")
    .eq("job_id", jobId)
    .eq("kind", "moment")
    .order("idx", { ascending: true });
  return (data ?? []) as ClipRow[];
}

export const clipLabel = (clip: ClipRow): string => clip.hook?.trim() || `Clip ${clip.idx + 1}`;

/** Thẻ duyệt: clip nào, đổi gì — câu tiếng Anh cho người dùng. */
export type ApprovalCard = { clips: { id: string; label: string }[]; changes: string[] };

export type ProjectEnv = { supabase: SupabaseClient; jobId: string };

export async function approvalCard(env: ProjectEnv, input: z.infer<typeof applyInput>): Promise<ApprovalCard> {
  const clips = await projectClips(env.supabase, env.jobId);
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  return {
    clips: input.clip_ids.map((id) => ({ id, label: byId.get(id) ? clipLabel(byId.get(id)!) : "Unknown clip" })),
    changes: input.ops.map((op) => describeOp(op as Op)),
  };
}

/** Kiểm input `apply_to_clips`: mọi clip phải thuộc project này. */
export async function validateApply(env: ProjectEnv, input: unknown): Promise<z.infer<typeof applyInput> | string> {
  const parsed = applyInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "Invalid input."}`;
  }
  const own = new Set((await projectClips(env.supabase, env.jobId)).map((clip) => clip.id));
  const foreign = parsed.data.clip_ids.filter((id) => !own.has(id));
  if (foreign.length) return `These clips are not in this project: ${foreign.join(", ")}`;
  return { ...parsed.data, clip_ids: [...new Set(parsed.data.clip_ids)] };
}

export type ClipOutcome = { clip_id: string; label: string; ok: boolean; error?: string; checkpoint_id?: string };

/**
 * Chạy `apply_to_clips` đã được duyệt: từng clip một, CAS + checkpoint riêng.
 * Clip lỗi không làm hỏng clip đã xong — liệt kê lại để người dùng Retry.
 */
export async function runApply(
  env: ProjectEnv,
  input: z.infer<typeof applyInput>,
  label: string,
  onCheckpoint: (revisionId: string) => Promise<void>,
): Promise<{ outcome: ToolOutcome; clips: ClipOutcome[]; versions: number }> {
  const byId = new Map((await projectClips(env.supabase, env.jobId)).map((clip) => [clip.id, clip]));
  const clips: ClipOutcome[] = [];
  let versions = 0;
  for (const clipId of input.clip_ids) {
    const name = byId.get(clipId) ? clipLabel(byId.get(clipId)!) : clipId;
    try {
      const context = await clipContext(env.supabase, clipId);
      await ensureEditorProject(env.supabase, context, clipId);
      const applied = await applyToClip(env.supabase, context, clipId, input.ops, { checkpoint: { kind: "agent", label } });
      if (applied.checkpoint) await onCheckpoint(applied.checkpoint.id);
      if (applied.changed) versions++;
      clips.push({ clip_id: clipId, label: name, ok: true, checkpoint_id: applied.checkpoint?.id });
    } catch (err) {
      const message = err instanceof ApiError && err.status < 500 ? err.message : "This clip could not be changed.";
      if (!(err instanceof ApiError)) console.error(`[agent] apply_to_clips ${clipId} lỗi`, err);
      clips.push({ clip_id: clipId, label: name, ok: false, error: message });
    }
  }
  const done = clips.filter((clip) => clip.ok).length;
  const summary = `Changed ${done} of ${clips.length} ${clips.length === 1 ? "clip" : "clips"}`;
  return {
    outcome: {
      ok: done > 0,
      content: JSON.stringify({ results: clips.map(({ checkpoint_id: _c, ...rest }) => rest) }),
      summary,
    },
    clips,
    versions,
  };
}

/** Tool đọc cấp project. Không bao giờ ném: lỗi thành `ok: false`. */
export async function runProjectRead(name: string, input: unknown, env: ProjectEnv): Promise<ToolOutcome> {
  try {
    if (name === "list_clips") {
      const clips = await projectClips(env.supabase, env.jobId);
      const { data: projects } = await env.supabase
        .from("editor_projects")
        .select("clip_id, document")
        .in("clip_id", clips.map((clip) => clip.id));
      const documents = new Map(
        ((projects ?? []) as { clip_id: string; document: unknown }[]).map((row) => [row.clip_id, projectDocument(row)]),
      );
      return {
        ok: true,
        content: asData({
          clips: clips.map((clip) => {
            const document = documents.get(clip.id);
            const summary = document ? summarizeProject(document) : null;
            return {
              id: clip.id,
              number: clip.idx + 1,
              hook: clip.hook,
              seconds: summary?.duration ?? Math.round((clip.end_seconds - clip.start_seconds) * 10) / 10,
              frame: summary?.frame ?? null,
              captions: summary?.captions ? { preset: summary.captions.preset, colors: summary.captions.colors } : null,
              edited: Boolean(document),
            };
          }),
        }),
        summary: `Read ${clips.length} ${clips.length === 1 ? "clip" : "clips"}`,
      };
    }

    // get_clip
    const clipId = (input as { clip_id?: unknown } | null)?.clip_id;
    if (typeof clipId !== "string" || !/^[0-9a-f-]{36}$/.test(clipId)) {
      return { ok: false, content: JSON.stringify({ error: "clip_id must be a clip id from list_clips." }), summary: "Could not read the clip" };
    }
    const context = await clipContext(env.supabase, clipId);
    if (context.clip.job_id !== env.jobId) {
      return { ok: false, content: JSON.stringify({ error: "That clip is not in this project." }), summary: "Could not read the clip" };
    }
    const project = await ensureEditorProject(env.supabase, context, clipId);
    const model = await loadCaptions(project.document, serverOpContext(env.supabase, context, clipId));
    return {
      ok: true,
      content: asData({
        ...summarizeProject(project.document),
        transcript: model?.transcript.map((segment) =>
          segment.words.map((word) => ({ id: word.id, text: word.text, ...(isRemoved(word, model.removed) ? { removed: true } : {}) })),
        ),
      }),
      summary: "Read a clip",
    };
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) {
      return { ok: false, content: JSON.stringify({ error: err.message }), summary: err.message };
    }
    console.error(`[agent] tool ${name} lỗi`, err);
    return { ok: false, content: JSON.stringify({ error: "This clip could not be read." }), summary: "Could not read the clip" };
  }
}

export { OP_INPUTS };
