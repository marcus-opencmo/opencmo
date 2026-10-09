import { execFileSync } from "node:child_process";

import { expect, test, type Page } from "@playwright/test";

import { SOURCE_VIDEO } from "./global-setup";
import { makeClipsInEditor, signIn, state } from "./helpers";

/**
 * E5: bố cục nhiều nguồn như Palmier. Nhập 2 ảnh, chèn vào clip, chọn video của clip rồi
 * Shift-chọn 2 ảnh → mục Layout chỉ đưa bố cục 3 ô → Three-Stack: người nói ô trên, ảnh đỏ
 * ô giữa, ảnh xanh ô dưới. Rồi PiP góc trên-trái từ menu Split.
 */

async function openEditor(page: Page) {
  await makeClipsInEditor(page, SOURCE_VIDEO);
}

const fieldValue = (page: Page, prop: string) => page.getByTestId(`ins-${prop}`).locator("input").inputValue();

test("bố cục Three-Stack từ 3 lớp, PiP 4 góc", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  page.on("pageerror", (error) => console.log(`[editor] ${error.message}`));
  await signIn(page, state().users.a);
  await openEditor(page);

  // Hai ảnh màu vào thư viện rồi vào clip (nhấp đúp = thêm ở playhead).
  await page.getByRole("tab", { name: /media/i }).click();
  for (const color of ["red", "blue"]) {
    const file = testInfo.outputPath(`${color}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=640x360`, "-frames:v", "1", file]);
    await page.getByTestId("import-input").setInputFiles(file);
    await expect(page.getByTestId(`asset-${color}.png`)).toBeVisible();
    await page.getByTestId(`asset-${color}.png`).locator(".ed2-lib-icon").dblclick();
  }
  const bars = page.locator(".ed2-bar-broll");
  await expect(bars).toHaveCount(2);

  // Thứ tự chọn = thứ tự ô: video của clip, ảnh đỏ, ảnh xanh.
  await page.locator(".ed2-bar-video").first().click();
  await bars.nth(0).click({ modifiers: ["Shift"] });
  await bars.nth(1).click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("ins-layout")).toBeVisible();
  await expect(page.getByTestId("layout-three_up")).toBeVisible();
  await expect(page.getByTestId("layout-grid_2x2")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("01-layout-options.png") });
  await page.getByTestId("layout-three_stack").click();

  // Ảnh thứ nhất vào ô giữa (y = 1/3 khung 1920), ảnh thứ hai ô dưới. Bấm vào lớp đang
  // nằm trong vùng chọn thì timeline giữ cả nhóm: bỏ chọn trước.
  await expect(page.getByTestId("frame-split")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await bars.nth(0).click();
  await expect.poll(() => fieldValue(page, "y")).toBe("640");
  // Kích thước nằm sau "More options" (inspector gọn, design 06/10); lựa chọn được nhớ.
  const more = page.getByTestId("ins-more-options");
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
  expect(await fieldValue(page, "height")).toBe("640");
  await page.keyboard.press("Escape");
  await bars.nth(1).click();
  await expect.poll(() => fieldValue(page, "y")).toBe("1280");
  await page.screenshot({ path: testInfo.outputPath("02-three-stack.png") });

  // PiP đủ 4 góc trong menu Split.
  await page.getByTestId("frame-split").click();
  for (const corner of ["split-pip-tl", "split-pip-top", "split-pip-bl", "split-pip"]) await expect(page.getByTestId(corner)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("03-pip-corners.png") });
});
