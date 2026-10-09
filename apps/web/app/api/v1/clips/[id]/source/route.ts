import { ApiError } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";
import { clipContext } from "@/lib/api/clips";
import { signedObjectUrl } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Nguồn cho canvas: proxy 540p + vết bám mặt.
 *
 * Khác bản local ở một chỗ quan trọng: local trả `focus` đã tính sẵn cho từng
 * đoạn cắt, nghĩa là mỗi lần người dùng kéo một mép cắt là server phải chạy lại
 * MediaPipe. Ở đây trả thẳng MẪU (`face_track`) và client tự tra theo khoảng —
 * cùng dữ liệu worker đã lấy một lần lúc xử lý job (D2 Task 2.1).
 */
export const GET = withApi({}, async ({ supabase, params }) => {
  const context = await clipContext(supabase, params.id);
  const proxy = context.job.media_manifest?.proxies?.[params.id];

  if (!proxy?.object) {
    throw new ApiError(
      409,
      "This clip has no editable source yet. Process the video again to edit it.",
    );
  }

  const { data: artifact } = await supabase
    .from("artifacts")
    .select("data")
    .eq("job_id", context.clip.job_id)
    .eq("kind", "face_track")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const track =
    ((artifact?.data as { clips?: Record<string, number[][]> } | null)?.clips ?? {})[
      params.id
    ] ?? [];

  const height = proxy.height ?? 540;
  return {
    // Đường dẫn tới từ manifest trong database, không từ query string.
    url: await signedObjectUrl("sources", proxy.object),
    offset: proxy.offset ?? 0,
    // Job cũ chưa ghi width vào manifest: đoán theo 16:9 còn hơn trả 0 và làm
    // canvas chia cho không.
    width: proxy.width ?? Math.round((height * 16) / 9),
    height,
    duration: proxy.duration ?? null,
    face_track: track,
  };
});
