"use client";

/**
 * Weekly goal cards (architecture P2) at the top of Approvals. The CMO proposes a goal; it only
 * becomes the week's goal when the founder approves it here, optionally changing the target.
 * The approved goal of the current week shows live progress.
 */

import { useState } from "react";

import type { GoalView } from "@/lib/cmo/workspace";

import type { Actions } from "./actions";

const METRIC_LABEL: Record<GoalView["metric"], [string, string]> = {
  posts: ["post approved", "posts approved"],
  replies: ["Reddit reply", "Reddit replies"],
  clips: ["clip pack approved", "clip packs approved"],
  views: ["view", "views"],
};

export function GoalCards({ goals, actions }: { goals: GoalView[]; actions: Actions }) {
  if (!goals.length) return null;
  return (
    <ol className="cmo-feed cmo-goals" aria-label="Weekly goals">
      {goals.map((goal) => (
        <li key={goal.id}>
          <GoalCard goal={goal} actions={actions} thisWeek={isThisWeek(goal.week)} />
        </li>
      ))}
    </ol>
  );
}

/** Monday of the current UTC week, same rule as the server. */
function isThisWeek(week: string): boolean {
  const now = new Date();
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
  return monday.toISOString().slice(0, 10) === week;
}

function GoalCard({ goal, actions, thisWeek }: { goal: GoalView; actions: Actions; thisWeek: boolean }) {
  const [target, setTarget] = useState(String(goal.target));
  const [busy, setBusy] = useState(false);
  const unit = METRIC_LABEL[goal.metric][goal.target === 1 ? 0 : 1];
  const parsed = Number.parseInt(target, 10);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 1_000_000;

  async function decide(action: "approve" | "reject") {
    setBusy(true);
    await actions.goal(goal, action === "approve" ? { action, target: valid && parsed !== goal.target ? parsed : undefined } : { action });
    setBusy(false);
  }

  const proposed = goal.status === "proposed";
  const pct = goal.progress !== null ? Math.min(100, Math.round((goal.progress / goal.target) * 100)) : null;

  return (
    <article className={`cmo-feed-card cmo-goal-card${proposed ? "" : " is-approved"}`} data-testid="cmo-goal-card">
      <header>
        <p className="cmo-feed-agent">{thisWeek ? "This week's goal" : "Next week's goal"}</p>
        <span className={`cmo-priority ${proposed ? "is-high" : "is-ready"}`}>
          <span className={`cmo-gem${proposed ? "" : " is-on"}`} aria-hidden="true" />
          {proposed ? "Proposed" : "Approved"}
        </span>
      </header>
      <p className="cmo-goal-text">{goal.goal}</p>
      {pct !== null ? (
        <div className="cmo-goal-progress">
          <div className="cmo-goal-bar" role="progressbar" aria-valuemin={0} aria-valuemax={goal.target} aria-valuenow={goal.progress ?? 0}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <small>
            {goal.progress} of {goal.target} {unit}
          </small>
        </div>
      ) : (
        <p className="cmo-muted">Target: {goal.target} {unit}</p>
      )}
      {proposed ? (
        <div className="cmo-feed-actions">
          <label className="cmo-goal-target" htmlFor={`goal-target-${goal.id}`}>
            Target
            <input
              id={`goal-target-${goal.id}`}
              type="number"
              inputMode="numeric"
              min={1}
              max={1_000_000}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </label>
          <button type="button" className="text-button" disabled={busy} onClick={() => void decide("reject")}>Not this one</button>
          <button type="button" className="primary-button" disabled={busy || !valid} onClick={() => void decide("approve")}>Approve goal</button>
        </div>
      ) : null}
    </article>
  );
}
