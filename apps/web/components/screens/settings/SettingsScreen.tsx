"use client";

import { useEffect, useMemo, useState } from "react";

import { ApiError, api, jsonBody } from "@/components/clipping/api";
import type { AccountSummary } from "@/components/clipping/web/AccountUsage";
import { ApiKeys } from "@/components/clipping/web/ApiKeys";
import { ConnectedApps } from "@/components/clipping/web/ConnectedApps";
import { Button, MonoLabel } from "@/components/ui";
import { formatBytes } from "@/lib/upload";
import { BUDGET_MAX, BUDGET_MIN, type SettingsScreen as Data } from "@/lib/screens/settings";

import { PauseButton } from "../brain/PauseButton";
import { cx, ErrorNote, PageHeader, Panel, Screen, SkeletonBlocks } from "../parts";
import { isSample, useScreen } from "../useScreen";
import { AccountsPanel } from "./AccountsPanel";
import { NotifyPanel } from "./NotifyPanel";

const DIGEST_HOURS = [6, 7, 8, 9, 10, 12, 18];

function zones(current: string): string[] {
  // Every zone the browser knows; the RPC checks the name against Postgres' list on save.
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return all.includes(current) ? all : [current, ...all];
}

function offset(zone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName");
    return part ? ` (${part.value.replace("GMT", "UTC")})` : "";
  } catch {
    return "";
  }
}

export function SettingsScreen({ mcpEndpoint, paid }: { mcpEndpoint: string | null; paid: boolean }) {
  const [state] = useScreen("settings");

  return (
    <Screen label="Settings">
      <PageHeader eyebrow="Settings" title="Accounts, budget, and the off switch." sample={state.status === "ready" && isSample(state.live)} />
      {state.status === "loading" && <SkeletonBlocks />}
      {state.status === "error" && <ErrorNote>{state.message}</ErrorNote>}
      {state.status === "ready" && <SettingsBody data={state.data} live={state.live} />}
      {/* Today's account, API keys and connected apps: kept whole so nothing the old page did is lost. */}
      <AccountPanel />
      <div id="api-keys" className="scr-legacy-cards">
        <ApiKeys endpoint={mcpEndpoint} paid={paid} />
        <ConnectedApps paid={paid} />
      </div>
    </Screen>
  );
}

function SettingsBody({ data, live }: { data: Data; live: Record<keyof Data, boolean> }) {
  const [budget, setBudget] = useState(String(data.weeklyCreditBudget));
  const [timezone, setTimezone] = useState(data.timezone);
  const [digestHour, setDigestHour] = useState<number | null>(data.digestHour);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pausedAt, setPausedAt] = useState(data.cmo.pausedAt);
  const zoneList = useMemo(() => zones(data.timezone), [data.timezone]);
  const savesForReal = live.weeklyCreditBudget && live.timezone && live.digestHour;
  const budgetNumber = Number(budget);
  const budgetOk = budget.trim() !== "" && Number.isInteger(budgetNumber) && budgetNumber >= BUDGET_MIN && budgetNumber <= BUDGET_MAX;
  const dirty = budgetNumber !== data.weeklyCreditBudget || timezone !== data.timezone || digestHour !== data.digestHour;

  async function save() {
    if (!budgetOk) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // Sample settings change only on this page; live ones go through `save_cmo_settings` (brain plan W1-1).
      if (savesForReal) await api("/cmo/settings", jsonBody({ weeklyCreditBudget: budgetNumber, timezone, digestHour }, "PUT"));
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save your settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <AccountsPanel accounts={data.accounts} live={live.accounts} />

      <div className="scr-settings-grid">
        <Panel id="settings-your-cmo" title="Your CMO" className="scr-settings-cmo">
          <form
            className="v2-panel-body scr-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="v2-field" htmlFor="budget">
              Weekly credit budget
              <span className="scr-inline-field">
                <input
                  id="budget"
                  className="v2-input scr-input-short scr-num"
                  inputMode="numeric"
                  value={budget}
                  aria-invalid={!budgetOk}
                  aria-describedby="budget-note"
                  onChange={(e) => {
                    setBudget(e.target.value.replace(/[^0-9]/g, ""));
                    setSaved(false);
                  }}
                />
                <span id="budget-note" className="scr-small">
                  credits · paid video always asks you first
                </span>
              </span>
            </label>
            {!budgetOk && <span className="scr-tiny scr-stuck-text">Use a whole number from {BUDGET_MIN} to {BUDGET_MAX.toLocaleString("en-US")}.</span>}
            <label className="v2-field" htmlFor="timezone">
              Your time zone
              <select
                id="timezone"
                className="v2-input"
                value={timezone}
                onChange={(e) => {
                  setTimezone(e.target.value);
                  setSaved(false);
                }}
              >
                {zoneList.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                    {zone === timezone ? offset(zone) : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="v2-field" htmlFor="digest">
              Morning email
              <select
                id="digest"
                className="v2-input"
                value={digestHour === null ? "off" : String(digestHour)}
                onChange={(e) => {
                  setDigestHour(e.target.value === "off" ? null : Number(e.target.value));
                  setSaved(false);
                }}
              >
                {[...new Set([...DIGEST_HOURS, ...(digestHour === null ? [] : [digestHour])])]
                  .sort((a, b) => a - b)
                  .map((hour) => (
                    <option key={hour} value={hour}>
                      {String(hour).padStart(2, "0")}:00 · what waits, what went out, what is stuck
                    </option>
                  ))}
                <option value="off">Off · the digest stays in the app</option>
              </select>
            </label>
            <fieldset className="v2-field scr-radios">
              <legend>Who does the thinking</legend>
              <label className={cx("scr-radio", data.cmo.mode === "opencmo" && "is-on")}>
                <input type="radio" name="mode" checked={data.cmo.mode === "opencmo"} disabled readOnly />
                <span>
                  <b>OpenCMO</b>
                  <span className="scr-tiny scr-muted">Runs on its own schedule, uses your credits.</span>
                </span>
              </label>
              <label className={cx("scr-radio", data.cmo.mode === "claude" && "is-on")}>
                <input type="radio" name="mode" checked={data.cmo.mode === "claude"} disabled readOnly />
                <span>
                  <b>Your own Claude, through MCP</b>
                  <span className="scr-tiny scr-muted">Your assistant plans; OpenCMO drafts, makes and posts what you approve.</span>
                </span>
              </label>
              <span className="scr-tiny scr-muted">
                Chosen for you today: OpenCMO while you have credits, your Claude when they run out. Connect Claude below.
              </span>
            </fieldset>
            {error && <ErrorNote>{error}</ErrorNote>}
            <span className="v2-actions">
              <Button type="submit" variant="on-dark" disabled={!dirty || !budgetOk || saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              {saved && (
                <span role="status" className="scr-small scr-ok-text">
                  Saved. The next brief uses it.
                </span>
              )}
            </span>
          </form>
        </Panel>

        <section aria-labelledby="off-title" className="v2-panel scr-dark scr-off">
          <MonoLabel small>Off switch</MonoLabel>
          <h2 id="off-title">
            {pausedAt ? "Your CMO is paused. Nothing runs and nothing posts." : "Pause stops every order and every scheduled post within a minute."}
          </h2>
          <p>Nothing is deleted. Resume picks up where it stopped; posts whose time passed ask you again.</p>
          <span>
            <PauseButton variant="on-dark" pausedAt={pausedAt} live={live.cmo} onChange={setPausedAt} />
          </span>
          <div className="scr-off-foot">
            <span className="scr-off-plan">
              <span>Plan</span>
              <span className="scr-num">
                {data.plan.name}
                {data.plan.credits != null ? ` · ${data.plan.credits} credits` : ""}
              </span>
            </span>
            <span className="scr-off-links">
              <a href="/app/billing">Billing</a>
              <a href="/app/library?tab=brand">Brand Kit</a>
              <a href="#api-keys">API keys</a>
            </span>
          </div>
        </section>
      </div>

      <NotifyPanel />
    </>
  );
}

function AccountPanel() {
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api<AccountSummary>("/account")
      .then((value) => alive && setAccount(value))
      .catch((err: unknown) => alive && setError(err instanceof ApiError ? err.message : "Could not load your account."));
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Panel id="settings-account"
      title="Account"
      actions={
        <form action="/auth/signout" method="post">
          <Button type="submit" compact variant="secondary">
            Sign out
          </Button>
        </form>
      }
      foot="Clips and uploads are removed 7 days after a project finishes; downloads of whole videos are removed after 24 hours. Export what you want to keep before then. You are responsible for the rights to the videos you submit."
    >
      <div className="v2-panel-body scr-small">
        {error ? (
          <ErrorNote>{error}</ErrorNote>
        ) : !account ? (
          <span className="scr-muted">Loading…</span>
        ) : (
          <span className="scr-account-line">
            <span>
              Signed in as <b>{account.email}</b>
            </span>
            <span>
              Storage{" "}
              <b className="scr-num">
                {formatBytes(account.quota.storage.bytes)} / {formatBytes(account.quota.storage.limit)}
              </b>
            </span>
            <a href="/app/billing">Credits and daily limits →</a>
          </span>
        )}
      </div>
    </Panel>
  );
}
