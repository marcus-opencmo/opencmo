import { SOCIAL, type SocialKey } from "./icons";

/** Logo "Open O": vòng hở 76° + chấm terracotta, dựng trên lưới 64. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className="lv-logo">
      <path d="M44.97 43.70A19 19 0 1 1 44.97 20.30" fill="none" stroke="currentColor" strokeWidth="8" />
      <circle cx="49" cy="32" r="5" fill="#E2704A" />
    </svg>
  );
}

/** Logo nền tảng trắng trên ô màu của hãng. `size` là cạnh ô; logo bằng nửa cạnh. */
export function SocialTile({ k, size, radius, title = true }: { k: SocialKey; size: number; radius: number; title?: boolean }) {
  const s = SOCIAL[k];
  return (
    <span
      className="lv-social"
      title={title ? s.name : undefined}
      style={{ width: size, height: size, borderRadius: radius, background: s.color }}
    >
      <svg viewBox="0 0 24 24" width={Math.round(size / 2)} height={Math.round(size / 2)} aria-hidden="true">
        <path d={s.d} fill="#fff" />
      </svg>
    </span>
  );
}

/** Icon nét Lucide. */
export function LineIcon({ d, size = 20, color = "#f2946f", width = 1.8 }: { d: string; size?: number; color?: string; width?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="lv-icon"
    >
      <path d={d} />
    </svg>
  );
}
