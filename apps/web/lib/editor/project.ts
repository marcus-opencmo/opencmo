/**
 * Project editor của một clip: đọc, và sinh lần đầu từ settings gốc của clip (`clips.settings`).
 *
 * Một hàm cho hai người gọi: `GET /api/v1/editor/project` (mở editor) và
 * Assistant ở trang project (sửa cả những clip chưa từng mở). Hàm SQL
 * `get_or_create_editor_project` KHÔNG đè bản đã có, nên hai nơi cùng tạo một
 * lúc thì nơi tới sau nhận bản của nơi tới trước.
 */

import type { ClipDocument } from "@opencmo/clip-doc";
import { applyOps, captionsOnTop, type OpContext } from "@opencmo/editor-core";

import { ApiError } from "@/lib/api/errors";
import { CLIP_NOT_FOUND, sourceDuration, type ClipContext } from "@/lib/api/clips";
import { notFound, rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import { defaultBrandKit } from "@/lib/brand";
import { generatedDocument, PROJECT_COLUMNS, saveDocument, withDocument } from "@/lib/editor/document";
import { editorSource, signedTranscriptUrl } from "@/lib/editor/media";
import { generateProject } from "@/lib/editor/generate-project";
import { parseSettings, SettingsError } from "@/lib/settings-schema";

export type EditorProject = {
  clip_id: string;
  /** Nguồn sự thật duy nhất (B1, C3). */
  document: ClipDocument;
  /** Vân tay để chụp revision cho Export (`snapshot_editor_revision`). */
  document_hash: string;
  manifest: unknown;
  version: number;
  updated_at: string;
};

export async function hasTranscript(
  supabase: SupabaseClient,
  jobId: string,
): Promise<boolean> {
  // `artifacts` không có cột `id`: khoá chính là `(job_id, kind, version)`.
  const { data } = await supabase
    .from("artifacts")
    .select("version")
    .eq("job_id", jobId)
    .eq("kind", "transcript")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}

/**
 * Clip mở lần đầu mang Brand Kit mặc định của người dùng (spec brand-kit BK4):
 * phụ đề, font tiêu đề, logo, mark `brand` cho visual về sau. Khung giữ theo
 * lựa chọn lúc tạo project (form đã chọn sẵn tỉ lệ của kit). Áp hỏng thì mở clip
 * không brand — không bao giờ chặn người dùng vào editor vì một kit.
 */
async function branded(supabase: SupabaseClient, document: ClipDocument, source: { width: number; height: number }): Promise<ClipDocument> {
  const kit = await defaultBrandKit(supabase).catch(() => null);
  if (!kit) return document;
  try {
    const ctx = { master: { width: source.width, height: source.height }, readTranscript: async () => [], saveTranscript: async () => "" } as unknown as OpContext;
    return (await applyOps(document, [{ op: "apply_brand", kit: kit.kit, frame: false }], ctx)).document;
  } catch (err) {
    console.error("[editor] apply default brand kit failed", err);
    return document;
  }
}

/**
 * Project lưu trước bất biến `captionsOnTop` (02/10) có thể còn b-roll/visual vẽ
 * ĐÈ lên phụ đề: bất biến chỉ chạy sau một lượt op, nên project chưa sửa lại lần
 * nào giữ nguyên thứ tự cũ — phụ đề có trên timeline mà không thấy trên khung.
 * Mở ra là sửa và lưu một lần (cả bản export đọc document đã lưu). Lưu hỏng vì
 * khoá lạc quan thì trả bản đang có: lượt op kế tiếp sẽ sửa.
 */
async function captionsUp(supabase: SupabaseClient, project: EditorProject): Promise<EditorProject> {
  const fixed = captionsOnTop(project.document);
  if (fixed === project.document) return project;
  try {
    return { ...project, ...(await saveDocument(supabase, project.clip_id, project.version, fixed)) };
  } catch (err) {
    console.error("[editor] could not move captions above other layers", err);
    return project;
  }
}

/** Project hiện có, hoặc sinh lần đầu. `transcript`: clip có transcript để gắn `<captions>` không. */
export async function ensureEditorProject(
  supabase: SupabaseClient,
  context: ClipContext,
  clipId: string,
  transcript?: boolean,
): Promise<EditorProject> {
  const { data: existing } = await supabase
    .from("editor_projects")
    .select(PROJECT_COLUMNS)
    .eq("clip_id", clipId)
    .maybeSingle();
  if (existing) return captionsUp(supabase, withDocument(existing as EditorProject));

  const { data: row } = await supabase
    .from("clips")
    .select("settings")
    .eq("id", clipId)
    .maybeSingle();

  const stored = (row as { settings: unknown } | null)?.settings;
  if (stored === null || stored === undefined) throw notFound(CLIP_NOT_FOUND);

  let settings;
  try {
    settings = parseSettings(stored, sourceDuration(context));
  } catch (err) {
    // Settings gốc đã qua `parseSettings` một lần lúc được ghi, nên tới đây là
    // dữ liệu cũ hơn luật hiện tại. Nói thẳng chứ không dựng một project rỗng:
    // canvas trống không phân biệt được với build hỏng.
    if (err instanceof SettingsError) {
      throw new ApiError(
        409,
        "This clip was saved with an older editor. Process the video again to edit it.",
      );
    }
    throw err;
  }

  const source = editorSource(context, clipId);
  const withTranscript =
    transcript ??
    ((await signedTranscriptUrl(source)) !== null || (await hasTranscript(supabase, context.clip.job_id)));
  const generated = generatedDocument(() =>
    generateProject({
      settings,
      source: {
        width: source.width,
        height: source.height,
        duration: source.duration,
        offset: source.offset,
      },
      hasTranscript: withTranscript,
      focus: source.entry.focus,
    }),
  );
  const created = await rpcOrThrow<EditorProject>(supabase, "get_or_create_editor_project", {
    p_clip_id: clipId,
    p_document: await branded(supabase, generated, source),
  });

  return withDocument(created);
}

/** Cỡ khung của New edit theo tỉ lệ đã chọn: cạnh ngắn 1080 như clip thường. */
const BLANK_FRAME: Record<string, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
};

/** Document của New edit (F1): một scene trống, không có video người nói, không transcript. */
export function blankDocument(aspect: string): ClipDocument {
  const frame = BLANK_FRAME[aspect] ?? BLANK_FRAME["9:16"]!;
  return {
    version: 1,
    stage: {
      children: [{ kind: "scene", name: "Edit", ...frame, fill: "#000000", active: true, workarea: [0, 10], children: [] }],
    },
  } as unknown as ClipDocument;
}

/** Project của clip `blank`: không có settings gốc (không có video để cắt). */
export async function ensureBlankProject(supabase: SupabaseClient, context: ClipContext, clipId: string): Promise<EditorProject> {
  const { data: existing } = await supabase.from("editor_projects").select(PROJECT_COLUMNS).eq("clip_id", clipId).maybeSingle();
  if (existing) return captionsUp(supabase, withDocument(existing as EditorProject));
  const created = await rpcOrThrow<EditorProject>(supabase, "get_or_create_editor_project", {
    p_clip_id: clipId,
    p_document: blankDocument(context.job.aspect),
  });
  return withDocument(created);
}
