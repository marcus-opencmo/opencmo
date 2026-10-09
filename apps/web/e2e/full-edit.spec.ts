import { expect, test } from "@playwright/test";

import { SOURCE_VIDEO } from "./global-setup";
import { openProject, signIn, startClipsInEditor, state, waitForClips } from "./helpers";

/**
 * E2-c: video upload mở NGUYÊN file trong editor ("Edit full video"), không chỉ một clip.
 * Đường thật: RPC tạo clip cả video + task → worker remux upload + transcript cả video →
 * editor mở với độ dài bằng cả video; danh sách clip của project không đổi.
 */
test("Edit full video: upload mở cả file trong editor", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  page.on("pageerror", (error) => console.log(`[editor] ${error.message}`));
  await signIn(page, state().users.a);
  await openProject(page, await startClipsInEditor(page, SOURCE_VIDEO));
  const projectUrl = page.url();
  const editButtons = page.getByRole("button", { name: "Edit clip" });
  await expect(editButtons.first()).toBeVisible({ timeout: 60_000 });
  const clipsBefore = await editButtons.count();

  await page.getByTestId("edit-full-video").click();
  await expect(page).toHaveURL(/\/app\/editor\/[0-9a-f-]+$/, { timeout: 240_000 });
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Loading media…")).toHaveCount(0, { timeout: 60_000 });
  // Fixture dài 30 s: timeline của editor phủ cả video, không phải cửa sổ một clip.
  await expect(page.getByTestId("playhead-time")).toContainText(/\/ 0:(29|30)\./, { timeout: 30_000 });
  await expect(page.getByTestId("clip-picker")).toContainText("Full video");
  await page.screenshot({ path: testInfo.outputPath("full-edit.png") });

  // Clip cả video không chen vào lưới clip AI của project; bấm lại mở thẳng (đã sẵn sàng).
  await page.goto(projectUrl);
  await waitForClips(page);
  await expect(editButtons.first()).toBeVisible({ timeout: 60_000 });
  expect(await editButtons.count()).toBe(clipsBefore);
  await page.getByTestId("edit-full-video").click();
  await expect(page).toHaveURL(/\/app\/editor\/[0-9a-f-]+$/, { timeout: 30_000 });
});
