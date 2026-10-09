import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { clipContext } from "@/lib/api/clips";
import { withApi } from "@/lib/api/handler";
import { readEditorProject } from "@/lib/editor/apply";
import { checkedDocument, saveDocument } from "@/lib/editor/document";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Document của project editor (spec editor-rewrite §9) — đường đọc/ghi duy
 * nhất của editor. PUT kiểm bằng CÙNG `validate()` của clip-doc với mọi đường
 * ghi khác.
 *
 * Cả hai trả `document_hash` (SQL tính): Export chụp revision bằng
 * `snapshot_editor_revision`, hàm đó đối chiếu đúng chuỗi này.
 */
export const GET = withApi({}, async ({ supabase, request }) => {
  const clipId = new URL(request.url).searchParams.get("clip_id") ?? "";
  if (!clipId) throw new ApiError(422, "clip_id: Required");
  await clipContext(supabase, clipId);
  const project = await readEditorProject(supabase, clipId);
  return {
    clip_id: project.clip_id,
    version: project.version,
    document: project.document,
    document_hash: project.document_hash,
  };
});

const body = z.object({
  clip_id: z.string().uuid(),
  expected_version: z.number().int().min(1),
  document: z.unknown(),
  manifest: z.unknown().optional(),
});

export const PUT = withApi(
  { body, rateLimit: { bucket: "editor-write", limit: 240, windowSeconds: 60 } },
  async ({ supabase, body }) => {
    await clipContext(supabase, body.clip_id);
    const saved = await saveDocument(supabase, body.clip_id, body.expected_version, checkedDocument(body.document), {
      manifest: body.manifest ?? null,
    });
    return {
      clip_id: saved.clip_id,
      version: saved.version,
      document: saved.document,
      document_hash: saved.document_hash,
    };
  },
);
