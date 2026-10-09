import { ApiError } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";
import { jobRowOrThrow } from "@/lib/api/projects";

export const dynamic = "force-dynamic";

export const GET = withApi({}, async ({ supabase, params }) => {
  // Đọc job trước: không có nó thì là "Project not found." chứ không phải
  // "chưa có transcript" — hai câu nói hai chuyện khác nhau với người dùng.
  await jobRowOrThrow(supabase, params.id);

  const { data } = await supabase
    .from("artifacts")
    .select("version, data")
    .eq("job_id", params.id)
    .eq("kind", "transcript")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) {
    throw new ApiError(
      404,
      "This video was processed before transcripts were saved. " +
        "Process it again to edit its captions.",
    );
  }
  return { artifact_version: data.version, transcript: data.data };
});
