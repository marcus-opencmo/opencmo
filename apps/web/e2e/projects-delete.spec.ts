import { expect, test } from "@playwright/test";

import type { Project } from "../lib/clipping-types";
import { signIn, state } from "./helpers";

const project: Project = {
  id: "55555555-5555-4555-8555-555555555555", source_name: "Disposable video", title: "Remove me",
  favorite: false, status: "done", stage: "done", duration: 90, clips_requested: 1,
  error: null, created_at: "2026-09-21T00:00:00.000Z", finished_at: "2026-09-21T00:01:00.000Z",
  attempt_started_at: "2026-09-21T00:00:00.000Z", segments: null, has_transcript: false,
  settings: { clip_length: "auto", min_seconds: 15, max_seconds: 60, mode: "clip",
    aspect: "9:16", layout: "auto", captions: true },
  clips: [],
};

test("library deletes only after confirmation and successful server response", async ({ page }) => {
  await signIn(page, state().users.a);
  let visible = true;
  await page.route("**/api/v1/projects?*", (route) => route.fulfill({
    json: { items: visible ? [project] : [], next_cursor: null },
  }));
  await page.route(`**/api/v1/projects/${project.id}`, async (route) => {
    expect(route.request().method()).toBe("DELETE");
    visible = false;
    await route.fulfill({ json: { deleted: true } });
  });

  await page.goto("/app/projects");
  await expect(page.getByRole("button", { name: "Delete project" })).toBeVisible();
  await page.getByRole("button", { name: "Delete project" }).click();
  await page.getByRole("button", { name: /^Confirm deleting/ }).click();
  await expect(page.getByText("Remove me")).toHaveCount(0);
  await expect(page.getByText("No projects yet.")).toBeVisible();
});

test("delayed search response cannot resurrect a deleted project", async ({ page }) => {
  await signIn(page, state().users.a);
  let releaseSearch!: () => void;
  let searchStarted!: () => void;
  const started = new Promise<void>((resolve) => { searchStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseSearch = resolve; });
  await page.route("**/api/v1/projects?*", async (route) => {
    if (new URL(route.request().url()).searchParams.has("q")) {
      searchStarted();
      await release;
    }
    await route.fulfill({ json: { items: [project], next_cursor: null } });
  });
  await page.route(`**/api/v1/projects/${project.id}`, (route) =>
    route.fulfill({ json: { deleted: true } }));
  await page.goto("/app/projects");
  await expect(page.getByText("Remove me", { exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search projects" }).fill("Remove");
  await started;
  await page.getByRole("button", { name: "Delete project" }).click();
  await page.getByRole("button", { name: /^Confirm deleting/ }).click();
  await expect(page.getByText("Remove me", { exact: true })).toHaveCount(0);
  const response = page.waitForResponse((r) => r.url().includes("/api/v1/projects?") && r.url().includes("q="));
  releaseSearch();
  await response;
  await expect(page.getByText("Searching…", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No projects match your search.")).toBeVisible();
  await expect(page.getByText("Remove me", { exact: true })).toHaveCount(0);
});
