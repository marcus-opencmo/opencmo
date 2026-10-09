/**
 * Transcript của một project editor, cho cả route transcript lẫn route ops.
 *
 * Hình dạng native của Diffusion Studio (`packages/assets/src/types.ts`):
 *   `{ text: string, words: { id?, text, start, end }[] }[]`
 * Mốc tính bằng GIÂY, gốc 0 là giây 0 của FILE NGUỒN mà editor mở — tức cùng
 * thang với `sourceIn`/`sourceOut` trong TSX, không phải thang của video gốc.
 */

import { OpFailure, type Transcript } from "@opencmo/editor-core";

import { ApiError } from "@/lib/api/errors";
import { sourceDuration, type ClipContext } from "@/lib/api/clips";
import type { SupabaseClient } from "@/lib/api/handler";
import { editorSource, NoEditorSourceError, signedTranscriptUrl } from "@/lib/editor/media";
import { parseSettings, SettingsError } from "@/lib/settings-schema";
import type { TranscriptSegment } from "@/lib/clipping-types";

type DsSegment = { text: string; words: { text: string; start: number; end: number }[] };

/** `<captions src>` của transcript gốc, và của bản người dùng đã sửa (theo hash). */
export const MASTER_TRANSCRIPT = "assets/transcript.json";
const EDITED = /^assets\/transcripts\/([0-9a-f]{64})\.json$/;

/**
 * Dựng transcript từ artifact của job — cho clip mà master không mang file
 * transcript của chính nó (job cũ hơn Phase 3).
 */
export async function transcriptFromArtifact(
  supabase: SupabaseClient,
  context: ClipContext,
  clipId: string,
): Promise<DsSegment[]> {
  let source;
  try {
    source = editorSource(context, clipId);
  } catch (err) {
    if (err instanceof NoEditorSourceError) throw new ApiError(409, err.message);
    throw err;
  }

  const { data: artifact } = await supabase
    .from("artifacts")
    .select("data")
    .eq("job_id", context.clip.job_id)
    .eq("kind", "transcript")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!artifact) {
    throw new ApiError(
      404,
      "This video was processed before transcripts were saved. " +
        "Process it again to edit its captions.",
    );
  }

  const { data: row } = await supabase
    .from("clips")
    .select("settings")
    .eq("id", clipId)
    .maybeSingle();
  const stored = (row as { settings: unknown } | null)?.settings;

  let start = source.offset;
  let end = source.offset + source.duration;
  if (stored !== null && stored !== undefined) {
    try {
      const settings = parseSettings(stored, sourceDuration(context));
      start = settings.source_start;
      end = settings.source_end;
    } catch (err) {
      // Settings gốc cũ hơn luật hiện tại: dùng trọn file nguồn. Phụ đề thừa ở hai
      // đầu tốt hơn không có phụ đề nào.
      if (!(err instanceof SettingsError)) throw err;
    }
  }

  const segments = ((artifact.data as { segments?: TranscriptSegment[] } | null)?.segments ??
    []) as TranscriptSegment[];

  // Gốc 0 là giây 0 của FILE, không phải của clip: `<video sourceIn=…>` cắt đầu
  // nhưng `<captions>` đọc transcript theo thang của nguồn nó gắn vào.
  const base = source.offset;
  const out: DsSegment[] = [];

  for (const segment of segments) {
    if (segment.end <= start || segment.start >= end) continue;

    const words = (segment.words ?? [])
      .filter((word) => word.end > start && word.start < end)
      .map((word) => ({
        text: word.text,
        start: Math.max(0, word.start - base),
        end: Math.max(0, word.end - base),
      }));

    const text = segment.text.trim();
    if (!text) continue;

    out.push({
      text,
      // Không có word timing thì dựng MỘT "từ" trải hết câu. Bịa mốc đều theo
      // ký tự là chính cái bẫy của parser SRT mà ta đang tránh — một khối chữ
      // hiện trọn câu thì thà thế còn hơn nhấn sai từ.
      words: words.length
        ? words
        : [
            {
              text,
              start: Math.max(0, Math.max(segment.start, start) - base),
              end: Math.max(0, Math.min(segment.end, end) - base),
            },
          ],
    });
  }

  // Trả THẲNG mảng, không bọc trong một object: `resolveTranscript` gọi
  // `JSON.parse(text)` rồi dùng kết quả làm transcript. Bọc thêm một lớp là
  // phụ đề rỗng, im lặng.
  return out;
}

/**
 * Đọc một transcript theo đường dẫn trong project, cho `OpContext` phía server.
 * Lỗi là `OpFailure` — câu tiếng Anh đi thẳng về client trong 422.
 */
export async function readProjectTranscript(
  supabase: SupabaseClient,
  context: ClipContext,
  clipId: string,
  path: string,
): Promise<Transcript> {
  const edited = EDITED.exec(path);
  if (edited) {
    const { data } = await supabase
      .from("editor_transcripts")
      .select("body")
      .eq("clip_id", clipId)
      .eq("hash", edited[1])
      .maybeSingle();
    if (!data) throw new OpFailure("An edited transcript of this clip is no longer available.");
    return JSON.parse((data as { body: string }).body) as Transcript;
  }
  if (path !== MASTER_TRANSCRIPT) throw new OpFailure("This clip's captions point to a file that cannot be edited.");

  try {
    const signed = await signedTranscriptUrl(editorSource(context, clipId));
    if (signed) {
      const response = await fetch(signed, { cache: "no-store" });
      if (!response.ok) throw new OpFailure("The transcript of this clip could not be loaded.");
      return (await response.json()) as Transcript;
    }
    return await transcriptFromArtifact(supabase, context, clipId);
  } catch (err) {
    if (err instanceof OpFailure) throw err;
    if (err instanceof ApiError || err instanceof NoEditorSourceError) throw new OpFailure(err.message);
    throw err;
  }
}
