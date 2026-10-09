import { ApiError } from "@/lib/api/errors";
import { clipContext } from "@/lib/api/clips";
import { notFound, withApi } from "@/lib/api/handler";
import { projectDocument } from "@/lib/editor/document";

export const dynamic = "force-dynamic";

type RevisionRow = {
  id: string;
  number: number;
  kind: "export" | "agent" | "manual";
  label: string | null;
  created_at: string;
  document?: unknown;
};

/**
 * Lịch sử của một project editor: bản gốc engine sinh ra, cộng mọi bản đã
 * export và mọi checkpoint (`editor_revisions`, bất biến; `kind` nói bản nào
 * là bản nào — `20260925090000_editor_checkpoints.sql`).
 *
 * Danh sách không kèm document — mỗi bản tới 256KB, và dialog chỉ cần ngày
 * tháng. `?id=<uuid>` hoặc `?id=original` trả document của MỘT bản để khôi
 * phục; khôi phục là một lượt lưu thường ở client, đi qua khoá lạc quan như mọi
 * lượt lưu khác.
 */
export const GET = withApi({}, async ({ supabase, request }) => {
  const params = new URL(request.url).searchParams;
  const clipId = params.get("clip_id") ?? "";
  if (!clipId) throw new ApiError(422, "clip_id: Required");
  await clipContext(supabase, clipId);

  const id = params.get("id");
  if (id === "original") {
    const { data } = await supabase
      .from("editor_projects")
      .select("generated_document")
      .eq("clip_id", clipId)
      .maybeSingle();
    const row = data as { generated_document: unknown } | null;
    if (row?.generated_document == null) throw notFound("This project has no original version to go back to.");
    return { id: "original", document: projectDocument({ document: row.generated_document }) };
  }
  if (id !== null) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError(422, "id: Invalid");
    const { data } = await supabase
      .from("editor_revisions")
      .select("id, number, kind, label, created_at, document")
      .eq("clip_id", clipId)
      .eq("id", id)
      .maybeSingle();
    if (!data) throw notFound("That version is no longer available.");
    const revision = data as RevisionRow & { document: unknown };
    return { ...revision, document: projectDocument(revision) };
  }

  const [{ data: project }, { data: revisions }] = await Promise.all([
    supabase
      .from("editor_projects")
      .select("generated_document, updated_at")
      .eq("clip_id", clipId)
      .maybeSingle(),
    supabase
      .from("editor_revisions")
      .select("id, number, kind, label, created_at")
      .eq("clip_id", clipId)
      .order("number", { ascending: false })
      .limit(50),
  ]);

  return {
    original: (project as { generated_document: unknown } | null)?.generated_document != null,
    revisions: (revisions ?? []) as RevisionRow[],
  };
});
