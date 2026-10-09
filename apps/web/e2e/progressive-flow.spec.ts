import { expect, test } from "@playwright/test";
import type { Project } from "../lib/clipping-types";
import { signIn, state } from "./helpers";

// Fixture API để kiểm các trạng thái UI khó tạo đúng thời điểm bằng render thật.
const project: Project = {
  id: "11111111-1111-4111-8111-111111111111", source_name: "Test video", title: "Quick clips",
  favorite: false, status: "running", stage: "render", duration: 100, clips_requested: 3,
  error: null, created_at: new Date().toISOString(), finished_at: null,
  attempt_started_at: new Date().toISOString(), segments: null, has_transcript: false,
  settings: { clip_length: "auto", min_seconds: 15, max_seconds: 60, mode: "clip",
    aspect: "9:16", layout: "auto", captions: true },
  clips: [{ id: "22222222-2222-4222-8222-222222222222", index: 0, revision: null,
    moment: { start: 0, end: 20, hook: "First moment", reason: "", score: 80 },
    available: true, preview_url: "/unavailable-preview.mp4", download_url: "/clip.mp4",
    export_url: null, export_revision: null }],
};

test("clip sẵn sàng tải khi job còn chạy hoặc thất bại; ZIP phục hồi khi mất mạng", async ({ page }, testInfo) => {
  await signIn(page, state().users.a);
  let current = structuredClone(project);
  await page.route(`**/api/v1/projects/${project.id}`, (route) => route.fulfill({ json: current }));
  await page.route("**/unavailable-preview.mp4", (route) => route.fulfill({ status: 404 }));
  await page.route(`**/api/v1/projects/${project.id}/exports.zip`, async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ variant: "original", clip_ids: [project.clips[0].id] });
    await route.fulfill({ json: { id: "zip-test", status: "running", url: null, error: null } });
  });
  await page.route(`**/api/v1/clips/${project.clips[0].id}/file?resolve=1`, (route) => route.fulfill({ status: 503, json: { detail: "Download temporarily unavailable" } }));
  let recover = false;
  await page.route("**/api/v1/tasks/zip-test", (route) => route.fulfill(recover
    ? { json: { id: "zip-test", status: "failed", error: "Please pack the clips again.", url: null } }
    : { status: 503, json: { detail: "Download check unavailable" } }));
  await page.goto(`/app/projects/${project.id}`);
  await expect(page.getByRole("heading", { name: "Rendering your clips…" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download clip", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Download clip", exact: true }).click();
  await expect(page.getByText(/Download temporarily unavailable/)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/app/projects/${project.id}$`));
  await expect(page.getByRole("button", { name: "Edit clip", exact: true })).toHaveCount(0);
  await expect(page.getByText(/We found .* usable moments/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry preview" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select all" }).check();
  await page.getByRole("button", { name: "Download selected (.zip)", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry download check" })).toBeVisible();
  recover = true;
  await page.getByRole("button", { name: "Retry download check" }).click();
  await expect(page.getByText("Please pack the clips again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download selected (.zip)", exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  current = { ...current, status: "failed", stage: "failed", error: "The source was unavailable." };
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry video" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await expect(page.getByRole("link", { name: "Download clip", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("partial-mobile.png"), fullPage: true });
});

test("lỗi tải project cho phép thử lại", async ({ page }) => {
  await signIn(page, state().users.a);
  let fail = true;
  await page.route(`**/api/v1/projects/${project.id}`, (route) => route.fulfill(fail
    ? { status: 503, json: { detail: "Temporarily unavailable" } }
    : { json: project }));
  await page.goto(`/app/projects/${project.id}`);
  await expect(page.getByRole("button", { name: "Retry loading project" })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Retry loading project" }).click();
  await expect(page.getByRole("link", { name: "Download clip", exact: true })).toBeVisible();
});
