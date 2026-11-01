"use client";

import { useState } from "react";

import { api, jsonBody } from "@/components/clipping/api";
import { Button } from "@/components/ui";
import type { SalesScreen } from "@/lib/screens/sales";

type Settings = SalesScreen["settings"];

const SUBREDDIT = /^[a-z0-9_]{2,21}$/;
const clean = (name: string) => name.trim().toLowerCase().replace(/^\/?r\//, "");
const same = (a: Settings, b: Settings) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Where Sales looks (P5 R1): subreddits it never reads, and pairs of words a thread must both contain. The scan applies
 * them before scoring, so a ruled-out thread costs nothing. Sample settings change on this screen only.
 */
export function SalesSettings({ initial, live }: { initial: Settings; live: boolean }) {
  const [saved, setSaved] = useState(initial);
  const [settings, setSettings] = useState(initial);
  const [subreddit, setSubreddit] = useState("");
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const name = clean(subreddit);
  const nameProblem = !subreddit.trim()
    ? null
    : !SUBREDDIT.test(name)
      ? "A subreddit name has 2 to 21 letters, digits or underscores."
      : settings.excludedSubreddits.includes(name)
        ? `r/${name} is already excluded.`
        : settings.excludedSubreddits.length >= 50
          ? "Exclude at most 50 subreddits."
          : null;
  const pair: [string, string] = [first.trim().toLowerCase(), second.trim().toLowerCase()];
  const pairReady = !!pair[0] && !!pair[1] && settings.pairs.length < 20 && !settings.pairs.some(([a, b]) => a === pair[0] && b === pair[1]);

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const next = live
        ? await api<Settings>("/sales/settings", jsonBody({ excluded: settings.excludedSubreddits, pairs: settings.pairs }))
        : settings;
      setSaved(next);
      setSettings(next);
      setNote(live ? "Saved. The next scan skips these." : "Saved (sample, nothing was sent).");
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not save that. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="v2-panel scr-sales-settings" aria-labelledby="sales-settings-title" data-testid="sales-settings">
      <div className="v2-panel-body">
        <h2 id="sales-settings-title" className="scr-settings-title" tabIndex={-1}>
          Where Sales looks
        </h2>
        <p className="scr-small scr-muted">Ruled out before scoring: a skipped subreddit or a thread without both words costs nothing.</p>

        <form
          className="scr-settings-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name || nameProblem) return;
            setSettings((s) => ({ ...s, excludedSubreddits: [...s.excludedSubreddits, name].sort() }));
            setSubreddit("");
          }}
        >
          <label className="v2-field">
            <span>Never scan this subreddit</span>
            <input className="v2-input is-compact" value={subreddit} maxLength={23} placeholder="r/memes" onChange={(event) => setSubreddit(event.target.value)} aria-describedby="sales-subreddit-note" />
          </label>
          <Button type="submit" variant="secondary" compact disabled={!name || !!nameProblem}>
            Exclude
          </Button>
          <span id="sales-subreddit-note" className="scr-tiny scr-muted" role="status">
            {nameProblem ?? ""}
          </span>
        </form>
        {settings.excludedSubreddits.length ? (
          <ul className="scr-chips" aria-label="Excluded subreddits">
            {settings.excludedSubreddits.map((item) => (
              <li key={item}>
                r/{item}
                <button type="button" aria-label={`Scan r/${item} again`} onClick={() => setSettings((s) => ({ ...s, excludedSubreddits: s.excludedSubreddits.filter((x) => x !== item) }))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="scr-tiny scr-muted">No subreddit excluded.</p>
        )}

        <form
          className="scr-settings-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (!pairReady) return;
            setSettings((s) => ({ ...s, pairs: [...s.pairs, pair] }));
            setFirst("");
            setSecond("");
          }}
        >
          <label className="v2-field">
            <span>A thread must mention</span>
            <input className="v2-input is-compact" value={first} maxLength={60} placeholder="video" onChange={(event) => setFirst(event.target.value)} />
          </label>
          <label className="v2-field">
            <span>and also</span>
            <input className="v2-input is-compact" value={second} maxLength={60} placeholder="editor" onChange={(event) => setSecond(event.target.value)} />
          </label>
          <Button type="submit" variant="secondary" compact disabled={!pairReady}>
            Add pair
          </Button>
        </form>
        {settings.pairs.length ? (
          <ul className="scr-chips" aria-label="Word pairs">
            {settings.pairs.map(([a, b]) => (
              <li key={`${a}+${b}`}>
                {a} + {b}
                <button type="button" aria-label={`Remove the pair ${a} and ${b}`} onClick={() => setSettings((s) => ({ ...s, pairs: s.pairs.filter(([x, y]) => x !== a || y !== b) }))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="scr-tiny scr-muted">No word pairs: every thread the search finds is scored.</p>
        )}

        <div className="v2-actions">
          <Button variant="primary" compact disabled={busy || same(settings, saved)} onClick={() => void save()}>
            Save where Sales looks
          </Button>
          {!same(settings, saved) ? (
            <Button variant="quiet" compact onClick={() => setSettings(saved)}>
              Undo changes
            </Button>
          ) : null}
          {note ? (
            <span className="scr-small" role="status">
              {note}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
