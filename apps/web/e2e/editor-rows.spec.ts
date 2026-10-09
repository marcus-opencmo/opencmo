import { execFileSync } from "node:child_process";

import { expect, test, type Page } from "@playwright/test";

import { signIn, state } from "./helpers";

/**
 * UAT 09/10: nút New project ở trang Projects; b-roll chèn ở các giờ khác nhau nằm CHUNG
 * một hàng "B-roll"; kéo bar xuống dưới mọi hàng thì clip ra hàng riêng, kéo lên hàng
 * B-roll thì về lại hàng đó.
 */

type Node = Record<string, unknown> & { kind: string; children?: Node[] };

async function sceneChildren(page: Page, clipId: string): Promise<Node[]> {
  const body = (await (await page.request.get(`/api/v1/editor/document?clip_id=${clipId}`)).json()) as { document: { stage: { children: Node[] } } };
  const scenes = body.document.stage.children;
  return (scenes.find((scene) => scene.active) ?? scenes[0])!.children ?? [];
}

const shape = (children: Node[]) =>
  children.map((node) => (node.kind === "sequence" ? `${String(node.name)}[${(node.children ?? []).length}]` : node.kind)).join(" ");

test("New project, b-roll chung một hàng, kéo bar giữa các hàng", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  page.on("pageerror", (error) => console.log(`[editor] ${error.message}`));
  await signIn(page, state().users.a);

  await page.goto("/app/projects");
  await page.getByTestId("projects-new").click();
  await expect(page).toHaveURL(/\/app\/editor\/[0-9a-f-]+$/, { timeout: 120_000 });
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 60_000 });
  const clipId = page.url().split("/").pop()!;

  await page.getByRole("tab", { name: /media/i }).click();
  for (const [index, color] of ["red", "green", "blue"].entries()) {
    const file = testInfo.outputPath(`${color}.mp4`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=320x568:r=15:d=2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    await page.getByTestId("import-input").setInputFiles(file);
    await expect(page.getByTestId(`asset-${color}.mp4`)).toBeVisible();
    // Playhead lùi về sau mỗi lượt (w = +1 s): ba clip 2 s không chồng nhau.
    if (index) {
      await page.getByTestId("timeline").hover();
      await page.keyboard.press("Escape");
      for (let step = 0; step < 5; step++) await page.keyboard.press("w");
    }
    await page.getByTestId(`asset-${color}.mp4`).locator(".ed2-lib-icon").dblclick();
  }

  const bars = page.locator(".ed2-bar-broll");
  await expect(bars).toHaveCount(3);
  await expect.poll(async () => shape(await sceneChildren(page, clipId)), { timeout: 60_000 }).toBe("B-roll 1[3]");
  await expect(page.locator('.ed2-role[data-role="broll"]').first()).toContainText("B-roll");
  await page.getByTestId("zoom-fit").click();
  await page.screenshot({ path: testInfo.outputPath("01-one-row.png") });

  // Kéo bar cuối xuống dưới mọi hàng: ra hàng riêng.
  const last = bars.last();
  const from = (await last.boundingBox())!;
  const rows = (await page.locator(".ed2-tl-row.is-clip").last().boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, rows.y + rows.height + 14, { steps: 8 });
  await expect(page.locator(".ed2-row-new")).toBeVisible();
  await page.mouse.up();
  await expect.poll(async () => shape(await sceneChildren(page, clipId)), { timeout: 60_000 }).toBe("B-roll 1[2] rect");
  await page.screenshot({ path: testInfo.outputPath("02-own-row.png") });

  // Kéo nó lên hàng B-roll: về chung hàng.
  const children = await sceneChildren(page, clipId);
  const single = (await page.getByTestId(`clip-${String(children[1]!.id)}`).boundingBox())!;
  const row = (await page.getByTestId(`row-${String(children[0]!.id)}`).boundingBox())!;
  await page.mouse.move(single.x + single.width / 2, single.y + single.height / 2);
  await page.mouse.down();
  await page.mouse.move(single.x + single.width / 2, row.y + row.height / 2, { steps: 8 });
  await expect(page.locator(".ed2-tl-row.is-row-target")).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(async () => shape(await sceneChildren(page, clipId)), { timeout: 60_000 }).toBe("B-roll 1[3]");
  await page.screenshot({ path: testInfo.outputPath("03-back.png") });
});
