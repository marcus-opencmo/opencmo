import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { expect, test } from "@playwright/test";

import { SOURCE_VIDEO } from "./global-setup";
import { sceneBox, videoRegionStats } from "./canvas";
import { openProject, showAssistant, signIn, startClipsInEditor, state } from "./helpers";

/**
 * Đường đi đầy đủ của một người dùng: upload → chờ xử lý → sửa → export → tải.
 *
 * Đây là test duy nhất chạm vào cả bốn tầng cùng lúc (trình duyệt, route
 * handler, Supabase, worker Python). Mọi lỗi tệ nhất của dự án này đều im
 * lặng — file vẫn ra, vẫn mở được, chỉ là nội dung hỏng — nên nó kiểm cả nội
 * dung file tải về, không chỉ mã HTTP.
 */
test("upload, chỉnh, export và tải về", async ({ page }, testInfo) => {
  // Test này chạy pipeline thật, rồi một lượt export thật ở worker. 180s mặc
  // định là ngân sách của một test UI, không phải của hai lượt xử lý video.
  test.setTimeout(900_000);

  // Console của editor là nơi nói vì sao một lượt sửa hay export không đi: giao
  // diện chỉ hiện một thông báo ngắn, test có thể không kịp đọc.
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`[editor] ${message.text()}`);
  });
  page.on("pageerror", (error) => console.log(`[editor] ${error.message}`));
  const { users } = state();
  await signIn(page, users.a);
  // --- upload thẳng lên Storage từ tab Clips của editor (không byte nào đi qua Next) ---
  await openProject(page, await startClipsInEditor(page, SOURCE_VIDEO));

  // Tải clip gốc và ZIP thật trước khi chạm editor: không cần export.
  const originalReady = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download clip", exact: true }).click();
  const original = await originalReady;
  const originalPath = testInfo.outputPath("original.mp4");
  await original.saveAs(originalPath);
  expect(readFileSync(originalPath).subarray(4, 8).toString()).toBe("ftyp");
  await page.getByRole("checkbox", { name: "Select all" }).check();
  const zipReady = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download selected (.zip)", exact: true }).click();
  const zip = await zipReady;
  const zipPath = testInfo.outputPath("originals.zip");
  await zip.saveAs(zipPath);
  const names = execFileSync("python3", ["-c", "import sys,zipfile,json; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps(z.namelist())); assert z.testzip() is None", zipPath], { encoding: "utf8" });
  expect(JSON.parse(names)).toEqual(["clip-01.mp4"]);
  await page.screenshot({ path: testInfo.outputPath("results-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("results-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // Thư viện dùng clip đầu tiên làm thumbnail phát được, không còn list text.
  await page.goto("/app/projects");
  const projectPreview = page.getByLabel(/Preview /).first();
  await expect(projectPreview).toBeVisible();
  await expect(projectPreview).toHaveAttribute("src", /\/api\/v1\/clips\/.+preview=1#t=0\.1$/);
  // Thẻ project (giao diện "giấy & mực") là một link tới trang project, không còn chữ "Open project".
  await page.locator('a[href^="/app/projects/"]').first().click();
  await expect(page).toHaveURL(/\/app\/projects\/[0-9a-f-]+$/);

  // --- mở editor ----------------------------------------------------------
  //
  // Nút Edit mở route edit của app; shell kiểm máy rồi dựng editor ngay tại chỗ.
  // Chrome của Playwright là Chromium và cửa sổ 1280×900, nên nó được vào.
  await page.getByRole("button", { name: "Edit clip" }).first().click();
  await expect(page).toHaveURL(/\/app\/editor\/[0-9a-f-]+$/, { timeout: 60_000 });
  const clipId = /\/app\/editor\/([0-9a-f-]+)$/.exec(page.url())![1]!;
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Loading media…")).toBeHidden({ timeout: 120_000 });

  // Document là thứ database lưu; đo mọi lượt sửa bằng chính nó, không bằng một
  // nhãn trên màn hình: "Saved" chỉ nói request đã xong, không nói ghi đúng gì.
  type Node = { kind?: string; [key: string]: unknown };
  type Doc = { stage: { children: Node[] } };
  const documentOf = async (): Promise<Doc> => {
    const response = await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`);
    expect(response.ok()).toBeTruthy();
    return ((await response.json()) as { document: Doc }).document;
  };
  const everything = (value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] => {
    if (Array.isArray(value)) value.forEach((item) => everything(item, out));
    else if (value && typeof value === "object") {
      out.push(value as Record<string, unknown>);
      Object.values(value).forEach((item) => everything(item, out));
    }
    return out;
  };
  const sceneOf = (doc: Doc) =>
    (doc.stage.children.find((node) => node.active) ?? doc.stage.children[0]) as Node & {
      width: number;
      height: number;
      workarea?: [number, number] | null;
    };
  const frameOf = async () => {
    const scene = sceneOf(await documentOf());
    return `${scene.width}x${scene.height}`;
  };

  // Khung VIDEO có hình, không chỉ canvas có pixel sáng. Đếm pixel trên cả
  // canvas thì chữ và phụ đề làm assertion xanh trong khi video đen — đã xảy ra
  // suốt GĐ 1–5. Đo ở dải chỉ có video: nền đen và ô màu phẳng khi decoder từ
  // chối đều cho độ lệch chuẩn ≈ 0; `testsrc2` cho hàng chục.
  const initial = sceneOf(await documentOf());
  const region = () => sceneBox(page, initial);
  await expect
    .poll(async () => (await videoRegionStats(page, await region())).std, {
      timeout: 120_000,
      message: "khung video trong editor không có hình (decode hỏng hoặc chưa tải được master)",
    })
    .toBeGreaterThan(10);

  // Và hình phải đổi theo playhead: một frame đứng yên cũng qua được ngưỡng trên.
  const still = await videoRegionStats(page, await region());
  await page.keyboard.press("Space");
  await page.waitForTimeout(2_000);
  await page.keyboard.press("Space");
  const played = await videoRegionStats(page, await region());
  expect(
    Math.abs(played.mean - still.mean) + Math.abs(played.std - still.std),
    "khung video không đổi khi phát",
  ).toBeGreaterThan(0.5);

  await page.screenshot({ path: testInfo.outputPath("editor-desktop.png") });

  // --- một lượt sửa trên canvas, và nó phải sống qua reload ---------------
  const before = JSON.stringify(await documentOf());
  const box = await region();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 12 });
  await page.mouse.up();

  await expect
    .poll(async () => JSON.stringify(await documentOf()), { timeout: 60_000, message: "lượt sửa không tới được database" })
    .not.toBe(before);
  const saved = JSON.stringify(await documentOf());

  await page.reload();
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("save-status")).toHaveText("Saved", { timeout: 60_000 });
  expect(JSON.stringify(await documentOf()), "reload không đọc lại đúng bản vừa lưu").toBe(saved);

  // --- sửa bằng chữ: đổi một từ, rồi cắt hai từ khỏi video -----------------
  //
  // Transcript của fixture: "we built this in a single weekend", mỗi từ 0.4s
  // từ giây 0.4. Hai thao tác đi hai đường ghi khác nhau (transcript theo hash,
  // và `sequence` các đoạn giữ lại) — cả hai phải sống qua reload.
  await page.getByRole("tab", { name: "Transcript" }).click();
  const word = (text: string) => page.getByTestId("transcript-word").filter({ hasText: new RegExp(`^${text}$`) });
  await word("weekend").dblclick();
  await page.getByLabel("Edit word").fill("month");
  await page.getByLabel("Edit word").press("Enter");
  const captionsSrc = async () => String(everything(await documentOf()).find((node) => node.kind === "captions")?.src);
  await expect
    .poll(captionsSrc, { timeout: 60_000, message: "transcript đã sửa không tới được document" })
    .toMatch(/^assets\/transcripts\/[0-9a-f]{64}\.json$/);

  await word("in").click();
  await word("a").click({ modifiers: ["Shift"] });
  await page.getByTestId("transcript-remove").click();
  const hasCut = async () =>
    everything(await documentOf()).some(
      (node) => node.kind === "sequence" && (node.marks as Record<string, unknown> | undefined)?.["text-cut"],
    );
  await expect.poll(hasCut, { timeout: 60_000, message: "lượt cắt bằng chữ không tới được document" }).toBe(true);
  const workarea = sceneOf(await documentOf()).workarea!;
  expect(workarea[1] - workarea[0], "workarea phải ngắn lại đúng phần đã cắt").toBeLessThan(7.5);

  await page.reload();
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("tab", { name: "Transcript" }).click();
  await expect(word("month")).toBeVisible({ timeout: 60_000 });
  await expect(word("in")).toHaveAttribute("data-removed", "true");
  await expect(word("a")).toHaveAttribute("data-removed", "true");

  // --- export: worker vẽ document trên server, đóng dấu, tải về ------------
  //
  // Đường tiền. Một thao tác chạm cả bốn tầng: chụp revision (vân tay document
  // từ server) → RPC xếp task `render_document` → worker Python gọi exporter
  // Node (clip-render + ffmpeg) → Storage → signed URL.
  const exportButton = page.getByTestId("toolbar-export");
  await expect(exportButton).toBeEnabled();
  await exportButton.click();
  // Mốc trung gian: lượt export không bao giờ tới hàng đợi là hỏng ở revision
  // hay RPC, không phải ở worker — một lần chờ hết giờ không phân biệt được.
  await expect(exportButton).toHaveText(/Saving…|Queued…|Exporting…|Export again/, { timeout: 60_000 });
  const link = page.getByTestId("export-download");
  await expect(link).toBeVisible({ timeout: 600_000 });
  const exported = await page.request.get((await link.getAttribute("href"))!);
  expect(exported.ok()).toBeTruthy();
  const exportedPath = testInfo.outputPath("document-export.mp4");
  writeFileSync(exportedPath, await exported.body());

  // Không chỉ kiểm mã HTTP: file phải là mp4 thật và phải có hình, vì lỗi tệ
  // nhất của đường này là một file đúng kích thước mà bên trong rỗng.
  const bytes = readFileSync(exportedPath);
  expect(bytes.subarray(4, 8).toString()).toBe("ftyp");
  expect(bytes.byteLength).toBeGreaterThan(10_000);

  // `moov` phải nằm TRƯỚC `mdat` (`+faststart` của exporter): sai thì video vẫn
  // phát được ở máy nhưng không stream được — hỏng im lặng, đúng loại tệ nhất.
  const head = bytes.subarray(0, Math.min(bytes.byteLength, 4 * 1024 * 1024));
  expect(head.indexOf("moov"), "không tìm thấy moov trong 4MB đầu").toBeGreaterThan(0);
  expect(head.indexOf("moov")).toBeLessThan(head.indexOf("mdat"));

  const probe = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name",
     "-of", "default=noprint_wrappers=1:nokey=1", exportedPath],
    { encoding: "utf8" },
  ).trim();
  expect(probe, "tiếng của bản xuất là AAC").toBe("aac");

  // File export là bản ĐÃ CẮT: ngắn hơn clip 8 giây đúng phần "in a" (~0.9s).
  const duration = Number(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", exportedPath],
      { encoding: "utf8" },
    ).trim(),
  );
  expect(duration, "export phải ra bản đã cắt bằng chữ").toBeLessThan(7.6);
  expect(duration).toBeGreaterThan(6.5);

  // --- lịch sử: về lại bản engine sinh ra ----------------------------------
  await page.getByTestId("project-menu").click();
  await page.getByRole("menuitem", { name: /Version history/ }).click();
  await page.getByTestId("version-history").getByRole("button", { name: "Restore" }).first().click();
  await expect
    .poll(hasCut, { timeout: 60_000, message: "Reset to original không đưa document về bản gốc" })
    .toBe(false);
  expect(await captionsSrc()).toBe("assets/transcript.json");

  // --- Assistant (model giả): gõ lệnh → canvas đổi → Undo ------------------
  const frameBefore = await frameOf();
  expect(frameBefore).not.toBe("1080x1080");
  await showAssistant(page);
  await page.getByLabel("Message the assistant").fill("Make it square");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-undo")).toBeVisible({ timeout: 60_000 });
  await expect.poll(frameOf, { timeout: 30_000 }).toBe("1080x1080");
  await expect(page.getByTestId("frame-1:1")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("assistant-action").first()).toContainText("1080×1080");

  await page.getByTestId("assistant-undo").click();
  await expect.poll(frameOf, { timeout: 30_000 }).toBe(frameBefore);
  await expect(page.getByTestId("assistant-turn").first()).toContainText("Undone");

  // Assistant nhìn clip: capture chạy ở trình duyệt, hai mốc ghép thành MỘT contact
  // sheet (AE, `capture.ts`), ảnh về model rồi lượt chạy tiếp.
  await page.getByLabel("Message the assistant").fill("Check the frame");
  await page.getByTestId("assistant-send").click();
  const sheet = page.getByTestId("assistant-frames").locator("img");
  await expect(sheet).toHaveCount(1, { timeout: 60_000 });
  // Hai ô cạnh nhau: tỉ lệ sheet ≈ gấp đôi tỉ lệ khung. Bắt lỗi sheet chỉ còn một ô.
  const size = await sheet.evaluate((img: HTMLImageElement) => ({ w: img.naturalWidth, h: img.naturalHeight }));
  const [frameW, frameH] = frameBefore.split("x").map(Number);
  expect(size.w / size.h, "contact sheet phải có hai ô cạnh nhau").toBeCloseTo((2 * frameW!) / frameH!, 1);
  await expect(page.getByTestId("assistant-reply").last()).toContainText("looked at 1 frame");
});
