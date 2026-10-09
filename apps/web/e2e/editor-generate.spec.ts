import { execFileSync } from "node:child_process";

import { expect, test, type Page } from "@playwright/test";

import { SOURCE_VIDEO } from "./global-setup";
import { makeClipsInEditor, showAssistant, signIn, state } from "./helpers";

/**
 * Editor với ảnh làm đầu vào (plan Palmier P1-B/P2) và cổng trình duyệt dò tính năng.
 *
 * Đường thật từ đầu tới cuối, model giả nhưng CÓ khả năng như model thật
 * (migration 20261019090000): upload ảnh → Storage → probe `ready` → chọn làm frame
 * đầu ở ô Generate → route đổi id thư viện thành tên object → SQL kiểm chủ → worker
 * tải, kiểm duyệt, đưa cho provider giả (frame đầu của video ra đúng màu ảnh).
 * Thêm: starter "Generate B-roll" ra MỘT thẻ duyệt có tổng credit, và `save_frame`.
 */

async function openEditor(page: Page): Promise<{ clipId: string; projectId: string }> {
  const projectId = await makeClipsInEditor(page, SOURCE_VIDEO);
  return { clipId: /\/app\/editor\/([0-9a-f-]+)$/.exec(page.url())![1]!, projectId };
}


async function leftTab(page: Page, name: RegExp) {
  await page.getByRole("tab", { name }).click();
}

test("ảnh trong thư viện làm frame đầu, B-roll một thẻ duyệt, save_frame", async ({ page }, testInfo) => {
  test.setTimeout(1_500_000);
  page.on("pageerror", (error) => console.log(`[editor] ${error.message}`));
  page.on("response", (response) => {
    if (/\/api\/v1\/agent\//.test(response.url())) console.log(`[agent-http] ${response.request().method()} ${response.status()} ${response.url().replace(/^.*\/api\/v1/, "")}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`[editor] ${message.text()}`);
  });
  // G1: trạng thái lượt sinh tới qua Realtime — đếm sự kiện `generations` trên WebSocket.
  let realtimeGenerations = 0;
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload === "string" && payload.includes("postgres_changes") && payload.includes('"table":"generations"')) realtimeGenerations++;
    });
  });
  await signIn(page, state().users.a);
  const { clipId, projectId } = await openEditor(page);

  // --- ảnh người dùng lên Storage -----------------------------------------
  const still = testInfo.outputPath("still.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=360x640", "-frames:v", "1", still]);
  await leftTab(page, /media/i);
  await page.getByTestId("import-input").setInputFiles(still);
  const row = page.getByTestId("library").getByText("still.png");
  await expect(row).toBeVisible();
  // Lên Storage xong (probe ảnh `ready`): không còn "Uploading", không "This device only".
  await expect(page.getByTestId("sync-uploading")).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByTestId("sync-local")).toHaveCount(0);
  await expect(page.getByTestId("sync-device")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("01-library-image.png") });

  // --- ô Generate theo khả năng model -------------------------------------
  await page.getByTestId("tool-generate").click();
  await page.getByTestId("generate-kind-video").click();
  const panel = page.getByTestId("generate-panel");
  await panel.getByLabel("Model").selectOption("fake-video").catch(() => undefined);
  await panel.getByLabel("Duration").selectOption("3").catch(() => undefined);
  await panel.getByTestId("generate-resolution").selectOption("480p");
  const low = await panel.getByTestId("generate-price").innerText();
  await panel.getByTestId("generate-resolution").selectOption("720p");
  const high = await panel.getByTestId("generate-price").innerText();
  const credits = (text: string) => Number(/(\d+)/.exec(text)?.[1] ?? NaN);
  expect(credits(high), `${low} → ${high}`).toBe(credits(low) * 2);
  await panel.getByTestId("generate-resolution").selectOption("480p");
  await panel.getByTestId("generate-first-frame").selectOption({ label: "Start on still.png" });
  await panel.getByTestId("generate-prompt").fill("a slow push in on a red wall");
  await page.screenshot({ path: testInfo.outputPath("02-generate-panel.png") });
  await panel.getByTestId("generate-submit").click();

  // Lượt sinh nằm trong thư mục `generated` (thu gọn): chờ file video xong, không có lỗi.
  await expect(page.getByTestId("generate-first-frame").or(page.getByTestId("library"))).toBeVisible();
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/projects/${projectId}/media`)).json()).filter((item: { name: string; status: string }) => /\.mp4$/.test(item.name) && item.status === "ready").length, { timeout: 240_000 })
    .toBeGreaterThan(0);
  await expect(page.getByTestId("library").getByText(/generation failed|still uploading/i)).toHaveCount(0);
  // Document (đã lưu lên server) mang khai báo có frame đầu là ảnh thư viện.
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json()), { timeout: 60_000 })
    .toMatch(/"startFrame":"[^"]*still\.png"/);
  await page.screenshot({ path: testInfo.outputPath("03-generated.png") });
  // G1: xong thì thanh clip không còn nhãn "Generating…", và trạng thái đã tới qua Realtime.
  await expect(page.locator('[data-testid^="clip-ai-pending-"]')).toHaveCount(0);
  expect(realtimeGenerations).toBeGreaterThan(0);

  // --- G1: lượt hỏng hiện ngay trên clip, Retry gửi lại ------------------------
  // `[[flag]]` = kiểm duyệt giả từ chối: lượt hỏng theo đúng đường người dùng gặp.
  let posts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/v1\/generations$/.test(request.url())) posts++;
  });
  if (!(await page.getByTestId("generate-panel").isVisible())) await page.getByTestId("tool-generate").click();
  await page.getByTestId("generate-kind-image").click();
  await page.getByTestId("generate-prompt").fill("[[flag]] a blocked prompt");
  await page.getByTestId("generate-submit").click();
  const retry = page.locator('[data-testid^="clip-ai-retry-"]');
  await expect(retry).toHaveCount(1, { timeout: 30_000 });
  await expect(retry).toHaveText("Failed · Retry");
  await expect(page.getByTestId("canvas-pending")).toContainText(/Generation failed/);
  const before = posts;
  await retry.click();
  await expect.poll(() => posts, { timeout: 30_000 }).toBeGreaterThan(before);
  await expect(retry).toHaveCount(1, { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("03b-failed-retry.png") });

  // --- G1: menu chuột phải — Regenerate (có giá) và Animate this image -----------
  // Phần tử hỏng vẫn đang được chọn (ô Generate chọn phần tử vừa đặt).
  await leftTab(page, /media/i);
  await page.getByTestId("library").click({ button: "right", position: { x: 8, y: 8 } });
  await expect(page.getByTestId("ai-regenerate")).toHaveText(/^Regenerate · \d+ credits?$/);
  const beforeRegenerate = posts;
  await page.getByTestId("ai-regenerate").click();
  await expect.poll(() => posts, { timeout: 30_000 }).toBeGreaterThan(beforeRegenerate);
  await page.keyboard.press("Escape");

  // Chèn ảnh: node vừa chèn được chọn; chuột phải ở thư viện không đổi vùng chọn.
  await page.getByTestId("asset-still.png").locator(".ed2-lib-icon").dblclick();
  await page.getByTestId("library").click({ button: "right", position: { x: 8, y: 8 } });
  await expect(page.getByTestId("ai-animate")).toBeVisible();
  await page.getByTestId("ai-animate").click();
  await expect(page.getByTestId("generate-panel")).toBeVisible();
  await expect(page.getByTestId("generate-kind-video")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("generate-first-frame")).toHaveValue(/still\.png$/);
  await page.screenshot({ path: testInfo.outputPath("03c-animate-image.png") });

  // --- G2: @Image1 trong prompt ------------------------------------------------
  await page.getByTestId("generate-kind-image").click();
  const prompt = page.getByTestId("generate-prompt");
  await prompt.fill("");
  await prompt.pressSequentially("a mug like @st");
  await expect(page.getByTestId("generate-mention-option")).toHaveText(["still.png"]);
  await page.getByTestId("generate-mention-option").click();
  await expect(prompt).toHaveValue("a mug like @Image1 ");
  await expect(page.getByTestId("generate-refs")).toContainText("Image 1 · still.png");
  await prompt.pressSequentially("and @Image2");
  await page.getByTestId("generate-submit").click();
  await expect(page.getByTestId("generate-mention-error")).toHaveText("@Image2 is not one of your 1 reference image.");
  await prompt.fill("a mug like @Image1 on a desk");
  await page.screenshot({ path: testInfo.outputPath("03d-mention.png") });
  await page.getByTestId("generate-submit").click();
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json()), { timeout: 30_000 })
    .toMatch(/"prompt":"a mug like image 1 on a desk"[^}]*"refs":\["still\.png"\]/);

  // --- G3: nhạc/SFX nền cho cả clip ----------------------------------------------
  if (!(await page.getByTestId("generate-panel").isVisible())) await page.getByTestId("tool-generate").click();
  await page.getByTestId("generate-kind-audio").click();
  await page.getByTestId("generate-bed").locator("input").check();
  await page.getByTestId("generate-prompt").fill("soft piano bed");
  await page.getByTestId("generate-submit").click();
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json()), { timeout: 30_000 })
    // Dài bằng vùng làm việc của clip (workarea), từ giây 0, −18 dB.
    .toMatch(/"workarea":\[0,(\d+)\].*"end":\1,"src":\{"generate":"audio","prompt":"soft piano bed","model":"fake-audio","duration":\1,"seed":\d+\},"volume":-18/);

  // --- G2: Edit with AI — sửa clip video AI đã có bằng lời -------------------------
  const current = (await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json()) as { document: unknown };
  const pushIn = JSON.stringify(current.document).match(/"id":"([^"]+)"[^{}]*?"paints":\[\{"type":"video","src":\{"generate":"video","prompt":"a slow push in on a red wall"/);
  expect(pushIn, "clip video AI đầu test có trong document").not.toBeNull();
  await page.getByTestId(`clip-${pushIn![1]}`).click();
  await page.getByTestId("library").click({ button: "right", position: { x: 8, y: 8 } });
  await page.getByTestId("ai-edit-video").click();
  await expect(page.getByTestId("generate-edit-source")).toContainText(/^Editing .+ · \ds\./);
  await expect(page.getByTestId("generate-kind-video")).toBeHidden();
  await page.getByTestId("generate-prompt").fill("make it a snowy night");
  await page.getByTestId("generate-submit").click();
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json()), { timeout: 30_000 })
    .toMatch(/"prompt":"make it a snowy night","model":"fake-edit"[^}]*"sourceVideo":"generated\/[^"]+","sourceStart":0/);
  await expect(page.locator('[data-testid^="clip-ai-pending-"]')).toHaveCount(0, { timeout: 240_000 });
  await expect(page.locator('[data-testid^="clip-ai-retry-"]')).toHaveCount(1);

  // --- G4: Upscale cùng clip video AI ------------------------------------------------
  await page.getByTestId(`clip-${pushIn![1]}`).click();
  await page.getByTestId("library").click({ button: "right", position: { x: 8, y: 8 } });
  await expect(page.getByTestId("ai-upscale-2160p")).toHaveText(/^Upscale to 4K · \d+ credits$/);
  await expect(page.getByTestId("ai-upscale-1080p")).toHaveText(/^Upscale to 1080p · \d+ credits$/);
  await page.getByTestId("ai-upscale-1080p").click();
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json()), { timeout: 30_000 })
    .toMatch(/"model":"fake-upscale"[^}]*"resolution":"1080p"[^}]*"sourceVideo":"generated\/[^"]+"/);
  await expect(page.locator('[data-testid^="clip-ai-pending-"]')).toHaveCount(0, { timeout: 240_000 });
  await expect(page.locator('[data-testid^="clip-ai-retry-"]')).toHaveCount(1);

  // --- G4: nháp 480p → Enhance 720p, cùng seed --------------------------------------
  const seed = JSON.stringify(current.document).match(/"prompt":"a slow push in on a red wall"[^}]*"seed":(\d+)/)![1];
  await page.getByTestId(`clip-${pushIn![1]}`).click();
  await page.getByTestId("library").click({ button: "right", position: { x: 8, y: 8 } });
  await expect(page.getByTestId("ai-enhance-720p")).toHaveText(/^Enhance to 720p · \d+ credits$/);
  await page.getByTestId("ai-enhance-720p").click();
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json()), { timeout: 30_000 })
    .toMatch(new RegExp(`"prompt":"a slow push in on a red wall"[^}]*"resolution":"720p","seed":${seed}`));
  await expect(page.locator('[data-testid^="clip-ai-pending-"]')).toHaveCount(0, { timeout: 240_000 });

  // --- Assistant: B-roll một thẻ duyệt, có tổng --------------------------
  await showAssistant(page);
  const starter = page.getByRole("button", { name: /^Generate B-roll/ });
  await expect(starter).toBeVisible();
  await starter.click();
  await expect(page.getByTestId("assistant-approval")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("assistant-approval-total")).toHaveText(/Total: \d+ credits/);
  // Thẻ dài vẫn thấy tổng và nút Approve mà không phải cuộn.
  await expect(page.getByTestId("assistant-approval-total")).toBeInViewport();
  await expect(page.getByTestId("assistant-approve")).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("04-broll-approval.png") });
  await page.getByRole("button", { name: "Cancel" }).click();

  // --- save_frame -----------------------------------------------------------
  await page.getByLabel("Message the assistant").fill("save a frame");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-reply").last()).toContainText(/Saved the frame as .*before-cut/, { timeout: 120_000 });
  // Không có lượt nối tiếp nào chạy chồng (đã gặp: toast "could not continue" + 409).
  await page.waitForTimeout(3000);
  await expect(page.getByText(/could not continue/i)).toHaveCount(0);
  // Màn 1280px: mở Assistant thì Media nhường chỗ; bấm hiện Media là đóng Assistant.
  await expect(page.getByTestId("panel-media")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("panel-media").click();
  await expect(page.getByTestId("panel-agent")).toHaveAttribute("aria-pressed", "false");
  await leftTab(page, /media/i);
  await expect(page.getByTestId("library").getByText("Frames")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("05-saved-frame.png") });

  // --- E0: editor là mục "Editor" trên rail -----------------------------------
  await page.goto("/app/projects");
  await page.locator(".rail").getByRole("link", { name: "Editor" }).click();
  // G1-a: vào thẳng clip vừa sửa, rail sáng "Editor" và thu thành cột icon.
  await expect(page).toHaveURL(new RegExp(`/app/editor/${clipId}$`), { timeout: 60_000 });
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".rail").getByRole("link", { name: "Editor" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".rail")).not.toHaveClass(/is-open/);
  // Ô chọn clip thay nút Back: thấy clip đang mở.
  await page.getByTestId("clip-picker").click();
  await expect(page.getByTestId("clip-picker-item").first()).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: testInfo.outputPath("06-editor-rail.png") });
  await page.keyboard.press("Escape");
  // Link cũ vẫn mở đúng editor.
  await page.goto(`/app/projects/${projectId}/clips/${clipId}/edit`);
  await expect(page).toHaveURL(new RegExp(`/app/editor/${clipId}$`));

  // --- E1: J/L-cut từ menu chuột phải -----------------------------------------
  // Cắt 1 giây nguồn ở giây 3 của clip qua đúng route op của editor, rồi mở lại.
  const loaded = await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json();
  const master = JSON.stringify(loaded.document).match(/"src":"assets\/master\.mp4"[^}]*?"sourceIn":([\d.]+)/) ?? JSON.stringify(loaded.document).match(/"sourceIn":([\d.]+)[^}]*?"src":"assets\/master\.mp4"/);
  const windowStart = Number(master?.[1] ?? 0);
  const cutResponse = await page.request.post("/api/v1/editor/ops", {
    data: { clip_id: clipId, expected_version: loaded.version, ops: [{ op: "remove_ranges", ranges: [{ start: windowStart + 3, end: windowStart + 4 }] }] },
  });
  expect(cutResponse.status(), await cutResponse.text()).toBe(200);
  await page.reload();
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 60_000 });
  // Phím nhảy điểm cắt đọc layout của renderer: chờ media nạp xong.
  await expect(page.getByText("Loading media…")).toHaveCount(0, { timeout: 60_000 });
  // Không chọn gì: ↓ nhảy tới điểm cắt kế tiếp (giây 3 của clip).
  await page.locator(".ed2-center, main").first().click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.locator("[data-testid=editor-v2]").click({ button: "right", position: { x: 640, y: 300 } });
  await page.getByTestId("cut-shape").hover({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("07-cut-menu.png") });
  await page.getByTestId("cut-l").click();
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json()), { timeout: 30_000 })
    .toMatch(/"roll":\{"[\d.]+":0\.5\}/);

  // --- G1: AI transition từ cùng menu điểm cắt --------------------------------
  await page.keyboard.press("Escape");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.locator("[data-testid=editor-v2]").click({ button: "right", position: { x: 640, y: 300 } });
  await page.getByTestId("cut-shape").hover({ timeout: 30_000 });
  await expect(page.getByTestId("cut-ai-transition")).toHaveText(/^AI transition · \d+ credits$/);
  await page.getByTestId("cut-ai-transition").click();
  // Hai khung quanh chỗ cắt vào thư viện, rồi một video first+last phủ chỗ cắt, tắt tiếng, tua vừa 1,2 s.
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json()), { timeout: 120_000 })
    .toMatch(/"startFrame":"Frames\/before-cut[^"]*","endFrame":"Frames\/after-cut[^"]*"/);
  const transition = JSON.stringify(await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json());
  expect(transition).toMatch(/"muted":true[^}]*"playbackRate":[\d.]+|"playbackRate":[\d.]+[^}]*"muted":true/);
  await expect(page.locator('[data-testid^="clip-ai-pending-"]')).toHaveCount(0, { timeout: 240_000 });
  await page.screenshot({ path: testInfo.outputPath("07b-ai-transition.png") });

  // --- G2: Extend clip video vừa sinh (đang được chọn) -----------------------------
  await leftTab(page, /media/i);
  await page.getByTestId("library").click({ button: "right", position: { x: 8, y: 8 } });
  await expect(page.getByTestId("ai-extend")).toHaveText(/^Extend · \d+ credits$/);
  await page.getByTestId("ai-extend").click();
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json()), { timeout: 120_000 })
    .toMatch(/Continue this shot naturally[^}]*"startFrame":"Frames\/extend-from[^"]*"/);
  await expect(page.locator('[data-testid^="clip-ai-pending-"]')).toHaveCount(0, { timeout: 240_000 });

  // --- Bố cục kiểu Palmier: preset, bật/tắt panel, phóng to, kéo cỡ nhớ theo preset ---
  await page.keyboard.press("Escape");
  const area = page.getByTestId("editor-area");
  const box = async (panel: string) => (await page.locator(`[data-panel="${panel}"]`).boundingBox())!;
  // Default: Media | Preview | Inspector trên, Timeline cả bề ngang dưới.
  await page.getByTestId("layout-menu").click();
  await page.getByTestId("layout-default").click();
  let media = await box("media");
  let timeline = await box("timeline");
  expect(timeline.y).toBeGreaterThan(media.y + media.height - 2);
  expect(timeline.x).toBeLessThanOrEqual(media.x + 1);
  await page.screenshot({ path: testInfo.outputPath("08-layout-default.png") });
  // Media (Alt+2): Media cao hết bên trái, Timeline chỉ dưới Preview + Inspector.
  await page.locator('[data-panel="preview"]').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Alt+Digit2");
  await expect(page.getByTestId("editor-v2")).toHaveAttribute("data-preset", "media");
  media = await box("media");
  timeline = await box("timeline");
  expect(timeline.x).toBeGreaterThanOrEqual(media.x + media.width - 2);
  expect(media.y + media.height).toBeGreaterThan(timeline.y + timeline.height - 4);
  await page.screenshot({ path: testInfo.outputPath("09-layout-media.png") });
  // Vertical (Alt+3): Preview là cột phải cao hết.
  await page.keyboard.press("Alt+Digit3");
  await expect(page.getByTestId("editor-v2")).toHaveAttribute("data-preset", "vertical");
  const preview = await box("preview");
  timeline = await box("timeline");
  expect(preview.x).toBeGreaterThanOrEqual(timeline.x + timeline.width - 2);
  expect(preview.height).toBeGreaterThan(timeline.height + 100);
  await page.screenshot({ path: testInfo.outputPath("10-layout-vertical.png") });
  // Kéo mép Preview: cỡ nhớ riêng cho Vertical, về Default không đổi theo.
  const handle = (await page.getByTestId("split-preview").boundingBox())!;
  await page.mouse.move(handle.x + 4, handle.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle.x - 96, handle.y + 200, { steps: 5 });
  await page.mouse.up();
  const wider = await box("preview");
  expect(wider.width).toBeGreaterThan(preview.width + 60);
  await page.reload();
  await expect(page.getByTestId("editor-v2")).toHaveAttribute("data-preset", "vertical", { timeout: 60_000 });
  expect(Math.abs((await box("preview")).width - wider.width)).toBeLessThan(4);
  // Bật/tắt panel.
  await page.getByTestId("panel-inspector").click();
  await expect(page.locator('[data-panel="inspector"]')).toHaveCount(0);
  await page.getByTestId("panel-inspector").click();
  await expect(page.locator('[data-panel="inspector"]')).toHaveCount(1);
  await showAssistant(page);
  await page.screenshot({ path: testInfo.outputPath("11-layout-assistant.png") });
  // Phóng to Timeline bằng phím `, Esc thu lại.
  await page.keyboard.press("Alt+Digit1");
  await page.locator('[data-panel="timeline"]').click({ position: { x: 300, y: 12 } });
  await page.keyboard.press("Backquote");
  await expect(area).toHaveAttribute("data-max", "timeline");
  await expect(page.locator('[data-panel="preview"]')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("12-layout-max-timeline.png") });
  await page.keyboard.press("Escape");
  await expect(area).not.toHaveAttribute("data-max", /./);
  await expect(page.locator('[data-panel="preview"]')).toBeVisible();

  // --- E2-a: nhiều timeline (tab trên thanh timeline) -----------------------------
  const tabs = page.getByTestId("timeline-tab");
  // Một timeline: không có hàng tab, chỉ nút "+ Timeline".
  await expect(tabs).toHaveCount(0);
  await page.getByTestId("timeline-new").click();
  await page.getByTestId("timeline-duplicate").click();
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(1)).toHaveText(/copy$/);
  // Bản sao đổi khung 1:1; bản gốc vẫn 9:16.
  await page.getByTestId("frame-1:1").click();
  await expect(page.getByTestId("frame-1:1")).toHaveAttribute("aria-pressed", "true");
  await tabs.nth(1).dblclick();
  await page.getByLabel("Timeline name").fill("Square");
  await page.getByLabel("Timeline name").press("Enter");
  await expect(tabs.nth(1)).toHaveText("Square");
  // E2-b: cỡ tự do + fps xuất trên bản sao.
  await page.getByTestId("frame-more").click();
  await page.getByTestId("frame-custom-width").fill("1280");
  await page.getByTestId("frame-custom-height").fill("720");
  await page.getByTestId("frame-custom-apply").click();
  await expect(page.getByTestId("frame-more")).toContainText("1280×720");
  await page.getByTestId("frame-more").click();
  await page.getByTestId("frame-fps-60").click();
  await expect(page.getByTestId("frame-more")).toContainText("60 fps");
  await page.screenshot({ path: testInfo.outputPath("13-timelines.png") });
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("frame-9:16")).toHaveAttribute("aria-pressed", "true");
  // Đã lưu lên server: hai scene, bản sao 1280×720 ở 60 fps, bản gốc giữ nguyên.
  await expect
    .poll(async () => {
      const saved = (await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json()).document;
      return saved.stage.children.map((scene: { name?: string; width: number; height: number; fps?: number }) => `${scene.name}:${scene.width}x${scene.height}${scene.fps ? `:${scene.fps}` : ""}`).join(",");
    }, { timeout: 30_000 })
    .toMatch(/,Square:1280x720:60$/);
  // Xoá timeline bằng menu chuột phải.
  await tabs.nth(1).click({ button: "right" });
  await page.getByTestId("timeline-delete").click();
  await expect(tabs).toHaveCount(0);

  // --- E2-d: undo của agent trong một yêu cầu + send_feedback ----------------------
  await showAssistant(page);
  await page.getByLabel("Message the assistant").fill("make it square then undo");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-reply").last()).toContainText(/Undone: the clip is back/, { timeout: 120_000 });
  await expect(page.getByTestId("frame-9:16")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await page.getByLabel("Message the assistant").fill("I want a ProRes file, send feedback");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-reply").last()).toContainText(/sent that to the OpenCMO team/, { timeout: 120_000 });
  await page.screenshot({ path: testInfo.outputPath("14-undo-feedback.png") });
});
