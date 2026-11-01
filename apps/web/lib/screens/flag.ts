import { notFound } from "next/navigation";

/**
 * The v2 UI flag, the only copy: everything of the redesign is behind it; with it unset the app is exactly today's.
 * `NEXT_PUBLIC_` so it is inlined at build time and the shell can branch on the client too; production leaves it
 * unset until release (U9).
 */
export const UI_V2 = process.env.NEXT_PUBLIC_OPENCMO_UI === "v2";

/** Server pages and routes of the redesign call this first: with the flag off they 404, as if they did not exist. */
export function requireUiV2(): void {
  if (!UI_V2) notFound();
}
