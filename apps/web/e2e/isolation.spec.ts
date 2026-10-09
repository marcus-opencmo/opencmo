import { expect, test } from "@playwright/test";

import { signIn, state } from "./helpers";

/**
 * Cách ly giữa hai tài khoản.
 *
 * Kiểm CẢ HAI tầng: API trả 404 (không phải 403 — 403 xác nhận project có
 * thật), và trang không hiện gì của người khác.
 */
test("user B không mở được project của user A", async ({ page }) => {
  const { users, url, service } = state();

  // Dựng project của A bằng service role: nhanh hơn chạy cả pipeline một lần nữa.
  const created = await page.request.post(`${url}/rest/v1/jobs`, {
    headers: {
      apikey: service,
      authorization: `Bearer ${service}`,
      "content-type": "application/json",
      prefer: "return=representation",
    },
    data: {
      user_id: users.a.id,
      source_url: "https://youtu.be/isolation",
      status: "done",
      stage: "done",
      clips_requested: 1,
    },
  });
  const [job] = await created.json();

  await signIn(page, users.b);

  const api = await page.request.get(`/api/v1/projects/${job.id}`);
  expect(api.status()).toBe(404);

  await page.goto(`/app/projects/${job.id}`);
  await expect(page.getByText(/no longer in your library|not found/i)).toBeVisible();
});
