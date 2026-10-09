import { notFound, withApi } from "@/lib/api/handler";
import { GENERATION_COLUMNS, generationView, type GenerationRow } from "@/lib/generate/models";
import { signedObjectUrl } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Một generation, đọc dưới RLS. Khi `done`: link tải có hạn tới file trong
 * bucket `media` — editor tải về OPFS rồi ghi `cloud.mediaId` như B-roll, để
 * máy khác khôi phục được qua `/projects/:id/media`.
 */
export const GET = withApi({}, async ({ supabase, params }) => {
  if (!/^[0-9a-f-]{36}$/.test(params.id ?? "")) throw notFound("Generation not found.");
  const { data } = await supabase.from("generations").select(GENERATION_COLUMNS).eq("id", params.id).maybeSingle();
  if (!data) throw notFound("Generation not found.");
  const row = data as GenerationRow;

  let asset = null;
  if (row.status === "done" && row.media_asset_id) {
    const { data: media } = await supabase
      .from("media_assets")
      .select("id, name, storage_path, duration, width, height, words")
      .eq("id", row.media_asset_id)
      .maybeSingle();
    if (media) {
      const m = media as {
        id: string;
        name: string;
        storage_path: string;
        duration: number | string | null;
        width: number | null;
        height: number | null;
        words: { text: string; start: number; end: number }[] | null;
      };
      asset = {
        id: m.id,
        name: m.name,
        duration: m.duration === null ? null : Number(m.duration),
        width: m.width,
        height: m.height,
        // Giọng đọc: mốc từng chữ (giây từ đầu file) — editor dựng phụ đề voiceover từ đây.
        words: m.words,
        url: await signedObjectUrl("media", m.storage_path.replace(/^media\//, "")),
      };
    }
  }
  return { ...generationView(row), asset };
});
