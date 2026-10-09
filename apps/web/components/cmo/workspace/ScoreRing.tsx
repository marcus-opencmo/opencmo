/** Vòng điểm Lighthouse: ≥90 xanh, 50–89 vàng, <50 đỏ — đúng ngưỡng của PageSpeed. */

export function ScoreRing({ value, label }: { value: number; label: string }) {
  const r = 17;
  const c = 2 * Math.PI * r;
  const tone = value >= 90 ? "is-good" : value >= 50 ? "is-ok" : "is-bad";
  return (
    <figure className={`cmo-ring ${tone}`}>
      <svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
        <circle cx="22" cy="22" r={r} className="cmo-ring-track" />
        <circle cx="22" cy="22" r={r} className="cmo-ring-arc" strokeDasharray={`${(value / 100) * c} ${c}`} transform="rotate(-90 22 22)" />
        <text x="22" y="22" dominantBaseline="central" textAnchor="middle">{value}</text>
      </svg>
      <figcaption>
        <span className="sr-only">{value} </span>
        {label}
      </figcaption>
    </figure>
  );
}
