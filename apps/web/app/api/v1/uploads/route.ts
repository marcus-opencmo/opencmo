import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, withApi } from "@/lib/api/handler";
import { rejectReason, slugifyFilename, SOURCE_PREFIX, storageExtension } from "@/lib/upload";

export const dynamic = "force-dynamic";

const body = z.object({
  name: z.string().min(1).max(300),
  size: z.number().int().positive(),
  kind: z.enum(["source", "media"]),
  project_id: z.string().uuid().optional(),
});

/**
 * Cấp phép một lượt upload — KHÔNG nhận file.
 *
 * File đi thẳng từ trình duyệt lên Supabase Storage bằng TUS (ràng buộc web số
 * 5). Route này chỉ quyết định object name; quyền ghi thật do policy Storage
 * giữ, và nó so `<uid>` ở segment đầu.
 *
 * Kiểm `rejectReason` ở đây là để người dùng biết SỚM, trước khi đẩy 300MB lên
 * mạng. Nó không phải rào chắn: bucket có `file_size_limit` và `allowed_mime_types`
 * riêng, và worker probe lại file trước khi dùng.
 */
export const POST = withApi(
  { body, rateLimit: { bucket: "uploads", limit: 30, windowSeconds: 3600 } },
  async ({ supabase, user, body }) => {
    const reason = rejectReason(body.name, body.size);
    if (reason) throw new ApiError(422, reason);

    let bucket: "sources" | "media";
    let objectName: string;
    let projectId: string | null = null;
    if (body.kind === "source") {
      bucket = "sources";
      objectName =
        `${user.id}/${slugifyFilename(body.name)}__${crypto.randomUUID()}.` +
        storageExtension(body.name);
    } else {
      if (!body.project_id) throw new ApiError(422, "project_id: B-roll needs a project.");
      bucket = "media";
      objectName = `${user.id}/${body.project_id}/${crypto.randomUUID()}.${storageExtension(body.name)}`;
      projectId = body.project_id;
    }

    await rpcOrThrow(supabase, "reserve_upload", {
      p_bucket: bucket,
      p_object_name: objectName,
      p_size: body.size,
      p_content_type: "video/x-upload",
      p_project_id: projectId,
    });
    return {
      bucket,
      objectName,
      source: body.kind === "source" ? `${SOURCE_PREFIX}${objectName}` : null,
    };
  },
);
