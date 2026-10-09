import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { SOURCE_VIDEO } from "./global-setup";
import { openClipsPanel, openProject, signIn, state } from "./helpers";

/**
 * Lựa chọn đầu ra "Don't clip" (mode full). Đổi khung sau khi clip xong nằm trong editor.
 *
 * Tab Clips của editor (G1-c) cố ý không có nút "Don't clip" — link + tải nguyên video là
 * đúng hình một content downloader. API vẫn nhận `mode: "full"`, nên test sửa body POST
 * để vẫn chạy nhánh worker thật.
 *
 * Nhánh "Don't clip" ở đây chạy bằng ĐÚNG code worker thật, không phải fixture:
 * `_process_full` không gọi `run_pipeline`, mà `run_pipeline` mới là thứ
 * `tests/e2e_worker.py` thay thế. Nguồn upload nên cũng không có lượt tải mạng
 * nào — file đã nằm sẵn trong Storage.
 */

test("Don't clip giao nguyên video, không mở editor", async ({ page }) => {
  const { users, url, service } = state();
  await signIn(page, users.a);
  await openClipsPanel(page);

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const sourceCount = async () => {
    const { data } = await admin.storage.from("sources").list(users.a.id, { limit: 1000 });
    return (data ?? []).filter((item) => item.id && item.name.endsWith(".mp4")).length;
  };
  const before = await sourceCount();

  // Panel không có nút "Don't clip"; câu retention nằm ở Settings, không ở đây.
  await expect(page.getByRole("tab", { name: /don.t clip/i })).toHaveCount(0);
  await expect(page.getByText(/deleted after 24 hours/i)).toHaveCount(0);

  await page.route("**/api/v1/editor/clipping", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = JSON.parse(route.request().postData() ?? "{}") as { source: string };
    await route.continue({ postData: JSON.stringify({ source: body.source, mode: "full" }) });
  });
  await page.getByTestId("clips-file").setInputFiles(SOURCE_VIDEO);
  const created = page.waitForResponse((response) => response.url().endsWith("/api/v1/editor/clipping") && response.request().method() === "POST", { timeout: 120_000 });
  await page.getByTestId("clips-submit").click();
  const response = await created;
  expect(response.ok(), await response.text()).toBeTruthy();
  await openProject(page, ((await response.json()) as { id: string }).id);

  // Không transcript thì không dựng lại được phụ đề — nút editor phải vắng mặt,
  // không phải hiện lên rồi dẫn vào ngõ cụt.
  await expect(page.getByRole("button", { name: "Edit clip" })).toHaveCount(0);

  const ready = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download clip", exact: true }).click();
  const file = await ready;
  const path = test.info().outputPath("full.mp4");
  await file.saveAs(path);
  // File thật, không phải một trang lỗi đặt tên .mp4.
  expect(readFileSync(path).subarray(4, 8).toString()).toBe("ftyp");

  // Và Storage KHÔNG giữ hai bản của cùng một video: lượt upload thêm một file
  // vào `sources`, lượt giao nhân bản nó sang `clips` rồi xoá bản nguồn — nên
  // số file nguồn phải trở về đúng như trước.
  expect(await sourceCount()).toBe(before);
});

/**
 * Màn xử lý: ảnh bìa nguồn + lưới ô điền dần.
 *
 * Fixture API chứ không phải job thật: một job fixture xong trong 4 giây, và
 * trạng thái "2/5 clip xong" chỉ tồn tại trong một chớp mắt. Ảnh chụp ở đây là
 * bằng chứng bố cục, không phải bằng chứng luồng dữ liệu — cái đó do hai test
 * trên và `clip-flow.spec.ts` lo.
 */
test("màn xử lý hiện thumbnail và lưới clip điền dần", async ({ page }, testInfo) => {
  await signIn(page, state().users.a);

  const id = "33333333-3333-4333-8333-333333333333";
  const running = {
    id,
    source_name: "https://www.youtube.com/watch?v=UVFRjpSjb6s",
    title: "Why AI-Generated Websites Don’t Convert",
    favorite: false,
    status: "running",
    stage: "render",
    duration: 995,
    clips_requested: 5,
    error: null,
    created_at: new Date(Date.now() - 42_000).toISOString(),
    finished_at: null,
    attempt_started_at: new Date(Date.now() - 40_000).toISOString(),
    segments: null,
    has_transcript: false,
    settings: {
      clip_length: "auto", min_seconds: 10, max_seconds: 60, mode: "clip",
      aspect: "9:16", layout: "auto", captions: true,
    },
    clips: [0, 1].map((index) => ({
      id: `4444444${index}-4444-4444-8444-444444444444`,
      index,
      revision: null,
      moment: { start: index * 60, end: index * 60 + 24, hook: `Ready clip ${index + 1}`, reason: "", score: 86 },
      available: true,
      preview_url: "/proof/netflix-job-scam.mp4",
      download_url: "/clip.mp4",
      export_url: null,
      export_revision: null,
    })),
  };

  await page.route(`**/api/v1/projects/${id}`, (route) => route.fulfill({ json: running }));
  // Chỉ báo xuyên màn hình đọc DANH SÁCH project, không phải project đang mở —
  // nên nó cần fixture riêng, và việc nó cần là đúng: chip phải hiện cả khi
  // người dùng đang đứng ở Settings.
  await page.route(
    (url) => url.pathname.endsWith("/api/v1/projects") && url.search.includes("limit="),
    (route) => route.fulfill({ json: { items: [running], next_cursor: null } }),
  );
  await page.goto(`/app/projects/${id}`);

  await expect(page.getByRole("heading", { name: "Rendering your clips…" })).toBeVisible();
  await expect(page.getByText("2 of 5 clips ready")).toBeVisible();
  // Năm ô: hai ô đã có clip, ba ô còn đang chờ.
  await expect(page.locator(".clip-tile")).toHaveCount(5);
  await expect(page.locator(".clip-tile.is-ready")).toHaveCount(2);
  // Chỉ báo xuyên màn hình đọc cùng một dữ liệu, nên nó cũng phải thấy job này.
  await expect(page.locator(".active-job")).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath("processing-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("processing-mobile.png"), fullPage: true });
});

test("tab Clips: mặc định, phụ đề và khung theo bản đang mở", async ({ page }, testInfo) => {
  await signIn(page, state().users.a);
  await openClipsPanel(page);
  const panel = page.getByTestId("clips-panel");

  // Chỉ bật/tắt phụ đề (R4): không còn chọn kiểu ở đây, kiểu chọn trong editor.
  await expect(panel.getByRole("radio", { name: "On" })).toBeChecked();
  await expect(panel.getByRole("radio", { name: "Bold" })).toHaveCount(0);
  // Khung mặc định = khung của bản đang mở (FrameBar), không cố định 9:16.
  const pressed = await page.locator('[data-testid^="frame-"][aria-pressed="true"]').first().getAttribute("data-testid");
  const frame = pressed?.replace("frame-", "") ?? "9:16";
  if (["9:16", "1:1", "16:9"].includes(frame)) await expect(panel.getByRole("radio", { name: frame })).toBeChecked();
  await expect(panel.getByTestId("clips-submit")).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("clips-panel.png") });

  await panel.getByRole("radio", { name: "Off" }).check({ force: true });
  await expect(panel.getByRole("radio", { name: "Off" })).toBeChecked();
});

