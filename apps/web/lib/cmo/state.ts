import "server-only";

import type { SupabaseClient } from "@/lib/api/handler";

import { DOCUMENT_KINDS, type DocumentKind } from "./documents";

export type DocumentRow = {
  id: string;
  kind: DocumentKind;
  version: number;
  body: Record<string, unknown>;
  created_by: "agent" | "user";
  created_at: string;
};

export type RunRow = {
  id: string;
  kind: "onboard";
  status: "running" | "done" | "failed";
  input: { site?: string };
  error: string | null;
  created_at: string;
};

export type CmoState = { documents: Partial<Record<DocumentKind, DocumentRow>>; lastRun: RunRow | null };

/** Bản mới nhất của từng document + lượt onboarding gần nhất. RLS lọc theo người dùng. */
export async function loadCmoState(supabase: SupabaseClient): Promise<CmoState> {
  const [{ data: docs }, { data: runs }] = await Promise.all([
    supabase.from("marketing_documents_latest").select("id, kind, version, body, created_by, created_at"),
    supabase.from("cmo_runs").select("id, kind, status, input, error, created_at").order("created_at", { ascending: false }).limit(1),
  ]);
  const documents: CmoState["documents"] = {};
  for (const row of (docs ?? []) as DocumentRow[]) {
    if (DOCUMENT_KINDS.includes(row.kind)) documents[row.kind] = row;
  }
  return { documents, lastRun: ((runs ?? [])[0] as RunRow | undefined) ?? null };
}
