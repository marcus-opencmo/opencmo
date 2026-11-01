/** The OpenCMO mark from the frames: an ink arc and a brand dot. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M44.97 43.70A19 19 0 1 1 44.97 20.30" fill="none" stroke="var(--v2-ink)" strokeWidth="8" />
      <circle cx="49" cy="32" r="5" fill="var(--v2-brand)" />
    </svg>
  );
}
