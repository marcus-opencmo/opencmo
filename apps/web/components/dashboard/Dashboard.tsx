"use client";

/**
 * The v2 home (S2): week strip, team graph with the live log, results, what goes out today, and the approval queue.
 * Desktop follows Main.dc.html; at phone width the graph becomes a list and the queue moves up (DashboardPhone.dc.html).
 * Data: `DashboardScreen` from `/api/v1/screens/dashboard`; a block whose `live` flag is false shows "Sample data".
 */

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

import { useShellState } from "@/components/shell-v2/ShellState";
import { Button, Kpi, KpiStrip, Panel } from "@/components/ui";

import { ApprovalQueue } from "./ApprovalQueue";
import { DashboardHeader } from "./Header";
import { LiveLog } from "./LiveLog";
import { ResultsPanel, TodayPanel } from "./Tables";
import { TeamGraph, TeamList } from "./TeamGraph";
import { useDashboard } from "./useDashboard";

export function Dashboard() {
  const { state, decideCard, waiting, setPausedAt, reload } = useDashboard();
  const { focusChat, workVersion } = useShellState();
  // `?ask=1` (the Brain and Writer pages link to it) lands in the shell's chat. The History API drops the flag, not the
  // router: a router change would render this dynamic page again on the server.
  const asking = useSearchParams().get("ask") === "1";
  useEffect(() => {
    if (!asking) return;
    focusChat();
    const url = new URL(window.location.href);
    url.searchParams.delete("ask");
    window.history.replaceState(null, "", url.pathname + url.search);
  }, [asking, focusChat]);
  // Work the chat starts (a task, a draft) shows up in the queue and the graph.
  useEffect(() => {
    if (workVersion > 0) void reload();
  }, [workVersion, reload]);

  if (state.status === "loading") {
    return (
      <div className="v2-dash" aria-busy="true">
        <p className="v2-muted">Loading your team…</p>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="v2-dash">
        <div className="v2-empty" role="alert">
          <b className="v2-empty-title">The Dashboard did not load.</b>
          <span className="v2-empty-text">{state.message}</span>
          <div className="v2-actions">
            <Button variant="secondary" onClick={() => void reload()}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const { data, live } = state;
  const count = data.queue.filter((card) => card.status === "waiting").length;
  const { week } = data;
  const credits = week.credits.budget > 0 ? `${week.credits.used} / ${week.credits.budget}` : `${week.credits.used}`;

  return (
    <div className="v2-dash" data-testid="v2-dashboard">
      <DashboardHeader count={count} goal={week.deliverables} pausedAt={data.cmo.pausedAt} pauseLive={live.cmo} onPaused={setPausedAt} onAsk={focusChat} />

      <div className="v2-dash-week">
        <KpiStrip label="This week, live">
          <Kpi label="Week goal" value={week.goal ?? "No goal yet"} text progress={week.deliverables.total > 0 ? (week.deliverables.done / week.deliverables.total) * 100 : 0} />
          <Kpi label="Deliverables done" value={`${week.deliverables.done} / ${week.deliverables.total}`} />
          <Kpi label="Working now" value={`${week.workingNow} of ${data.team.nodes.length}`} />
          <Kpi label="Words drafted today" value={week.wordsDraftedToday.toLocaleString("en-US")} />
          <Kpi label="Credits this week" value={credits} />
        </KpiStrip>
      </div>

      <div className="v2-dash-cols">
        <div className="v2-dash-main">
          <Panel id="team-title" title="Your team, working" mark live sample={!live.team || !live.log} className="v2-dash-team" actions={<Legend />}>
            <TeamGraph team={data.team} waiting={waiting} />
            <LiveLog events={data.log} />
          </Panel>
          <div className="v2-dash-teamlist">
            <TeamList team={data.team} waiting={waiting} />
          </div>
          <div className="v2-dash-results">
            <ResultsPanel results={data.results} live={live.results} />
          </div>
          <div className="v2-dash-today">
            <TodayPanel rows={data.outToday} live={live.outToday} waiting={(id) => data.queue.some((card) => card.id === id)} />
          </div>
        </div>
        <div className="v2-dash-side">
          <ApprovalQueue cards={data.queue} live={live.queue} digest={data.digest} onDecide={decideCard} />
        </div>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="v2-legend" aria-label="Legend">
      <span>
        <span className="v2-legend-key is-working" aria-hidden="true" />
        Working
      </span>
      <span>
        <span className="v2-legend-key is-idle" aria-hidden="true" />
        Idle
      </span>
      <span>
        <span className="v2-legend-key is-stuck" aria-hidden="true" />
        Stuck
      </span>
    </div>
  );
}
