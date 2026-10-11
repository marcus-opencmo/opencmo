import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { showAssistant, signIn, state } from "./helpers";

/**
 * F1: editor không cần video đã cắt. Người dùng MỚI (chưa có project nào) bấm "Editor" trên
 * rail → vào THẲNG một canvas trống 9:16 (G1-a); nhập một ảnh + một video vào thư viện,
 * thêm chữ, export → MP4 có hình đúng ảnh đã thêm. Đổi tên bản sửa; bấm lại Editor mở đúng bản đó.
 */

test("New edit trống: nhập media, thêm chữ, export — không cần project", async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  page.on("pageerror", (error) => console.log(`[editor] ${error.message}`));
  // User b: các spec khác không tạo project cho user này.
  await signIn(page, state().users.b);

  await page.goto("/app");
  await page.locator(".rail").getByRole("link", { name: "Editor" }).click();
  // Chưa có bản sửa nào: tự tạo bản trống 9:16 và mở luôn, không có màn chọn khung.
  // Lần đầu mở route editor ở server dev có thể phải biên dịch: chờ rộng tay.
  await expect(page).toHaveURL(/\/app\/editor\/[0-9a-f-]+$/, { timeout: 120_000 });
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Loading media…")).toHaveCount(0, { timeout: 60_000 });
  const clipId = page.url().split("/").pop()!;
  await expect(page.getByTestId("frame-9:16")).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: testInfo.outputPath("01-straight-in.png") });

  // Ảnh đỏ phủ khung + một video có tiếng.
  const red = testInfo.outputPath("red.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=1080x1920", "-frames:v", "1", red]);
  const clip = testInfo.outputPath("broll.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=640x360:r=15:d=4", "-f", "lavfi", "-i", "sine=f=330:d=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
  ]);
  await page.getByRole("tab", { name: /media/i }).click();
  await page.getByTestId("import-input").setInputFiles(red);
  await expect(page.getByTestId("asset-red.png")).toBeVisible();
  await page.getByTestId("asset-red.png").locator(".ed2-lib-icon").dblclick();
  await page.getByTestId("import-input").setInputFiles(clip);
  await expect(page.getByTestId("asset-broll.mp4")).toBeVisible();
  await page.getByTestId("asset-broll.mp4").locator(".ed2-lib-icon").dblclick();
  await expect(page.locator(".ed2-bar-broll")).toHaveCount(2);
  // G4: Lottie người dùng tải lên (một ô xanh lá) — trước đây chỉ nằm ở máy, Export báo
  // "only saved on the device". Giờ lên Storage, worker export vẽ nó bằng Skottie.
  const lottie = testInfo.outputPath("green.json");
  const square = { a: 0, k: 100 };
  writeFileSync(lottie, JSON.stringify({
    v: "5.7.4", fr: 30, ip: 0, op: 120, w: 400, h: 400,
    layers: [{ ind: 1, ty: 1, sc: "#00ff00", sw: 400, sh: 400, ip: 0, op: 120, st: 0,
      ks: { o: square, r: { a: 0, k: 0 }, p: { a: 0, k: [200, 200, 0] }, a: { a: 0, k: [200, 200, 0] }, s: { a: 0, k: [100, 100, 100] } } }],
  }));
  await page.getByTestId("import-input").setInputFiles(lottie);
  await expect(page.getByTestId("asset-green.json")).toBeVisible();
  await page.getByTestId("asset-green.json").locator(".ed2-lib-icon").dblclick();

  // Chữ bằng công cụ Text.
  const canvas = page.getByTestId("editor-canvas");
  const box = (await canvas.boundingBox())!;
  await page.keyboard.press("Escape");
  await page.keyboard.press("t");
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height * 0.25, { steps: 5 });
  await page.mouse.up();
  await page.getByTestId("ins-text-content").fill("BLANK EDIT");
  await page.getByTestId("ins-text-content").blur();
  await page.screenshot({ path: testInfo.outputPath("02-blank-edit.png") });

  // Export: file thư viện phải lên Storage trước (worker đọc từ đó).
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get(`/api/v1/editor/project?clip_id=${clipId}`)).json()), { timeout: 240_000 })
    .toMatch(/"state":"synced"[\s\S]*"state":"synced"[\s\S]*"state":"synced"/);
  const exportButton = page.getByTestId("toolbar-export");
  await expect(exportButton).toBeEnabled();
  await exportButton.click();
  const link = page.getByTestId("export-download");
  await expect(link).toBeVisible({ timeout: 600_000 });
  const exported = await page.request.get((await link.getAttribute("href"))!);
  expect(exported.ok()).toBeTruthy();
  const file = testInfo.outputPath("blank-export.mp4");
  writeFileSync(file, await exported.body());
  const frame = testInfo.outputPath("blank-export.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "1", "-i", file, "-frames:v", "1", frame]);
  // Góc dưới trái (không có video B-roll ở giữa, không có chữ) là ảnh đỏ.
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", frame, "-vf", "crop=8:8:20:1200,scale=1:1,format=rgb24", "-f", "rawvideo", "pipe:1"]);
  expect(raw[0]!, `rgb ${[...raw]}`).toBeGreaterThan(180);
  expect(raw[1]!).toBeLessThan(80);
  // Lottie có mặt trong bản xuất: có điểm ảnh xanh lá thuần.
  const small = execFileSync("ffmpeg", ["-v", "error", "-i", frame, "-vf", "scale=108:192,format=rgb24", "-f", "rawvideo", "pipe:1"]);
  let green = 0;
  for (let i = 0; i < small.length; i += 3) if (small[i + 1]! > 200 && small[i]! < 80 && small[i + 2]! < 80) green++;
  expect(green, "điểm ảnh xanh lá của Lottie").toBeGreaterThan(20);

  // Assistant chạy được trong bản trống (không master, không transcript): lập plan rồi thêm chữ,
  // và đổi khung vuông.
  await showAssistant(page);
  await page.getByLabel("Message the assistant").fill("make a plan for a title");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByText("Watch this").first()).toBeVisible({ timeout: 120_000 });
  await page.getByLabel("Message the assistant").fill("make it square");
  await page.getByTestId("assistant-send").click();
  await expect
    .poll(async () => JSON.stringify((await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json()).document), { timeout: 120_000 })
    .toMatch(/"kind":"scene"[^{]*?"width":1080,"height":1080|"height":1080[^{]*?"width":1080/);
  // Editor nhận bản sửa của agent: thanh khung sáng 1:1 (không chỉ document trên server).
  await expect(page.getByTestId("frame-1:1")).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 });
  await page.screenshot({ path: testInfo.outputPath("03-assistant-blank.png") });

  // AI media without a script: the agent places the image by time (2s), not by a quote, through
  // the priced approval card.
  await page.getByLabel("Message the assistant").fill("create an ai image at 2s of our app");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-approval")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("assistant-approval")).toContainText("Prompt:");
  await page.getByTestId("assistant-approve").click();
  await expect(page.getByTestId("assistant-reply").last()).toContainText(/being generated/, { timeout: 120_000 });
  await expect
    .poll(async () => JSON.stringify((await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json()).document), { timeout: 120_000 })
    .toMatch(/"start":2,"end":5[^]*"generate":"image"|"generate":"image"[^]*"start":2,"end":5/);
  await page.screenshot({ path: testInfo.outputPath("04-ai-image-by-time.png") });

  // Đổi tên bản sửa; bấm Editor trên rail mở lại đúng bản này; My projects không liệt kê nó.
  await page.getByTestId("clip-picker").click();
  await page.getByTestId("clip-picker-rename").click();
  await page.getByTestId("clip-picker-name").fill("Launch teaser");
  await page.getByTestId("clip-picker-name").press("Enter");
  await expect(page.getByTestId("clip-picker")).toContainText("Launch teaser");
  await page.goto("/app/projects");
  await page.locator(".rail").getByRole("link", { name: "Editor" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/editor/${clipId}$`), { timeout: 60_000 });
  const projects = await (await page.request.get("/api/v1/projects")).json();
  expect(JSON.stringify(projects)).not.toContain("Launch teaser");
});
