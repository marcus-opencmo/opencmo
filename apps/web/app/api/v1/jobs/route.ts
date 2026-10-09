import { withApi } from "@/lib/api/handler";
import { createClipJob, createClipJobInput } from "@/lib/clipping/create";

export const dynamic = "force-dynamic";

/**
 * Route cũ tạo job (CMO, API ngoài). Cùng một đường với panel Clips của editor
 * (`/api/v1/editor/clipping`): link phải có `ownership_confirmed` (G1-b).
 */
export const POST = withApi({ body: createClipJobInput }, async ({ supabase, user, body }) => createClipJob(supabase, user.id, body));
