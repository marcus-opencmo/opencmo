import "server-only";

/**
 * Signed URLs for Studio cards. A snapshot holds storage paths (a URL would change the hash on every read); the card
 * the founder looks at needs pictures, so the loader signs them here, under the founder's own session (RLS).
 * A path that will not sign leaves its picture empty; the card still shows and still decides.
 */

import type { SupabaseClient } from "@/lib/api/handler";

import type { ApprovalCard } from "./approval-card";
import type { ApprovalRow } from "./cards";

const SECONDS = 3600;

export async function sign(supabase: SupabaseClient, bucket: "media" | "exports", paths: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter((p) => p && !p.includes("..")))];
  if (!unique.length) return new Map();
  const { data } = await supabase.storage.from(bucket).createSignedUrls(unique, SECONDS);
  return new Map((data ?? []).flatMap((d, i) => (d?.signedUrl ? [[unique[i]!, d.signedUrl] as const] : [])));
}

const paths = (v: unknown, key: string): string[] =>
  Array.isArray(v) ? v.map((x) => (x as Record<string, unknown>)?.[key]).filter((p): p is string => typeof p === "string") : [];

/** The latest done render of each short's own edit, as `short clip id → exports path`. */
export async function shortRenders(supabase: SupabaseClient, clipIds: string[]): Promise<Map<string, string>> {
  if (!clipIds.length) return new Map();
  const { data } = await supabase
    .from("tasks")
    .select("clip_id, output_path, finished_at")
    .in("clip_id", clipIds)
    .eq("kind", "render_document")
    .eq("status", "done")
    .order("finished_at", { ascending: false });
  const out = new Map<string, string>();
  for (const t of (data ?? []) as { clip_id: string; output_path: string | null }[]) {
    if (t.output_path && !out.has(t.clip_id)) out.set(t.clip_id, t.output_path);
  }
  return out;
}

export async function signStudioCards(supabase: SupabaseClient, cards: ApprovalCard[], rows: ApprovalRow[]): Promise<ApprovalCard[]> {
  const snapshot = new Map(rows.map((r) => [r.id, r.snapshot]));
  const studio = cards.filter((c) => c.kind === "price" || c.kind === "finished_video" || c.kind === "shorts_batch" || c.kind === "slideshow");
  if (!studio.length) return cards;

  const shortClips = studio.flatMap((c) => (c.body.kind === "shorts_batch" ? c.body.shorts.flatMap((s) => (s.shortClipId ? [s.shortClipId] : [])) : []));
  const renders = await shortRenders(supabase, shortClips);
  const [media, exports] = await Promise.all([
    sign(supabase, "media", studio.flatMap((c) => (c.kind === "price" ? paths(snapshot.get(c.id)?.keyframes, "path") : []))),
    sign(supabase, "exports", [
      ...studio.flatMap((c) => {
        const p = c.kind === "finished_video" ? snapshot.get(c.id)?.render_path : null;
        return typeof p === "string" ? [p] : [];
      }),
      ...renders.values(),
      // P5: a slideshow's MP4, its PNG set and each slide's still, all in `exports`.
      ...studio.flatMap((c) => {
        if (c.kind !== "slideshow") return [];
        const s = snapshot.get(c.id);
        return [s?.mp4_path, s?.png_set_path, ...paths(s?.slides, "still_path")].filter((p): p is string => typeof p === "string");
      }),
    ]),
  ]);

  return cards.map((card) => {
    const s = snapshot.get(card.id);
    switch (card.body.kind) {
      case "price": {
        const byIndex = new Map(
          (Array.isArray(s?.keyframes) ? (s.keyframes as { index?: unknown; path?: unknown }[]) : []).map((k) => [k.index, typeof k.path === "string" ? media.get(k.path) ?? null : null]),
        );
        return { ...card, body: { ...card.body, keyframes: card.body.keyframes.map((k) => ({ ...k, thumbUrl: byIndex.get(k.index) ?? null })) } };
      }
      case "finished_video": {
        const path = typeof s?.render_path === "string" ? s.render_path : null;
        return { ...card, body: { ...card.body, previewUrl: path ? exports.get(path) ?? null : null } };
      }
      case "shorts_batch":
        return {
          ...card,
          body: {
            ...card.body,
            shorts: card.body.shorts.map((x) => {
              const path = x.shortClipId ? renders.get(x.shortClipId) : undefined;
              return { ...x, previewUrl: path ? exports.get(path) ?? null : null };
            }),
          },
        };
      case "slideshow": {
        const url = (p: unknown) => (typeof p === "string" ? exports.get(p) ?? null : null);
        const slides = Array.isArray(s?.slides) ? (s.slides as { still_path?: unknown }[]) : [];
        return {
          ...card,
          body: {
            ...card.body,
            previewUrl: url(s?.mp4_path),
            pngSetUrl: url(s?.png_set_path),
            slides: card.body.slides.map((x, i) => ({ ...x, stillUrl: url(slides[i]?.still_path) })),
          },
        };
      }
      default:
        return card;
    }
  });
}
