import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { CmoView } from "@/components/cmo/CmoView";
import { CmoWorkspace } from "@/components/cmo/workspace/CmoWorkspace";
import { Dashboard } from "@/components/dashboard/Dashboard";
import { UI_V2 } from "@/lib/screens/flag";
import { loadWorkspace } from "@/lib/cmo/load-workspace";
import { loadCmoState } from "@/lib/cmo/state";
import { createServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "AI CMO" };

type Params = { site?: string; url?: string; source?: string; count?: string; length?: string };

/**
 * The home page after sign-in = AI CMO. Without documents it is onboarding (enter a website);
 * with them, the 4-column workspace.
 *
 * Old clip-making links (`/app?url=…`, `?source=upload`) land on the editor's Upload tab. A link
 * is never imported, so `url` is dropped.
 */
export default async function CmoHome({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  if (params.url || params.source || params.count || params.length) {
    redirect("/app/editor?panel=upload");
  }

  const supabase = await createServerClient();
  const site = typeof params.site === "string" ? params.site.slice(0, 300) : "";
  const state = await loadCmoState(supabase);

  // v2: a founder with no documents starts at Setup (S13), with the website they typed on the landing page; the
  // Dashboard reads its own data client-side.
  if (UI_V2) {
    if (Object.keys(state.documents).length === 0) redirect(site ? `/app/setup?site=${encodeURIComponent(site)}` : "/app/setup");
    return <Dashboard />;
  }

  if (Object.keys(state.documents).length === 0) return <CmoView initial={state} site={site} />;
  return <CmoWorkspace initial={await loadWorkspace(supabase)} />;
}
