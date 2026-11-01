import { mkdirSync } from "node:fs";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { signIn, state } from "./helpers";
import { ensureOnboarded } from "./ui-v2-seed";

/**
 * The three-column shell (docs/plans/cmo/2026-10-30-three-column-shell-plan.md): resizable columns that keep
 * `rail < chat ≤ panel`, open tabs, and one CMO chat that lives across screens. Runs with `npm run test:e2e:v2`.
 */
test.skip(process.env.NEXT_PUBLIC_OPENCMO_UI !== "v2", "v2 UI only: run with npm run test:e2e:v2");
test.beforeAll(ensureOnboarded);

const OUT = join(__dirname, "..", "..", "..", "docs", "plans", "cmo", "2026-10-30-three-column-shell-shots");

async function widths(page: Page) {
  return page.evaluate(() => {
    const width = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().width ?? 0;
    return { rail: width("#v2-rail"), chat: width("#v2-chat"), panel: width(".v2-main") };
  });
}

test("columns resize by keyboard, survive a reload, and keep rail < chat ≤ panel", async ({ page }) => {
  await signIn(page, state().users.a);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app?sample=1");
  await expect(page.getByTestId("v2-dashboard")).toBeVisible();

  const chatSash = page.getByRole("separator", { name: "Resize the chat" });
  await expect(chatSash).toHaveAttribute("aria-valuenow", "400");
  await chatSash.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(chatSash).toHaveAttribute("aria-valuenow", "432");
  expect(Math.round((await widths(page)).chat)).toBe(432);

  await page.reload();
  await expect(page.getByTestId("v2-dashboard")).toBeVisible();
  expect(Math.round((await widths(page)).chat)).toBe(432);

  for (const width of [1100, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const { rail, chat, panel } = await widths(page);
    expect(rail, `rail < chat at ${width}`).toBeLessThan(chat);
    expect(chat, `chat ≤ panel at ${width}`).toBeLessThanOrEqual(panel);
  }

  // Enter puts the chat back to its default.
  await page.setViewportSize({ width: 1440, height: 900 });
  await chatSash.focus();
  await page.keyboard.press("Enter");
  await expect(chatSash).toHaveAttribute("aria-valuenow", "400");
});

test("tabs open with each screen, the current one closes to its neighbour, Dashboard stays", async ({ page }) => {
  await signIn(page, state().users.a);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app?sample=1");
  const rail = page.getByRole("navigation", { name: "Main" });
  const tabs = page.getByRole("navigation", { name: "Open tabs" });

  await rail.getByRole("link", { name: /^Writer/ }).click();
  await expect(page).toHaveURL(/\/app\/writer/);
  await rail.getByRole("link", { name: /^Sales/ }).click();
  await expect(page).toHaveURL(/\/app\/sales/);
  await expect(tabs.getByRole("link")).toHaveText(["Dashboard", "Writer", "Sales"]);
  await expect(tabs.getByRole("button", { name: "Close Dashboard" })).toHaveCount(0);

  await tabs.getByRole("button", { name: "Close Sales" }).click();
  await expect(page).toHaveURL(/\/app\/writer/);
  await tabs.getByRole("button", { name: "Close Writer" }).click();
  await expect(page).toHaveURL(/\/app(\?|$)/);
  await expect(tabs.getByRole("link")).toHaveText(["Dashboard"]);

  // Clicking the open screen in the rail hides the panel; clicking it again brings it back.
  await rail.getByRole("link", { name: /^Dashboard/ }).click();
  await expect(page.locator(".v2-main")).toBeHidden();
  await rail.getByRole("link", { name: /^Dashboard/ }).click();
  await expect(page.locator(".v2-main")).toBeVisible();
});

test("the chat keeps its draft across screens, and ?ask=1 puts the cursor in it", async ({ page }) => {
  await signIn(page, state().users.a);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app?sample=1");
  const chat = page.locator("#v2-chat");
  const input = chat.getByLabel("Ask your CMO");
  await input.fill("Plan a launch week");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Research/ }).click();
  await expect(page).toHaveURL(/\/app\/research/);
  await expect(input).toHaveValue("Plan a launch week");

  await page.goto("/app?ask=1&sample=1");
  await expect(input).toBeFocused();
  await expect(page).not.toHaveURL(/ask=1/);
});

test("look: the frame at 1440, 1280, 1024 and 390, with no serious axe violation", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await signIn(page, state().users.a);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [name, path, ready] of [
    ["dashboard", "/app?sample=1", "v2-dashboard"],
    ["writer", "/app/writer?sample=1", "v2-writer"],
    ["sales", "/app/sales?sample=1", "v2-sales"],
  ] as const) {
    for (const width of [1440, 1280, 1024, 390]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : width === 1024 ? 768 : 900 });
      await page.goto(path);
      // Visible only: during a navigation the outgoing page can briefly share the DOM with the new one.
      await expect(page.getByTestId(ready).filter({ visible: true })).toBeVisible();
      await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: join(OUT, `${name}-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/app/writer?sample=1");
  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page.locator("#v2-chat")).toBeVisible();
  await page.screenshot({ path: join(OUT, "writer-1024-chat.png") });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app?sample=1");
  await expect(page.getByTestId("v2-dashboard")).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test("the editor opens in the frame: its Assistant in column 2, the rail as the icon strip", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await signIn(page, state().users.a);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/studio");
  await page.getByTestId("studio-new").click();
  await page.getByTestId("new-slideshow").click();
  await expect(page).toHaveURL(/\/app\/editor\/[0-9a-f-]{36}/);

  const editor = page.getByTestId("editor-v2");
  await expect(editor).toBeVisible();
  // Inside column 3, under the tab strip, not over the whole window.
  const box = (await editor.boundingBox())!;
  expect(box.x).toBeGreaterThan(300);
  await expect(page.getByRole("navigation", { name: "Open tabs" }).getByRole("link", { name: "Editor" })).toBeVisible();

  // One chat on screen: the clip's Assistant in column 2, none inside the editor.
  const column = page.getByRole("complementary", { name: "Assistant" });
  await expect(column.locator(".ed2-asst")).toBeVisible();
  await expect(editor.locator(".ed2-agent")).toBeHidden();
  expect(Math.round((await widths(page)).rail)).toBe(56);
  await page.screenshot({ path: join(OUT, "editor-1440.png") });

  // ⌘B is the editor's split, not the shell's rail toggle.
  await editor.click({ position: { x: 10, y: 10 } }).catch(() => undefined);
  await page.keyboard.press("ControlOrMeta+b");
  expect(Math.round((await widths(page)).rail)).toBe(56);

  for (const [width, height] of [[1280, 800], [1024, 768]] as const) {
    await page.setViewportSize({ width, height });
    await expect(editor).toBeVisible();
    await page.screenshot({ path: join(OUT, `editor-${width}.png`) });
  }
  await page.getByRole("button", { name: "Chat" }).click();
  await expect(column.locator(".ed2-asst")).toBeVisible();
  await page.screenshot({ path: join(OUT, "editor-1024-chat.png") });

  // Back on a CMO screen, the CMO chat is in column 2 again.
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("navigation", { name: "Open tabs" }).getByRole("link", { name: "Dashboard" }).click();
  await expect(page.locator("#v2-chat").getByLabel("Ask your CMO")).toBeVisible();
});
