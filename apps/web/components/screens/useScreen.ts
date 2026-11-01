"use client";

import { useCallback, useEffect, useState } from "react";

import { api } from "@/components/clipping/api";
import { useOptionalShellState } from "@/components/shell-v2/ShellState";
import type { ScreenName, ScreenResponse } from "@/lib/screens/registry";

export type ScreenState<N extends ScreenName> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | ({ status: "ready" } & ScreenResponse<N>);

/**
 * Reads one v2 screen through `/api/v1/screens/[name]` (live fields + fixture, Session A's U0), under RLS like
 * every other client read. `?sample=1` on the page passes through, for the look checks of U9.
 */
export function useScreen<N extends ScreenName>(name: N, query: Record<string, string> = {}): [ScreenState<N>, () => void] {
  const [state, setState] = useState<ScreenState<N>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const key = new URLSearchParams(query).toString();
  // Work the chat starts or shows (a scan, a draft, `view.open`) reloads the screen in column 3, not only the Dashboard.
  const work = useOptionalShellState()?.workVersion ?? 0;

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams(key);
    if (new URLSearchParams(window.location.search).get("sample") === "1") params.set("sample", "1");
    const qs = params.toString();
    api<ScreenResponse<N>>(`/screens/${name}${qs ? `?${qs}` : ""}`)
      .then((res) => alive && setState({ status: "ready", ...res }))
      .catch((err: unknown) => alive && setState({ status: "error", message: err instanceof Error ? err.message : "Could not load this page." }));
    return () => {
      alive = false;
    };
  }, [name, key, tick, work]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return [state, reload];
}

/** True when any of the given fields is still sample data: the page shows the "Sample data" tag. */
export function isSample(live: Record<string, boolean>, fields?: string[]): boolean {
  return (fields ?? Object.keys(live)).some((field) => !live[field]);
}
