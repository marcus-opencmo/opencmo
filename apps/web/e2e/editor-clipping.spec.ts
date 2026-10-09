import { expect, test } from "@playwright/test";

import { SOURCE_VIDEO } from "./global-setup";
import { makeClipsInEditor, openClipsPanel, signIn, state } from "./helpers";

/**
 * G1-c: cắt clip là một tính năng của editor. Rail không còn "New clips"; `/app/video` cũ dẫn
 * vào tab Clips; dán link phải tick "Is this your video?" (luật 3, server cũng chặn); upload →
 * clip → Open mở đúng clip đó như một bản sửa riêng.
 */

test("tab Clips: link cần xác nhận chính chủ, upload ra clip mở được", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  page.on("pageerror", (error) => console.log(`[editor] ${error.message}`));
  await signIn(page, state().users.a);

  await page.goto("/app/projects");
  await expect(page.locator(".rail").getByRole("link", { name: "New clips" })).toHaveCount(0);
  await expect(page.locator(".rail").getByRole("link", { name: "My projects" })).toBeVisible();

  // Link cũ vẫn tới đúng chỗ.
  await page.goto("/app/video");
  await expect(page.getByTestId("clips-panel")).toBeVisible({ timeout: 120_000 });
  await expect(page).toHaveURL(/\/app\/editor\/[0-9a-f-]+$/);
  await expect(page.getByRole("tab", { name: "Clips" })).toHaveAttribute("aria-selected", "true");

  // Link: nút khoá tới khi tick xác nhận; gửi thẳng API mà không xác nhận thì bị chặn.
  const panel = page.getByTestId("clips-panel");
  await panel.getByTestId("clips-use-link").click();
  await panel.getByTestId("clips-url").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await expect(panel.getByTestId("clips-submit")).toBeDisabled();
  await expect(panel.getByText("Is this your YouTube video?")).toBeVisible();
  await panel.getByTestId("clips-own").check();
  await expect(panel.getByTestId("clips-submit")).toBeEnabled();
  // Sửa link là phải xác nhận lại.
  await panel.getByTestId("clips-url").fill("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
  await expect(panel.getByTestId("clips-own")).not.toBeChecked();
  await expect(panel.getByTestId("clips-submit")).toBeDisabled();
  const refused = await page.request.post("/api/v1/editor/clipping", {
    data: { source: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", clips: 1 },
  });
  expect(refused.status()).toBe(422);
  expect(await refused.text()).toContain("Confirm this is your own video");

  for (const width of [1366, 1904]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`clips-link-${width}.png`) });
  }
  await panel.getByRole("button", { name: "Upload a file instead" }).click();
  await page.setViewportSize({ width: 1366, height: 900 });

  // Upload → clip → Open: clip mở như một bản sửa riêng (URL là clip của job vừa tạo).
  const before = page.url();
  const jobId = await makeClipsInEditor(page, SOURCE_VIDEO);
  expect(page.url()).not.toBe(before);
  const clipId = page.url().split("/").pop()!;
  const project = await (await page.request.get(`/api/v1/projects/${jobId}`)).json();
  expect(JSON.stringify(project)).toContain(clipId);
  await page.screenshot({ path: testInfo.outputPath("clips-opened-1366.png") });

  // Tab Clips của clip vừa mở vẫn thấy job (danh sách theo tài khoản, không theo bản sửa).
  await openClipsPanel(page);
  await expect(page.locator(`[data-job="${jobId}"]`).getByTestId("clips-open").first()).toBeVisible();
  for (const width of [1366, 1904]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`clips-jobs-${width}.png`) });
  }
});
