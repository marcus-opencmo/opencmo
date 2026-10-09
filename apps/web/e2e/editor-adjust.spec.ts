import { writeFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { SOURCE_VIDEO } from "./global-setup";
import { makeClipsInEditor, signIn, state } from "./helpers";

/**
 * E3: tab Adjust trên video của clip. Thêm effect chỉnh màu trên pixel qua inspector
 * (Saturation −100% → preview ra xám), đường cong kéo được điểm, ba bánh xe màu,
 * chroma key có ô màu, và scopes vẽ được từ khung playhead.
 */

async function openEditor(page: Page) {
  await makeClipsInEditor(page, SOURCE_VIDEO);
}

/** Độ sáng trung bình (0–255) giữa khung preview. */
const previewLuma = (page: Page) =>
  page.getByTestId("editor-canvas").evaluate((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext("2d")!;
    const w = Math.floor(canvas.width / 4);
    const h = Math.floor(canvas.height / 4);
    const data = ctx.getImageData(Math.floor(canvas.width / 2 - w / 2), Math.floor(canvas.height / 2 - h / 2), w, h).data;
    let sum = 0;
    for (let p = 0; p < data.length; p += 4) sum += 0.2126 * data[p]! + 0.7152 * data[p + 1]! + 0.0722 * data[p + 2]!;
    return sum / (data.length / 4);
  });

/** Độ bão hoà trung bình (max − min RGB, 0–255) giữa khung preview. */
const previewSaturation = (page: Page) =>
  page.getByTestId("editor-canvas").evaluate((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext("2d")!;
    const w = Math.floor(canvas.width / 4);
    const h = Math.floor(canvas.height / 4);
    const data = ctx.getImageData(Math.floor(canvas.width / 2 - w / 2), Math.floor(canvas.height / 2 - h / 2), w, h).data;
    let sum = 0;
    for (let p = 0; p < data.length; p += 4) sum += Math.max(data[p]!, data[p + 1]!, data[p + 2]!) - Math.min(data[p]!, data[p + 1]!, data[p + 2]!);
    return sum / (data.length / 4);
  });

test("tab Adjust: saturation trên pixel, curves, wheels, chroma key, scopes", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  page.on("pageerror", (error) => console.log(`[editor] ${error.message}`));
  await signIn(page, state().users.a);
  await openEditor(page);

  // Chọn video của clip trên timeline rồi mở tab Adjust.
  await page.locator(".ed2-bar-video").first().click();
  await page.getByTestId("ins-tab-adjust").click();
  await expect(page.getByTestId("ins-effects")).toBeVisible();
  await expect(page.getByTestId("ins-scopes")).toBeVisible();

  const before = await previewSaturation(page);
  await page.getByTestId("add-effect").click();
  const effects = page.getByTestId("ins-effects").locator(".ed2-part");
  const index = (await effects.count()) - 1;
  await page.getByTestId(`effect-${index}-type`).selectOption("saturation");
  const value = page.getByTestId(`effect-${index}`).getByTestId("ins-value").locator("input");
  await value.fill("-100");
  await value.press("Enter");
  await expect.poll(() => previewSaturation(page), { timeout: 15_000 }).toBeLessThan(Math.max(3, before * 0.2));
  await page.screenshot({ path: testInfo.outputPath("01-saturation.png") });

  // Curves: kéo thêm một điểm trên ô đường cong → params.master có 3 điểm.
  await page.getByTestId(`effect-${index}-type`).selectOption("curves");
  const curve = page.getByTestId(`effect-${index}-curve`);
  await expect(curve).toBeVisible();
  // Ô đường cong nằm dưới đáy inspector: cuộn tới trước khi lấy toạ độ chuột.
  await curve.scrollIntoViewIfNeeded();
  const box = (await curve.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId(`effect-${index}-curve-point-2`)).toBeVisible();
  await page.getByTestId("ins-scopes").getByRole("radio", { name: "Waveform" }).click();
  await page.screenshot({ path: testInfo.outputPath("02-curves.png") });

  // Bánh xe màu và chroma key hiện đủ ô.
  await page.getByTestId(`effect-${index}-type`).selectOption("wheels");
  for (const wheel of ["lift", "gamma", "gain"]) await expect(page.getByTestId(`effect-${index}-${wheel}`)).toBeVisible();
  const wheel = page.getByTestId(`effect-${index}-gain`).locator(".ed2-wheel");
  await wheel.scrollIntoViewIfNeeded();
  const gain = (await wheel.boundingBox())!;
  await page.mouse.click(gain.x + gain.width * 0.8, gain.y + gain.height * 0.5);
  await expect(page.getByTestId(`effect-${index}-gain-master`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("03-wheels.png") });
  await page.getByTestId(`effect-${index}-type`).selectOption("chromaKey");
  await expect(page.getByTestId(`effect-${index}-key-color`)).toBeVisible();
  await page.getByTestId("ins-scopes").getByRole("radio", { name: "Vector" }).click();
  await page.screenshot({ path: testInfo.outputPath("04-chroma-key.png") });

  // LUT .cube (E3-c): nhập vào thư viện → lên Storage (probe nhận .cube) → chọn trong effect → preview đảo màu.
  const lines = ["LUT_3D_SIZE 9"];
  for (let b = 0; b < 9; b++) for (let g = 0; g < 9; g++) for (let r = 0; r < 9; r++) lines.push(`${1 - r / 8} ${1 - g / 8} ${1 - b / 8}`);
  const cube = testInfo.outputPath("invert.cube");
  writeFileSync(cube, lines.join("\n"));
  await page.getByRole("tab", { name: /media/i }).click();
  await page.getByTestId("import-input").setInputFiles(cube);
  await expect(page.getByTestId("library").getByText("invert.cube")).toBeVisible();
  // Export chạy trên server: LUT phải lên Storage và được worker đọc thử (`probe_media` → ready).
  const { url, service } = state();
  const admin = createClient(url, service, { auth: { persistSession: false } });
  await expect
    .poll(
      async () => {
        const { data } = await admin.from("media_assets").select("status, width").eq("name", "invert.cube").order("created_at", { ascending: false }).limit(1);
        return data?.[0] ? `${data[0].status}:${data[0].width}` : "none";
      },
      { timeout: 120_000 },
    )
    .toBe("ready:9");
  await expect(page.getByTestId("sync-uploading")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("sync-local")).toHaveCount(0);
  await page.locator(".ed2-bar-video").first().click();
  await page.getByTestId("ins-tab-adjust").click();
  await page.getByTestId(`effect-${index}-type`).selectOption("saturation");
  await page.getByTestId(`effect-${index}-type`).selectOption("lut");
  const plain = await previewLuma(page);
  await page.getByTestId(`effect-${index}-lut`).selectOption({ label: "invert.cube" });
  await expect.poll(async () => Math.abs((await previewLuma(page)) - (255 - plain)), { timeout: 15_000 }).toBeLessThan(25);
  await page.screenshot({ path: testInfo.outputPath("05-lut.png") });
});
