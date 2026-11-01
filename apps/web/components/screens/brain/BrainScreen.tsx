"use client";

import { Fragment, useState } from "react";

import { Button, ButtonLink, Chip, TableWrap, Tabs, type ChipTone } from "@/components/ui";
import type { BrainScreen as Data, Learned, Measure, OrderRow } from "@/lib/screens/brain";
import { DEPARTMENT_LABEL } from "@/lib/screens/common";

import { shortDate } from "../format";
import { ErrorNote, PageHeader, Panel, Screen, SkeletonBlocks } from "../parts";
import { TeamSteps } from "../studio/StudioScreen";
import { useTabParam } from "../useTabParam";
import { isSample, useScreen } from "../useScreen";
import { PauseButton } from "./PauseButton";

const TABS = [
  { id: "week", label: "This week" },
  { id: "memory", label: "Memory" },
  { id: "past", label: "Past weeks" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const KIND_LABEL: Record<Learned["kind"], string> = {
  lesson: "Lesson",
  rule: "Rule",
  skip_reason: "Skip reason",
  goal_result: "Goal",
  memory: "Memory",
};

const STATE_TONE: Record<OrderRow["state"], ChipTone> = {
  queued: "idle",
  running: "running",
  waiting_founder: "waiting",
  waiting_order: "idle",
  deferred: "idle",
  done: "posted",
  failed: "stuck",
  cancelled: "idle",
};

export function BrainScreen() {
  const [tab, setTab] = useTabParam<Tab>("tab", TABS.map((t) => t.id), "week");
  const [state] = useScreen("brain");
  // The founder's own pause or resume wins over what the page loaded with.
  const [pausedOverride, setPausedOverride] = useState<string | null | undefined>(undefined);
  const pausedAt = pausedOverride !== undefined ? pausedOverride : state.status === "ready" ? state.data.cmo.pausedAt : null;

  return (
    <Screen label="Brain">
      <PageHeader
        eyebrow="Brain · thinks with OpenCMO's model"
        title="The plan, the orders, what it learned."
        sub={pausedAt ? `Paused since ${new Date(pausedAt).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}. Nothing runs until you resume.` : undefined}
        sample={state.status === "ready" && isSample(state.live)}
        actions={
          <>
            <ButtonLink href="/app?ask=1">Ask your CMO</ButtonLink>
            {state.status === "ready" && <PauseButton pausedAt={pausedAt} live={state.live.cmo} onChange={setPausedOverride} />}
          </>
        }
      />
      <Tabs<Tab> label="Brain views" idBase="brain-tab" items={[...TABS]} value={tab} onChange={setTab} />
      <div role="tabpanel" id="brain-tab-panel" aria-labelledby={`brain-tab-${tab}`} className="scr-tabpanel">
        {state.status === "loading" && <SkeletonBlocks />}
        {state.status === "error" && <ErrorNote>{state.message}</ErrorNote>}
        {state.status === "ready" && <BrainBody data={state.data} tab={tab} />}
      </div>
    </Screen>
  );
}

function BrainBody({ data, tab }: { data: Data; tab: Tab }) {
  // Deleting a note waits for the corrections RPC (brain B0); until then it only hides the row.
  const [learned, setLearned] = useState(data.learned);
  const forget = (id: string) => setLearned((all) => all.filter((note) => note.id !== id));
  const { week } = data;
  const checkAt = week.nextCheckAt
    ? new Date(week.nextCheckAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : null;

  if (tab === "week") {
    return (
      <div className="scr-split">
        <Panel id="brain-orders"
          className="scr-main"
          title={week.goal ? `Orders · goal: ${week.goal}` : "Orders"}
          actions={
            <span className="scr-small scr-muted">
              {week.done} of {week.total} done · {week.credits.used} of {week.credits.budget} credits
            </span>
          }
          foot={`${checkAt ? `The daily check runs at ${checkAt}. ` : ""}Only a stuck order costs a replan.`}
        >
          {data.orders.length ? (
            <OrdersTable orders={data.orders} />
          ) : (
            <p className="v2-panel-body scr-muted">No orders yet. The Brain plans the week on Monday, or when you set a goal.</p>
          )}
        </Panel>
        <div className="scr-side">
          <Panel id="brain-measures" title="Measures" sub="This week, against last week. A dash: nothing to count yet.">
            <MeasureList measures={data.measures} />
          </Panel>
          <Panel id="brain-learned-lately" title="Learned lately" sub="Each note shows where it came from. Delete any.">
            <MemoryList notes={learned.slice(0, 4)} onForget={forget} />
          </Panel>
        </div>
      </div>
    );
  }

  if (tab === "memory") {
    return (
      <Panel id="brain-memory"
        title="Memory"
        sub="Lessons from results, rules from your edits, reasons you skipped things. Newer notes win; delete any you don't agree with."
      >
        {learned.length ? (
          <MemoryList notes={learned} onForget={forget} />
        ) : (
          <p className="v2-panel-body scr-muted">Nothing learned yet. Notes appear after your first week of approvals.</p>
        )}
      </Panel>
    );
  }

  return (
    <Panel id="brain-past-weeks" title="Past weeks" sub="Each Sunday the Brain closes the week against its goal.">
      {data.pastWeeks.length ? (
        <TableWrap label="Past weeks">
          <table className="v2-table">
            <thead>
              <tr>
                <th>Week of</th>
                <th>Goal</th>
                <th>Orders done</th>
                <th>Credits</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {data.pastWeeks.map((w) => (
                <tr key={w.week}>
                  <td className="scr-num">{shortDate(`${w.week}T12:00:00Z`)}</td>
                  <td>
                    <b className="scr-strong">{w.goal ?? "No goal set"}</b>
                  </td>
                  <td className="scr-num">
                    {w.done} / {w.total}
                  </td>
                  <td className="scr-num">
                    {w.credits.used} / {w.credits.budget}
                  </td>
                  <td>{w.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : (
        <p className="v2-panel-body scr-muted">Your first week closes on Sunday.</p>
      )}
    </Panel>
  );
}

function due(order: OrderRow): string {
  if (order.dueText) return order.dueText;
  if (!order.dueAt) return "—";
  return new Date(order.dueAt).toLocaleDateString("en-GB", { weekday: "short" });
}

/** Parents come before their children in `orders`; depth comes from following `parentId`. */
function OrdersTable({ orders }: { orders: OrderRow[] }) {
  const byParent = new Map<string | null, OrderRow[]>();
  for (const order of orders) {
    const list = byParent.get(order.parentId) ?? [];
    list.push(order);
    byParent.set(order.parentId, list);
  }
  const ids = new Set(orders.map((o) => o.id));
  // An order whose parent is not in the list (a filtered view) shows at the top level.
  const roots = orders.filter((o) => o.parentId === null || !ids.has(o.parentId));
  const rows = (list: OrderRow[], depth: number): React.ReactNode =>
    list.map((order) => {
      const stuck = order.state === "failed";
      return (
        <Fragment key={order.id}>
          <tr className={stuck ? "is-stuck" : depth ? undefined : "is-white"}>
            <td>
              <span className={depth ? "scr-order-child" : "scr-strong"} style={depth ? { paddingLeft: depth * 20 } : undefined}>
                {depth ? <span aria-hidden="true">↳ </span> : null}
                {depth ? <span className="scr-sr-only">Part of the order above: </span> : null}
                {order.title}
              </span>
              {order.steps?.length ? <TeamSteps steps={order.steps} compact /> : null}
            </td>
            <td>{DEPARTMENT_LABEL[order.department]}</td>
            <td className="scr-num">{due(order)}</td>
            <td className={`scr-num${stuck ? " scr-stuck-text" : ""}`} data-label="credits">
              {order.credits.used} / {order.credits.budget}
            </td>
            <td>
              <span className="scr-stuck-cell">
                <Chip tone={STATE_TONE[order.state]}>{order.stateText}</Chip>
                {order.approvalId && (order.state === "failed" || order.state === "waiting_founder") && (
                  <a href={`/app/inbox/${encodeURIComponent(order.approvalId)}`}>Open</a>
                )}
              </span>
            </td>
          </tr>
          {rows(byParent.get(order.id) ?? [], depth + 1)}
        </Fragment>
      );
    });
  return (
    <TableWrap label="Orders this week">
      <table className="v2-table scr-orders">
        <thead>
          <tr>
            <th>Order</th>
            <th>Who</th>
            <th>Due</th>
            <th>Credits</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>{rows(roots, 0)}</tbody>
      </table>
    </TableWrap>
  );
}

function MemoryList({ notes, onForget }: { notes: Learned[]; onForget: (id: string) => void }) {
  return (
    <div className="scr-rows">
      {notes.map((note) => (
        <div key={note.id} className="scr-row scr-memory">
          <span className="scr-mono is-small">
            {KIND_LABEL[note.kind]} · {note.scope}
          </span>
          <b>{note.text}</b>
          <span className="scr-small scr-muted">{note.source}</span>
          {note.deletable && (
            <Button compact variant="quiet" className="scr-memory-forget" aria-label={`Delete note: ${note.text}`} onClick={() => onForget(note.id)}>
              Delete
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

const MEASURE_LABEL: Record<Measure["key"], string> = {
  plan_accepted: "Plans accepted as is",
  drafts_as_is: "Drafts approved as is",
  orders_on_time: "Orders on time",
  credits_per_approved: "Credits per approved",
  replans: "Replans",
};

function measureValue(m: Measure): string | null {
  if (m.value === null) return null;
  return m.unit === "percent" ? `${m.value}%` : m.unit === "credits" ? m.value.toFixed(1) : String(m.value);
}

/** Up is good for every measure but credits and replans, where falling is the target. */
function measureDelta(m: Measure): { label: string; direction: "up" | "down" | "flat" } | null {
  if (m.change === null) return null;
  const sign = m.change > 0 ? "+" : m.change < 0 ? "−" : "±";
  const size = Math.abs(m.change);
  const label = `${sign}${m.unit === "percent" ? `${size} pts` : m.unit === "credits" ? size.toFixed(1) : size} vs last week`;
  const better = m.key === "credits_per_approved" || m.key === "replans" ? m.change < 0 : m.change > 0;
  return { label, direction: m.change === 0 ? "flat" : better ? "up" : "down" };
}

function MeasureList({ measures }: { measures: Measure[] }) {
  return (
    <div className="scr-rows" data-testid="brain-measures">
      {measures.map((m) => {
        const delta = measureDelta(m);
        return (
          <div key={m.key} className="scr-row">
            <span className="scr-mono">{MEASURE_LABEL[m.key]}</span>
            <span>
              <b>{measureValue(m) ?? "–"}</b>
              {m.note ? <span className="scr-small scr-muted"> · {m.note}</span> : null}
            </span>
            <span className="scr-small scr-muted">
              {delta ? <span className={`v2-kpi-delta is-${delta.direction}`}>{delta.label}</span> : null}
              {delta ? " · " : ""}Target: {m.target.toLowerCase()}
            </span>
          </div>
        );
      })}
    </div>
  );
}
