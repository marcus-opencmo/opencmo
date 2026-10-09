import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { CmoView } from "@/components/cmo/CmoView";
import { CmoWorkspace } from "@/components/cmo/workspace/CmoWorkspace";
import { loadWorkspace } from "@/lib/cmo/load-workspace";
import { loadCmoState } from "@/lib/cmo/state";
import { createServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "AI CMO" };

type Params = { site?: string; url?: string; source?: string; count?: string; length?: string };

/**
 * Trang chính sau đăng nhập = AI CMO. Chưa có document thì là màn onboarding
 * (nhập website); có rồi là workspace 4 cột.
 *
 * Link cũ trỏ `/app?url=…` / `?source=upload` (tạo clip) chuyển sang tab Clips của editor
 * (G1-c) giữ nguyên tham số.
 */
export default async function CmoHome({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  if (params.url || params.source || params.count || params.length) {
    const keep = new URLSearchParams({ panel: "clips" });
    for (const key of ["url", "count", "length"] as const) if (params[key]) keep.set(key, params[key]!);
    redirect(`/app/editor?${keep.toString()}`);
  }

  const supabase = await createServerClient();
  const site = typeof params.site === "string" ? params.site.slice(0, 300) : "";
  const state = await loadCmoState(supabase);
  if (Object.keys(state.documents).length === 0) return <CmoView initial={state} site={site} />;
  return <CmoWorkspace initial={await loadWorkspace(supabase)} />;
}
