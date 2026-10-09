import { expect, test } from "@playwright/test";
import { signIn, state } from "./helpers";

/** Nghiệm thu responsive và điều hướng thật sau thay đổi lớp giao diện. */
test("landing, đăng nhập và các màn workspace giữ bố cục và điều hướng", async ({ page }, testInfo) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Landing v3 có ba ô website (hero, pricing, CTA cuối trang); kiểm ô ở hero.
    await expect(page.locator("#hero-site")).toBeVisible();
    // Hero: eyebrow, H1, ô website. Landing không có ô link video
    // (docs/cmo/tham-khao.md §6: "content downloader" là mục cấm của bên thanh toán).
    // Video duy nhất trong main là demo "See it work" dựng từ UI của chính OpenCMO.
    await expect(page.locator(".lv-hero .lv-eyebrow")).toBeVisible();
    await expect(page.locator(".lv-hero .lv-pill-form button")).toBeVisible();
    await expect(page.locator("main input[type=url]")).toHaveCount(0);
    await expect(page.locator("main video")).toHaveCount(1);
    // Bốn trang pháp lý phải tới được từ footer khi chưa đăng nhập.
    for (const name of ["Terms", "Privacy", "Acceptable Use", "Refunds"]) {
      await expect(page.getByRole("contentinfo").getByRole("link", { name, exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`landing-${width}.png`), fullPage: true });
    // Nav ẩn mục Pricing dưới 960px; link ở footer có ở mọi bề rộng.
    await page.getByRole("contentinfo").getByRole("link", { name: "Pricing", exact: true }).click();
    await expect(page.locator("#pricing")).toBeInViewport();
  }
  for (const path of ["/terms", "/privacy", "/acceptable-use", "/refund"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
  await page.goto("/");
  await page.locator("#hero-site").fill("example.com");
  await page.locator(".lv-hero").getByRole("button", { name: "Start with your website" }).click();
  await expect(page).toHaveURL(/\/login\?site=/);
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("login-mobile.png"), fullPage: true });

  await signIn(page, state().users.b);
  // Editor cần màn máy tính (điện thoại nhận màn hướng dẫn).
  await page.setViewportSize({ width: 1440, height: 960 });
  // Link tạo clip cũ (`/app?url=`) mở tab Clips của editor với link điền sẵn (G1-c), rồi
  // xoá tham số khỏi URL. Lần đầu mở route editor ở server dev có thể phải biên dịch.
  await page.goto("/app?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dexample");
  await expect(page.getByTestId("clips-url")).toHaveValue("https://www.youtube.com/watch?v=example", { timeout: 120_000 });
  await expect(page).toHaveURL(/\/app\/editor\/[0-9a-f-]+$/);
  await page.goto("/app?source=upload");
  await expect(page.getByTestId("clips-panel").getByRole("button", { name: "Choose video", exact: true })).toBeVisible({ timeout: 60_000 });

  await page.setViewportSize({ width: 1440, height: 960 });
  // `/app` là màn AI CMO 4 cột: rail cố ý thu thành cột icon ở đó (26361b4). Mở/thu rail
  // kiểm trên một màn thường.
  await page.goto("/app/projects");
  const rail = page.locator(".rail");
  await expect(rail).toHaveClass(/is-open/);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(rail).not.toHaveClass(/is-open/);
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(rail).toHaveClass(/is-open/);

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    for (const [name, path] of [["library", "/app/projects"], ["settings", "/app/settings"], ["billing", "/app/billing"]]) {
      await page.goto(path);
      const workspaceNav = page.getByRole("navigation", { name: "Workspace" });
      await expect(workspaceNav).toBeVisible();
      // Rail nay có mục riêng cho billing, nên trang nào cũng có đúng một mục
      // đang sáng — trước đây billing không khớp mục nào.
      const activeNavItem = workspaceNav.locator('[aria-current="page"]');
      const expectedLabel =
        name === "library" ? "My projects"
        : name === "billing" ? "Credits & plan"
        : "Settings";
      // Chỉ so nhãn: mục billing kèm số credit, mục projects kèm số việc đang chạy.
      await expect(activeNavItem.locator(".rail-label").first()).toHaveText(expectedLabel);
      // Số credit phải có mặt trên MỌI màn, không riêng trang billing.
      await expect(page.locator(".topbar .credit-chip")).toBeVisible();
      // Khối giữ chỗ đã thay chuỗi "Loading …"; vẫn kiểm đúng một ý: dữ liệu đã về.
      if (name === "settings" || name === "library") {
        await expect(page.locator(".skeleton")).toHaveCount(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${path} @ ${width}`).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`), fullPage: true });
    }
  }
});

/**
 * Khung `/app` phải SỐNG qua điều hướng.
 *
 * Trước 21/09 rail render `<a href>` thường kèm `onClick` không gọi
 * `preventDefault`, nên mỗi cú bấm là một lần trình duyệt tải lại cả tài liệu:
 * cây React bị đập bỏ, channel Realtime dựng lại, `/projects?limit=24` gọi lại.
 * Biến cắm trên `window` là cách rẻ nhất để phân biệt điều hướng client với
 * một lần tải lại — reload thì nó biến mất.
 */
test("đổi tab trong workspace không tải lại trang", async ({ page }) => {
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(request.url());
  });

  await signIn(page, state().users.b);
  await page.goto("/app");
  await page.evaluate(() => {
    (window as Window & { __shellAlive?: boolean }).__shellAlive = true;
  });
  const documentsAfterLoad = documents.length;

  const steps: [string, RegExp][] = [
    ["My projects", /\/app\/projects$/],
    ["Settings", /\/app\/settings$/],
    ["Credits & plan", /\/app\/billing$/],
    ["AI CMO", /\/app$/],
  ];
  for (const [label, url] of steps) {
    await page.getByRole("link", { name: label }).first().click();
    await expect(page).toHaveURL(url);
    const navigation = page.getByRole("navigation", { name: "Workspace" });
    // Mục Dashboard có hai dòng ("Dashboard" + "AI CMO"): kiểm nhãn có mặt, không so nguyên văn.
    await expect(navigation.locator('[aria-current="page"] .rail-label').first()).toContainText(label);
    expect(
      await page.evaluate(
        () => (window as Window & { __shellAlive?: boolean }).__shellAlive === true,
      ),
      `${label} tải lại cả trang thay vì điều hướng client`,
    ).toBe(true);
  }

  // Không một request tài liệu nào phát sinh thêm sau lần tải đầu.
  expect(documents.length).toBe(documentsAfterLoad);
});

/** Route lồng sâu vẫn phải sáng ở "My projects" — chỗ mà prop `view` cũ hay sót. */
test("trang một project vẫn sáng mục My projects", async ({ page }) => {
  await signIn(page, state().users.b);
  await page.goto("/app/projects");
  await expect(
    page.getByRole("navigation", { name: "Workspace" }).locator('[aria-current="page"] .rail-label').first(),
  ).toHaveText("My projects");
});
