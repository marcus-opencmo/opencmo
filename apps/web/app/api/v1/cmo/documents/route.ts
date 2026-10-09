import { withApi } from "@/lib/api/handler";
import { loadCmoState } from "@/lib/cmo/state";

export const dynamic = "force-dynamic";

export const GET = withApi({}, async ({ supabase }) => loadCmoState(supabase));
