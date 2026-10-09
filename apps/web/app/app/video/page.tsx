import { redirect } from "next/navigation";

/**
 * Trang "New clips" cũ. Cắt clip giờ là tab Clips trong editor (G1-c): link cũ, bookmark và
 * nút "Try again with longer clips" vẫn tới đúng chỗ, mang theo link/tuỳ chọn điền sẵn.
 */
export default async function NewClipsPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string; source?: string; count?: string; length?: string }>;
}) {
  redirect(clipsHref(await searchParams));
}

function clipsHref(params: { url?: string; count?: string; length?: string }): string {
  const keep = new URLSearchParams({ panel: "clips" });
  for (const key of ["url", "count", "length"] as const) if (params[key]) keep.set(key, params[key]!);
  return `/app/editor?${keep.toString()}`;
}
