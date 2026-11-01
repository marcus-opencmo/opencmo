import { notFound, withApi } from "@/lib/api/handler";
import { UI_V2 } from "@/lib/screens/flag";
import { loadRailStatus } from "@/lib/screens/load";
import { RailStatusSchema } from "@/lib/screens/rail";

export const dynamic = "force-dynamic";

/** The rail's status lines under Schedule and Analytics (P6 F14), under the founder's session. */
export const GET = withApi({}, async ({ supabase, user }) => {
  if (!UI_V2) throw notFound();
  return RailStatusSchema.parse(await loadRailStatus({ supabase, userId: user.id }));
});
