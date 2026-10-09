import { z } from "zod";

import { rpcOrThrow, withApi } from "@/lib/api/handler";
import { projectDetail } from "@/lib/api/projects";

export const dynamic = "force-dynamic";

export const GET = withApi({}, async ({ supabase, params }) =>
  projectDetail(supabase, params.id),
);

const patch = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  favorite: z.boolean().optional(),
});

export const PATCH = withApi(
  { body: patch, rateLimit: { bucket: "project-write", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, params, body }) => {
    if (body.title !== undefined) {
      await rpcOrThrow(supabase, "rename_project", {
        p_job_id: params.id,
        p_name: body.title,
      });
    }
    if (body.favorite !== undefined) {
      await rpcOrThrow(supabase, "set_project_pinned", {
        p_job_id: params.id,
        p_pinned: body.favorite,
      });
    }
    return projectDetail(supabase, params.id);
  },
);

/** D4 ghi manifest bền vững trước cascade, nên hard delete đã không còn mồ côi Storage. */
export const DELETE = withApi(
  { rateLimit: { bucket: "project-write", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, params }) => {
    const deleted = await rpcOrThrow<boolean>(supabase, "delete_job", { p_job_id: params.id });
    return { deleted };
  },
);
