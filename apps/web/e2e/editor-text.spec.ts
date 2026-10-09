import { expect, test, type Page } from "@playwright/test";

import { SOURCE_VIDEO } from "./global-setup";
import { makeClipsInEditor, signIn, state } from "./helpers";

/**
 * E4: kiểu chữ như Palmier. Vẽ một lớp chữ bằng công cụ Text, bật hộp nền + gạch dưới,
 * Fill Footage, Tilt, lật; rồi Guides (lưới 1/3 + khung 1:1) phủ lên preview và vẫn còn
 * sau khi tải lại trang.
 */

async function openEditor(page: Page) {
  await makeClipsInEditor(page, SOURCE_VIDEO);
}

test("kiểu chữ (nền, gạch, footage, tilt, lật) và Guides trên preview", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  page.on("pageerror", (error) => console.log(`[editor] ${error.message}`));
  await signIn(page, state().users.a);
  await openEditor(page);

  // Công cụ Text: kéo một hộp giữa khung, ô nội dung tự focus.
  const canvas = page.getByTestId("editor-canvas");
  const box = (await canvas.boundingBox())!;
  await page.keyboard.press("t");
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2 - 30);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  const content = page.getByTestId("ins-text-content");
  await expect(content).toBeVisible();
  await content.fill("HELLO");
  await content.blur();

  await expect(page.getByTestId("ins-text-style")).toBeVisible();
  await page.getByTestId("ins-text-bg").check();
  await expect(page.getByLabel("Background color hex")).toHaveValue("#000000B3");
  await page.getByTestId("ins-text-underline").click();
  await expect(page.getByTestId("ins-text-underline")).toHaveAttribute("aria-pressed", "true");
  const fill = page.getByRole("radiogroup", { name: "Text fill" });
  await fill.getByRole("radio", { name: "Footage" }).click();
  await expect(fill.getByRole("radio", { name: "Footage" })).toHaveAttribute("aria-checked", "true");
  const tilt = page.getByTestId("ins-tiltY").locator("input");
  await tilt.fill("30");
  await tilt.press("Enter");
  await expect(tilt).toHaveValue("30");
  await page.getByTestId("ins-flip-x").click();
  await page.screenshot({ path: testInfo.outputPath("01-text-style.png") });

  // Guides: chỉ là lớp phủ, mở lại trang vẫn nhớ.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("editor-guides")).toHaveCount(0);
  await page.getByTestId("guides-toggle").click();
  await page.getByTestId("guide-thirds").click();
  await page.getByTestId("guide-safe").click();
  await page.getByTestId("guide-frame-1:1").click();
  const guides = page.getByTestId("editor-guides");
  await expect(guides.locator('[data-guide="thirds"] line')).toHaveCount(4);
  await expect(guides.locator('[data-guide="safe"] rect')).toHaveCount(2);
  await expect(guides.locator('[data-guide="frame"]')).toHaveCount(1);
  await page.getByTestId("guides-toggle").click();
  await expect(page.getByTestId("guides-menu")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("02-guides.png") });
  await page.reload();
  await expect(page.getByText("Loading media…")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("editor-guides").locator('[data-guide="thirds"]')).toHaveCount(1);
  await expect(page.getByTestId("guides-toggle")).toHaveAttribute("aria-pressed", "true");
});
