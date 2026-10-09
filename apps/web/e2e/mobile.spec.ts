import { expect, test } from "@playwright/test";

import { signIn, state } from "./helpers";

/**
 * 390px không tràn ngang.
 *
 * Người dùng mở link clip trên điện thoại ngay sau khi nhận nó; một thanh cuộn
 * ngang là dấu hiệu layout vỡ, và nó không bao giờ hiện ra khi phát triển trên
 * màn hình rộng.
 */
test.use({ viewport: { width: 390, height: 844 } });

test("thư viện và các màn workspace vừa màn 390px", async ({ page }) => {
  const { users } = state();
  await signIn(page, users.a);

  for (const path of ["/app", "/app/projects", "/app/settings"]) {
    await page.goto(path);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth, `${path} tràn ngang`).toBeLessThanOrEqual(390);
  }
});

/**
 * Editor mới KHÔNG chạy trên điện thoại, và đó là một quyết định (`VISION.md`
 * non-goals), không phải một lỗi. Thứ phải đúng là cái màn thay thế nó.
 *
 * Cổng vào thuần client và không đọc clip, nên id giả là đủ: điều đang đo là
 * máy này có được cho vào hay không, không phải clip có tồn tại hay không.
 */
test("màn 'mở trên máy tính' thay cho editor, và nó bằng tiếng Anh", async ({ page }) => {
  const { users } = state();
  await signIn(page, users.a);

  const clipId = "00000000-0000-4000-8000-0000000000aa";
  await page.goto(`/app/editor/${clipId}`);

  await expect(page.getByRole("heading", { name: "Open this editor on a computer" })).toBeVisible();
  // Link phải copy được: không có nó thì người dùng phải gõ tay một UUID.
  await expect(page.getByLabel("Link to this clip")).toHaveValue(new RegExp(clipId));
  await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();

  // KHÔNG được chuyển sang /editor: bundle 1,75 MB trên 4G để rồi báo lỗi.
  await expect(page).toHaveURL(/\/app\/editor\/[0-9a-f-]+$/);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, "màn cổng vào tràn ngang").toBeLessThanOrEqual(390);
});
