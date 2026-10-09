"use client";

/**
 * Cột Brief (bộ não dùng chung) và cột Results (Social · SEO · Links). Tài liệu mở trong sheet ngay trên dashboard
 * (`DocumentSheet`, `?doc=`), không chuyển trang; phần nào chưa có thì nói lúc nào nó có,
 * không có chữ "coming soon".
 */

import Link from "next/link";
import { useState } from "react";

import { Icon, type IconName } from "@/components/icons";
import { DOCUMENT_KINDS, DOCUMENTS } from "@/lib/cmo/documents";
import { DEPARTMENT_LABEL, type CalendarItem, type InsightView, type Metrics, type SeoMetrics, type Workspace } from "@/lib/cmo/workspace";

import type { Actions } from "./actions";
import { USED_BY, type DocView } from "./DocumentSheet";

import { PanelHead } from "./PanelHead";
import { ScoreRing } from "./ScoreRing";
import { ago, day } from "./time";

const hostOf = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "");

export function ContextPanel({ ws, actions, onCollapse }: { ws: Workspace; actions: Actions; onCollapse?: () => void }) {
  const [planning, setPlanning] = useState(false);
  const busy = ws.log.some((l) => l.job === "W1" && (l.status === "queued" || l.status === "running"));
  async function plan() {
    setPlanning(true);
    await actions.run("plan_week");
    setPlanning(false);
  }
  const product = ws.documents.product?.body ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const competitors = (ws.documents.competitors?.body.competitors as { name?: string; website?: string }[] | undefined) ?? [];
  const about = [str(product.one_liner), str(product.description)].filter(Boolean);
  const rows: { view: DocView | null; href?: string; icon: IconName; title: string; ready: boolean; hint: string; usedBy: string[] }[] = [
    ...DOCUMENT_KINDS.map((kind) => ({
      view: kind as DocView,
      icon: "file-text" as IconName,
      title: DOCUMENTS[kind].title,
      ready: Boolean(ws.documents[kind]),
      hint: "Build your marketing plan to fill this in",
      usedBy: USED_BY[kind],
    })),
    { view: "calendar", icon: "calendar", title: "Content calendar", ready: ws.calendar.length > 0, hint: "Fills in when the CMO plans your first week", usedBy: USED_BY.calendar },
    // Brand kit là màn công cụ riêng của Video (editor đọc nó), không phải văn bản để đọc.
    { view: null, href: "/app/brand", icon: "palette", title: "Design Guide", ready: true, hint: "", usedBy: ["Video Agent", "Editor"] },
  ];
  /** Chip gợi ý mang `?doc=<kind>` (hoặc `#kind` của bản cũ): mở đúng tài liệu trong sheet. */
  const docOf = (href: string): DocView => (href.match(/[?&]doc=([a-z_]+)/)?.[1] ?? href.match(/#([a-z_]+)/)?.[1] ?? "product") as DocView;

  return (
    <section className="cmo-panel" aria-labelledby="cmo-context-title">
      <PanelHead id="cmo-context-title" icon="layers" title="Brief" onCollapse={onCollapse} />
      <div className="cmo-scroll">
        <div className="cmo-product">
          <div className="cmo-product-top">
            <span className="cmo-project-logo is-lg" aria-hidden="true">{ws.project.name.slice(0, 2).toUpperCase()}</span>
            <strong>{str(product.name) || ws.project.name}</strong>
            <button type="button" className="cmo-icon-btn" onClick={() => actions.openDoc("product")} aria-label="Open product information">
              <Icon name="pencil" size={15} />
            </button>
          </div>
          {ws.project.category ? (
            <span className="cmo-tag"><Icon name="tag" size={12} /> {ws.project.category}</span>
          ) : null}
          {ws.suggestions.length ? (
            <div className="cmo-chips">
              {ws.suggestions.map((s) => (
                <button key={s.label} type="button" onClick={() => actions.openDoc(docOf(s.href))} className="cmo-chip">
                  <span className="cmo-gem" aria-hidden="true" /> {s.label}
                </button>
              ))}
            </div>
          ) : null}
          {about.length ? <p className="cmo-about">{about.join(" ")}</p> : null}
        </div>

        <div className="cmo-block">
          <div className="cmo-block-head">
            <h3>Documents</h3>
            <button type="button" className="cmo-icon-btn" onClick={() => actions.openDoc("product")} aria-label="Open marketing plan">
              <Icon name="plus" size={16} />
            </button>
          </div>
          <ul className="cmo-doc-rows">
            {rows.map((row) => (
              <li key={row.title}>
                {row.ready && row.view ? (
                  <button type="button" onClick={() => actions.openDoc(row.view!)} data-testid={`cmo-docrow-${row.view}`}>
                    <Icon name={row.icon} size={16} />
                    <span className="cmo-doc-name">
                      {row.title}
                      <small>Used by {row.usedBy.join(" · ")}</small>
                    </span>
                    <Icon name="chevron-right" size={15} />
                  </button>
                ) : row.ready && row.href ? (
                  <Link href={row.href}>
                    <Icon name={row.icon} size={16} />
                    <span className="cmo-doc-name">
                      {row.title}
                      <small>Used by {row.usedBy.join(" · ")}</small>
                    </span>
                    <Icon name="chevron-right" size={15} />
                  </Link>
                ) : (
                  <span className="is-locked" title={row.hint}>
                    <Icon name={row.icon} size={16} />
                    <span>{row.title}</span>
                    <Icon name="lock" size={14} />
                    <span className="sr-only">{row.hint}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="cmo-block">
          <div className="cmo-block-head">
            <h3>Competitors</h3>
            <button type="button" className="cmo-icon-btn" onClick={() => actions.openDoc("competitors")} aria-label="Open competitor analysis">
              <Icon name="pencil" size={15} />
            </button>
          </div>
          {competitors.length ? (
            <ul className="cmo-comp-grid">
              {competitors.slice(0, 8).map((c, i) => {
                const label = c.website ? hostOf(c.website) : c.name ?? "";
                return (
                  <li key={i} title={c.name}>
                    <span className="cmo-comp-logo" aria-hidden="true">
                      {(c.name ?? label).slice(0, 1).toUpperCase()}
                    </span>
                    <span>{label}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="cmo-muted">None listed. Add the alternatives your customers compare you with.</p>
          )}
        </div>

        <div className="cmo-block">
          <div className="cmo-block-head">
            <h3>This week</h3>
            {ws.calendar.length ? (
              <button type="button" className="text-button cmo-replan" onClick={plan} disabled={planning || busy}>
                {busy ? "Planning…" : "Replan"}
              </button>
            ) : null}
          </div>
          {ws.calendar.length ? (
            <ol className="cmo-calendar">
              {ws.calendar.map((item) => <CalendarRow key={item.id} item={item} actions={actions} />)}
            </ol>
          ) : (
            <div className="cmo-plan-empty">
              <p className="cmo-muted">Your CMO plans the next seven days from your strategy, one line of reasoning per item. Nothing is posted.</p>
              <button type="button" className="primary-button" onClick={plan} disabled={planning || busy} data-testid="cmo-plan-week">
                {busy ? "Planning your week…" : "Plan my week"}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function CalendarRow({ item, actions }: { item: CalendarItem; actions: Actions }) {
  const [editing, setEditing] = useState(false);
  const [idea, setIdea] = useState(item.idea);
  const [dayValue, setDayValue] = useState(item.day.slice(0, 10));
  const [busy, setBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const last = new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);

  if (editing) {
    return (
      <li className="is-editing">
        <form
          className="cmo-cal-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            if (await actions.calendar(item.id, { action: "edit", idea: idea.trim(), day: dayValue })) setEditing(false);
            setBusy(false);
          }}
        >
          <label htmlFor={`cal-idea-${item.id}`} className="sr-only">Idea</label>
          <input id={`cal-idea-${item.id}`} value={idea} maxLength={300} onChange={(e) => setIdea(e.target.value)} required />
          <label htmlFor={`cal-day-${item.id}`} className="sr-only">Day</label>
          <input id={`cal-day-${item.id}`} type="date" value={dayValue} min={today} max={last} onChange={(e) => setDayValue(e.target.value)} required />
          <div className="cmo-cal-form-actions">
            <button type="button" className="text-button" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy || !idea.trim()}>Save</button>
          </div>
        </form>
      </li>
    );
  }
  return (
    <li>
      <span className="cmo-cal-day" suppressHydrationWarning>{day(item.day)}</span>
      <span className={`cmo-dept is-${item.department}`}>{DEPARTMENT_LABEL[item.department]}</span>
      <span className="cmo-cal-idea">{item.idea}</span>
      {item.reason ? <small className="cmo-cal-why">{item.reason}</small> : null}
      {item.clipsHref ? (
        <a className="cmo-cal-clips" href={item.clipsHref} data-testid="cmo-make-clips">
          Make clips
        </a>
      ) : null}
      {item.editable ? (
        <span className="cmo-cal-tools">
          <button type="button" className="cmo-icon-btn" aria-label={`Edit "${item.idea}"`} onClick={() => setEditing(true)}>
            <Icon name="pencil" size={14} />
          </button>
          <button
            type="button"
            className="cmo-icon-btn"
            aria-label={`Remove "${item.idea}"`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await actions.calendar(item.id, { action: "remove" });
              setBusy(false);
            }}
          >
            <Icon name="x" size={14} />
          </button>
        </span>
      ) : null}
    </li>
  );
}

type Tab = "social" | "seo" | "links";
const TABS: { id: Tab; label: string }[] = [
  { id: "social", label: "Social" },
  { id: "seo", label: "SEO" },
  { id: "links", label: "Links" },
];

export function AnalyticsPanel({ ws, onCollapse, onToast }: { ws: Workspace; onCollapse?: () => void; onToast: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>("social");
  const live = ws.live.metrics || ws.live.seo || ws.demo;
  // SEO / Links chưa có nguồn dữ liệu thật: không hiện tab có nút chỉ bật toast (luật 1, không bán
  // thứ chưa có). Bản demo dev vẫn thấy để làm giao diện.
  const tabs = TABS.filter((t) => t.id === "social" || ws.demo || (t.id === "seo" ? ws.live.seo : ws.live.links));
  return (
    <section className="cmo-panel" aria-labelledby="cmo-analytics-title">
      <PanelHead id="cmo-analytics-title" icon="chart-column" title="Results" live={live} onCollapse={onCollapse} />
      <div className="cmo-scroll">
        <div className="cmo-tabs" role="tablist" aria-label="Results">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {tab === "social" ? (
          <>
            <SocialTab m={ws.metrics} />
            <InsightBox insight={ws.insight} />
          </>
        ) : null}
        {tab === "seo" ? <SeoTab seo={ws.seo} demo={ws.demo} onToast={onToast} /> : null}
        {tab === "links" ? <LinksTab ws={ws} /> : null}
      </div>
    </section>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 240;
  const h = 64;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const points = values.map((v, i) => [i * step, h - 4 - (v / max) * (h - 12)] as const);
  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  return (
    <svg className="cmo-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`Views per day, last ${values.length} days`}>
      <path d={`${line} L${w} ${h} L0 ${h} Z`} className="cmo-spark-area" />
      <path d={line} className="cmo-spark-line" fill="none" vectorEffect="non-scaling-stroke" />
      {last ? <circle cx={last[0]} cy={last[1]} r="3.5" className="cmo-spark-dot" /> : null}
    </svg>
  );
}

const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString("en-US"));

/** "What works now" (W7): hook đang vượt baseline của đối thủ, mỗi cái kèm link bài gốc. */
function InsightBox({ insight }: { insight: InsightView | null }) {
  if (!insight) return null;
  return (
    <div className="cmo-card-box" data-testid="cmo-insight">
      <h3 className="cmo-box-title">What works now</h3>
      <ul className="cmo-insight">
        {insight.hooks.map((hook) => (
          <li key={hook.url}>
            <strong>{hook.pattern}</strong> <span className="cmo-muted">{hook.lift}x</span>
            <small>
              “{hook.example}” ·{" "}
              <a href={hook.url} target="_blank" rel="noopener noreferrer nofollow">
                source
              </a>
            </small>
          </li>
        ))}
      </ul>
      <small className="cmo-muted" suppressHydrationWarning>
        Competitor research · {new Date(insight.measuredAt).toLocaleDateString()}
      </small>
    </div>
  );
}

function SocialTab({ m }: { m: Metrics | null }) {
  if (!m) {
    return (
      <div className="cmo-empty-card">
        <p><strong>No numbers yet.</strong></p>
        <p>Mark a post as posted (paste its link, or add your X handle to Product Information) and its views, likes and replies show up here the next morning.</p>
      </div>
    );
  }
  return (
    <>
      <p className="cmo-eyebrow">Last {m.windowDays} days</p>
      <dl className="cmo-tiles">
        {m.tiles.map((t) => (
          <div key={t.label} className="cmo-tile">
            <dt>{t.label}</dt>
            <dd>
              <span className="cmo-tile-num">{fmt(t.value)}</span>
              {t.change !== null ? <span className={`cmo-change ${t.change >= 0 ? "is-up" : "is-down"}`}>{t.change >= 0 ? "+" : ""}{t.change}%</span> : null}
            </dd>
            <small>{t.hint}</small>
          </div>
        ))}
      </dl>
      <div className="cmo-card-box">
        <h3 className="cmo-box-title">Views per day</h3>
        <Sparkline values={m.views} />
      </div>
      {m.top ? (
        <div className="cmo-card-box">
          <h3 className="cmo-box-title">Top post</h3>
          <p className="cmo-top-title">{m.top.title}</p>
          <small className="cmo-muted">{m.top.platform} · {fmt(m.top.views)} views</small>
        </div>
      ) : null}
    </>
  );
}

const SCORE_LABELS = [
  ["performance", "Performance"],
  ["accessibility", "Accessibility"],
  ["bestPractices", "Best Practices"],
  ["seo", "SEO"],
] as const;

function SeoTab({ seo, demo, onToast }: { seo: SeoMetrics | null; demo: boolean; onToast: (message: string) => void }) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const connect = (name: string) => onToast(demo ? `Demo: connecting ${name} is not part of the demo` : `${name} is not connected yet`);
  return (
    <>
      <div className="cmo-block-head"><h3>Connect Google</h3></div>
      <div className="cmo-connect">
        {[
          { name: "Google Analytics", sub: "Traffic & behavior", on: seo?.google.analytics ?? false, kind: "bars" },
          { name: "Search Console", sub: "Search rankings", on: seo?.google.searchConsole ?? false, kind: "line" },
        ].map((g) => (
          <div key={g.name} className="cmo-connect-card">
            <p><b>{g.name}</b><small>{g.sub}</small></p>
            <div className={`cmo-connect-art is-${g.kind}`} aria-hidden="true">
              <span className="cmo-connect-lock"><Icon name="lock" size={13} /></span>
            </div>
            <button
              type="button"
              className="primary-button"
              disabled={!demo}
              title={demo ? undefined : "Google connection is not available yet"}
              onClick={() => connect(g.name)}
            >
              {g.on ? "Connected" : "Connect"}
            </button>
          </div>
        ))}
      </div>

      {seo ? (
        <>
          <p className="cmo-muted" suppressHydrationWarning>Last audited {ago(seo.auditedAt)}</p>
          <div className="cmo-card-box">
            <h3 className="cmo-box-title">PageSpeed Scores</h3>
            <p className="cmo-muted">Lighthouse scores from Google</p>
            {(["mobile", "desktop"] as const).map((d) => (
              <div key={d} className="cmo-rings">
                <p className="cmo-eyebrow">{d}</p>
                <div className="cmo-rings-row">
                  {SCORE_LABELS.map(([key, label]) => <ScoreRing key={key} value={seo.pagespeed[d][key]} label={label} />)}
                </div>
              </div>
            ))}
          </div>
          <div className="cmo-card-box">
            <h3 className="cmo-box-title">Core Web Vitals</h3>
            <p className="cmo-muted">Lighthouse lab metrics</p>
            <div className="cmo-tabs is-small" role="tablist" aria-label="Device">
              {(["desktop", "mobile"] as const).map((d) => (
                <button key={d} type="button" role="tab" aria-selected={device === d} onClick={() => setDevice(d)}>
                  {d === "desktop" ? "Desktop" : "Mobile"}
                </button>
              ))}
            </div>
            <dl className="cmo-vitals">
              {seo.vitals[device].map((v) => (
                <div key={v.label} className={v.pass ? "is-pass" : "is-fail"}>
                  <dt>{v.label}</dt>
                  <dd>{v.value}</dd>
                  <small>{v.pass ? "Pass" : "Needs work"}</small>
                </div>
              ))}
            </dl>
          </div>
        </>
      ) : (
        <div className="cmo-empty-card">
          <p><strong>No audit yet.</strong></p>
          <p>Page speed and Core Web Vitals for your website show up here after the first audit.</p>
        </div>
      )}
    </>
  );
}

function LinksTab({ ws }: { ws: Workspace }) {
  if (!ws.links?.length) {
    return (
      <div className="cmo-empty-card">
        <p><strong>No links yet.</strong></p>
        <p>Your site&apos;s pages and the places that link to you show up here after the first audit.</p>
      </div>
    );
  }
  return (
    <ul className="cmo-links">
      {ws.links.map((l) => (
        <li key={l.url + l.title}>
          <Icon name={l.kind === "page" ? "file-text" : "link"} size={15} />
          <span>
            <b>{l.title}</b>
            <small>{hostOf(l.url)}{l.url.replace(/^https?:\/\/[^/]+/, "").replace(/^\/$/, "")} · {l.note}</small>
          </span>
          <a className="cmo-icon-btn" href={l.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${l.title}`}>
            <Icon name="external-link" size={14} />
          </a>
        </li>
      ))}
    </ul>
  );
}
