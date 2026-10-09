import { ApiError } from "@/lib/api/errors";
import { clipContext } from "@/lib/api/clips";
import { withApi } from "@/lib/api/handler";
import {
  editorSource,
  NoEditorSourceError,
  signedSourceUrl,
  signedTranscriptUrl,
} from "@/lib/editor/media";
import { ensureBlankProject, ensureEditorProject, hasTranscript } from "@/lib/editor/project";

export const dynamic = "force-dynamic";

/**
 * Project của editor: đọc, và tạo lần đầu. Ghi đi qua `PUT /editor/document`.
 *
 * Clip id đi trong QUERY STRING (`/editor/project?clip_id=`): cả họ route
 * `/editor/*` nhận clip id cùng một cách, một cửa thì dễ kiểm hơn một họ cửa.
 *
 * Lần đầu mở một clip thì chưa có project: route sinh document từ revision hiện
 * hành rồi nhờ `get_or_create_editor_project` ghi. Hàm SQL đó KHÔNG đè lên bản
 * đã có, nên hai tab mở cùng lúc thì tab tới sau nhận bản của tab tới trước —
 * kể cả khi tab đó đã sửa.
 */

/** URL media hết hạn sau một giờ; client gọi lại `?refresh=media` khi 403. */
async function mediaPayload(
  supabase: Parameters<typeof clipContext>[0],
  context: Awaited<ReturnType<typeof clipContext>>,
  clipId: string,
) {
  const source = editorSource(context, clipId);
  return {
    // Id của JOB, không phải của clip. B-roll thuộc về project chứ không thuộc
    // về một clip (`POST /api/v1/projects/[id]/media`), và editor chỉ biết
    // clip id từ URL — nên nó phải tới từ đây.
    project_id: context.clip.job_id,
    master: {
      url: await signedSourceUrl(source),
      width: source.width,
      height: source.height,
      duration: source.duration,
      offset: source.offset,
    },
    // Master mang transcript của chính nó, ghi lúc xử lý job: một file bất
    // biến, hash ổn định, và thư viện asset của editor giữ được nó qua các
    // lượt mở. Job cũ hơn Phase 3 không có file đó — rơi về route dựng lại
    // transcript từ artifact, để không có mốc nào mà một nửa thư viện của
    // người dùng ngừng có phụ đề.
    transcript:
      (await signedTranscriptUrl(source)) ??
      ((await hasTranscript(supabase, context.clip.job_id))
        ? `/api/v1/editor/transcript?clip_id=${clipId}`
        : null),
  };
}

export const GET = withApi({}, async ({ supabase, request, params: _params }) => {
  const url = new URL(request.url);
  const clipId = url.searchParams.get("clip_id") ?? "";
  if (!clipId) throw new ApiError(422, "clip_id: Required");

  const context = await clipContext(supabase, clipId);

  // New edit (F1): không có video người nói, không transcript — thư viện là nguồn media.
  if (context.clip.kind === "blank") {
    const media = { project_id: context.clip.job_id, master: null, transcript: null };
    if (url.searchParams.get("refresh") === "media") return { media };
    return { ...(await ensureBlankProject(supabase, context, clipId)), media };
  }

  let media;
  try {
    media = await mediaPayload(supabase, context, clipId);
  } catch (err) {
    if (err instanceof NoEditorSourceError) throw new ApiError(409, err.message);
    throw err;
  }

  // Chỉ ký lại URL. Client gọi nhánh này khi decode báo 403 giữa buổi sửa —
  // không cần kéo lại cả source, và không được đụng tới `version`.
  if (url.searchParams.get("refresh") === "media") return { media };

  const project = await ensureEditorProject(supabase, context, clipId, media.transcript !== null);
  return { ...project, media };
});
