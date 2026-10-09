import "server-only";

/**
 * Phụ đề tốn credit cho agent (F2, học Palmier add_captions): `add_captions` tạo phụ đề cho
 * một video/âm thanh thư viện, `translate_captions` dịch một lớp phụ đề. Cả hai đi qua THẺ
 * DUYỆT có giá như `generate_media`, rồi chạy đúng RPC của inspector (`lib/editor/captions-run.ts`).
 */

import { z } from "zod";

import type { Manifest } from "@opencmo/clip-assets";
import type { ClipDocument } from "@opencmo/clip-doc";
import { byId } from "@opencmo/editor-core";

import { ApiError } from "@/lib/api/errors";
import { defaultBrandKit } from "@/lib/brand";
import type { SupabaseClient } from "@/lib/api/handler";
import { createMediaCaptions, storedLines, translateCaptions } from "@/lib/editor/captions-run";
import { captionCredits, captionsNode, mediaOf, sourceRange, TRANSCRIPT_SRC } from "@/lib/editor/captions-source";
import { captionSeconds, TRANSLATE_LANGUAGES } from "@/lib/editor/captions-translate";

import { spec, type ToolOutcome, type ToolSpec } from "./tools";

const addInput = z.object({ element_id: z.string().min(1).max(64) });
const translateInput = z.object({ element_id: z.string().min(1).max(64), language: z.enum(TRANSLATE_LANGUAGES) });

export const CAPTION_TOOL_SPECS: ToolSpec[] = [
  spec(
    "add_captions",
    "Create captions for a video or audio element from the library (B-roll, an uploaded talk, music with vocals): transcribes the part of the file the element plays and adds a captions layer timed to it. Costs 1 credit per minute; the user approves the price first. The clip's own speaker already has captions — use this for other media.",
    addInput,
  ),
  spec(
    "translate_captions",
    `Translate a captions layer into another language and add it as a NEW captions layer (the original stays). Costs 1 credit per minute of captions; the user approves first. Languages: ${TRANSLATE_LANGUAGES.join(", ")}. Works on captions saved with this project (made by add_captions, imported, or edited); the clip's original captions need one word edit first.`,
    translateInput,
  ),
];
export const CAPTION_TOOLS = new Set(CAPTION_TOOL_SPECS.map((tool) => tool.name));

// --------------------------------------------------------------------- Brand Kit

const brandInput = z.object({ frame: z.boolean().optional().describe("Also add the brand frame/logo layout from the kit. Default false.") });

/** Áp Brand Kit mặc định của người dùng (kit đọc ở server, op `apply_brand` — Undo được). */
export const BRAND_TOOL_SPEC: ToolSpec = spec(
  "apply_brand_kit",
  "Apply the user's default brand kit to the clip: brand colors and fonts on captions and titles, the caption style, and the logo. Same as the editor's Apply brand menu. Use it when the user asks to put the clip on brand; read_guide \"brand\" for the details. Fails if the user has no brand kit yet (they set one up on the Brand page).",
  brandInput,
);

export async function runBrandTool(
  supabase: SupabaseClient,
  raw: unknown,
  apply: (op: { op: "apply_brand"; kit: unknown; frame?: boolean }) => Promise<ToolOutcome>,
): Promise<ToolOutcome> {
  const parsed = brandInput.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues[0]?.message }), summary: "Invalid request" };
  const kit = await defaultBrandKit(supabase);
  if (!kit) {
    return { ok: false, content: JSON.stringify({ error: "The user has no brand kit yet. Tell them to set one up on the Brand page." }), summary: "No brand kit yet" };
  }
  return apply({ op: "apply_brand", kit: kit.kit, ...(parsed.data.frame ? { frame: true } : {}) });
}

export type PreparedCaptions =
  | { kind: "add"; parent_id: string; media_id: string; source_in: number; source_out: number; credits: number; timing: Record<string, unknown>; name: string }
  | { kind: "translate"; parent_id: string; hash: string; language: string; credits: number; node: Record<string, unknown> };

const containerOf = (parent: Record<string, unknown> | null, scene: string) =>
  parent && (parent.kind === "scene" || parent.kind === "group") && typeof parent.id === "string" ? parent.id : scene;

function sceneId(document: ClipDocument): string {
  const scenes = (document.stage as { children?: { id?: string; active?: boolean }[] }).children ?? [];
  return String((scenes.find((scene) => scene.active) ?? scenes[0])?.id ?? "");
}

/** Báo giá: tìm phần tử, nguồn thư viện đã lên Storage, đoạn đang chiếu. Chuỗi = lỗi cho model. */
export async function prepareCaptions(
  supabase: SupabaseClient,
  clipId: string,
  name: string,
  raw: unknown,
  snapshot: { document: ClipDocument; manifest: Manifest },
): Promise<PreparedCaptions | string> {
  const parsed = (name === "add_captions" ? addInput : translateInput).safeParse(raw);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "Invalid input.";
  const found = byId(snapshot.document, parsed.data.element_id);
  if (!found) return `No element with id ${parsed.data.element_id}. Read the ids with get_document.`;
  const parent = containerOf(found.parent, sceneId(snapshot.document));

  if (name === "add_captions") {
    const media = mediaOf(found.entity);
    if (!media || typeof media.src !== "string") return "add_captions works on a video or audio element from the library.";
    const record = ((snapshot.manifest as { assets?: Record<string, unknown>[] }).assets ?? []).find((asset) => asset.path === media.src);
    if (!record) return "This element does not play a library file. The clip's own speaker already has captions.";
    const cloud = record.cloud as { state?: string; mediaId?: string } | undefined;
    if (cloud?.state !== "synced" || !cloud.mediaId) return "This file is still uploading. Try again when it is stored with the project.";
    const range = sourceRange(media.timing, typeof record.duration === "number" ? record.duration : undefined);
    if (range.end - range.start < 0.5) return "The element plays less than half a second of the file.";
    return {
      kind: "add",
      parent_id: parent,
      media_id: cloud.mediaId,
      source_in: range.start,
      source_out: range.end,
      credits: captionCredits(range.end - range.start),
      timing: media.timing,
      name: `Captions · ${String(record.path).split("/").pop()}`,
    };
  }

  const input = parsed.data as z.infer<typeof translateInput>;
  if (found.entity.kind !== "captions") return "translate_captions needs a captions element.";
  const match = typeof found.entity.src === "string" ? TRANSCRIPT_SRC.exec(found.entity.src) : null;
  if (!match) return "These are the clip's original captions. Edit one word (edit_words) to save a copy, then translate it.";
  try {
    const lines = await storedLines(supabase, clipId, match[1]!);
    const copy = { ...found.entity };
    delete copy.id;
    return { kind: "translate", parent_id: parent, hash: match[1]!, language: input.language, credits: captionCredits(captionSeconds(lines)), node: copy };
  } catch (error) {
    return error instanceof Error ? error.message : "These captions can't be translated.";
  }
}

export function captionsCard(prepared: PreparedCaptions, clipId: string) {
  const credits = `${prepared.credits} ${prepared.credits === 1 ? "credit" : "credits"}`;
  return {
    clips: [{ id: clipId, label: "This clip" }],
    changes: [
      prepared.kind === "add"
        ? `Create captions for ${prepared.name.replace("Captions · ", "")} (${Math.round(prepared.source_out - prepared.source_in)} s) · ${credits}`
        : `Translate the captions into ${prepared.language} as a new layer · ${credits}`,
      "Credits are refunded if it fails.",
    ],
    credits: prepared.credits,
  };
}

/** Người dùng đã duyệt: chạy RPC rồi thêm lớp phụ đề bằng `insert_captions` (một bước Undo, không đè phụ đề đang chạy). */
export async function runCaptions(
  supabase: SupabaseClient,
  clipId: string,
  prepared: PreparedCaptions,
  insert: (op: { op: "insert_captions"; parent_id: string; node: Record<string, unknown> }) => Promise<ToolOutcome>,
): Promise<ToolOutcome> {
  try {
    if (prepared.kind === "add") {
      const done = await createMediaCaptions(
        supabase,
        { clipId, mediaId: prepared.media_id, sourceIn: prepared.source_in, sourceOut: prepared.source_out },
        150_000,
      );
      if (!done.src) {
        return {
          ok: false,
          content: JSON.stringify({ pending: true, message: "Captions are still being created. Ask the user to add them from the element's inspector in a minute; nothing more was charged." }),
          summary: "Captions still processing",
        };
      }
      return insert({ op: "insert_captions", parent_id: prepared.parent_id, node: captionsNode(prepared.timing, done.src, prepared.name) });
    }
    const out = await translateCaptions(supabase, clipId, prepared.hash, prepared.language);
    return insert({ op: "insert_captions", parent_id: prepared.parent_id, node: { ...prepared.node, src: out.src, name: `Captions · ${prepared.language}` } });
  } catch (error) {
    const message = error instanceof ApiError || error instanceof Error ? error.message : "Could not create captions. Your credits were refunded.";
    return { ok: false, content: JSON.stringify({ error: message }), summary: message };
  }
}
