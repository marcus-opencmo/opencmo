import { expect, test } from "@playwright/test";

import { signIn, state } from "./helpers";

/**
 * Đăng nhập chỉ bằng Google (09/10/2026). E2E không đi tới Google thật: chặn request
 * `/auth/v1/authorize` của Supabase và kiểm nó xin đúng provider + đúng chỗ quay về (callback
 * giữ `next` và website nhập ở landing). Đổi `code` lấy phiên ở `/auth/callback` không đổi so với
 * thời magic link; ở đây kiểm các nhánh lỗi của nó.
 */
test("nút Google xin OAuth với callback đúng", async ({ page }) => {
  let authorize: URL | null = null;
  await page.route(/\/auth\/v1\/authorize/, async (route) => {
    authorize = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: "<p>google</p>" });
  });

  await page.goto("/login?site=https%3A%2F%2Facme.example");
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect.poll(() => authorize?.searchParams.get("provider")).toBe("google");
  const back = new URL(authorize!.searchParams.get("redirect_to")!);
  expect(back.pathname).toBe("/auth/callback");
  expect(back.searchParams.get("next")).toBe("/app");
  expect(back.searchParams.get("site")).toBe("https://acme.example");
});

test("callback: huỷ ở Google hay thiếu mã thì về /login có câu lỗi", async ({ page }) => {
  await page.goto("/auth/callback?error=access_denied&error_description=cancelled");
  await expect(page).toHaveURL(/\/login\?error=huy/);
  await expect(page.locator(".auth-error")).toHaveText("Sign-in was cancelled.");

  await page.goto("/auth/callback");
  await expect(page).toHaveURL(/\/login\?error=thieu-ma/);
  await expect(page.locator(".auth-error")).toContainText("Google did not finish");
});

test("tài khoản free thấy hạn xoá trong app", async ({ page }, testInfo) => {
  await signIn(page, state().users.a);
  await page.goto("/app/settings");
  const banner = page.getByTestId("retention-banner");
  await expect(banner).toContainText("Free accounts are deleted 30 days after sign-up");
  await expect(banner).toContainText("days left");
  await expect(banner.getByRole("link", { name: "See plans" })).toHaveAttribute("href", /billing/);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.screenshot({ path: testInfo.outputPath("retention-390.png") });
});
