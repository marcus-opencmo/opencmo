import type { ReactNode } from "react";

/** Rail icons, shown when the rail is the 56 px strip. Square caps and joins, like the landing's pixel marks. */
const PATHS: Record<string, ReactNode> = {
  "/app": (
    <>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </>
  ),
  "/app/analytics": <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  "/app/brain": (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v16M4 12h16" />
    </>
  ),
  "/app/library": <path d="M4 4h6v16H4zM10 4h4v16h-4zM15 5l4-1 3 15-4 1z" />,
  "/app/research": (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 6 6" />
    </>
  ),
  "/app/writer": <path d="M4 20h4L20 8l-4-4L4 16zM14 6l4 4" />,
  "/app/studio": (
    <>
      <rect x="3" y="5" width="18" height="14" />
      <path d="m10 9 5 3-5 3z" />
    </>
  ),
  "/app/sales": (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  "/app/schedule": <path d="M3 5h18v16H3zM3 10h18M8 3v4M16 3v4" />,
  "/app/editor": (
    <>
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M8 16 19 4M16 16 5 4" />
    </>
  ),
  "/app/settings": (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3" />
    </>
  ),
};

export function NavIcon({ href }: { href: string }) {
  return (
    <svg className="v2-rail-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" aria-hidden="true">
      {PATHS[href] ?? <rect x="5" y="5" width="14" height="14" />}
    </svg>
  );
}
