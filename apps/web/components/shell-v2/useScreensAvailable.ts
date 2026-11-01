"use client";

import { useEffect, useState } from "react";

import { api } from "@/components/clipping/api";

import type { ScreenName } from "./nav";

type ScreensIndex = { screens: Partial<Record<ScreenName, { available: boolean }>> };

/**
 * Which v2 screens the rail may show, from `GET /api/v1/screens` (`available`: everywhere outside production, and in
 * production once the screen's release fields are live). Until it answers, nothing counts as available: in
 * production that hides every sample-only screen, which is the safe side.
 */
export function useScreensAvailable(): Partial<Record<ScreenName, boolean>> {
  const [available, setAvailable] = useState<Partial<Record<ScreenName, boolean>>>({});
  useEffect(() => {
    let cancelled = false;
    api<ScreensIndex>("/screens")
      .then((index) => {
        if (cancelled || !index?.screens) return;
        setAvailable(Object.fromEntries(Object.entries(index.screens).map(([name, screen]) => [name, screen?.available === true])));
      })
      .catch(() => {
        // A hint for the rail only: keep the safe default.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}
