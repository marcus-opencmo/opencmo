import { withApi } from "@/lib/api/handler";
import { kickCmoQueue } from "@/lib/cmo/jobs/start";
import { loadWorkspace } from "@/lib/cmo/load-workspace";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Màn AI CMO tự làm mới khi có lượt đang chạy. Còn lượt `queued` (function trước
 * chết trước khi kịp nhận) thì vét luôn ở đây, không chờ cron sáng mai.
 */
export const GET = withApi({}, async ({ supabase }) => {
  const workspace = await loadWorkspace(supabase);
  const stuck = workspace.log.find((l) => l.status === "queued");
  if (stuck) kickCmoQueue(stuck.id);
  return workspace;
});
