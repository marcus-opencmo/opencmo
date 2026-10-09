import { expect, type Page } from "@playwright/test";

import { readState, type E2EUser } from "./global-setup";

export const state = () => readState();

/**
 * Đăng nhập bằng mật khẩu qua trang `/login`? Không — trang đó chỉ có Google.
 * Ở đây lấy phiên bằng mật khẩu qua API Auth (chỉ Supabase local bật email) rồi
 * đặt cookie cho `@supabase/ssr`; `login.spec.ts` kiểm nút Google.
 */
export async function signIn(page: Page, user: E2EUser): Promise<void> {
  const { url, anon } = state();
  const ref = new URL(url).hostname.split(".")[0] || "localhost";
  const response = await page.request.post(`${url}/auth/v1/token?grant_type=password`, {
    headers: { apikey: anon, "content-type": "application/json" },
    data: { email: user.email, password: user.password },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();

  await page.context().addCookies([
    {
      name: `sb-${ref}-auth-token`,
      value: `base64-${Buffer.from(JSON.stringify(session), "utf8").toString("base64")}`,
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
}

/** Chờ project chạy xong. Worker fixture render thật nên vẫn mất vài chục giây. */
export async function waitForClips(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: /clips? ready/i })).toBeVisible({
    timeout: 150_000,
  });
}

/** Mở panel Assistant (cột riêng theo bố cục Palmier, mặc định ẩn ở màn hẹp). */
export async function showAssistant(page: Page): Promise<void> {
  const toggle = page.getByTestId("panel-agent");
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await expect(page.getByLabel("Message the assistant")).toBeVisible();
}

/** Mở tab Clips của editor (G1-c) — chỗ duy nhất tạo clip từ video dài. */
export async function openClipsPanel(page: Page): Promise<void> {
  await page.goto("/app/editor?panel=clips");
  // Lần đầu mở route editor ở server dev có thể phải biên dịch: chờ rộng tay.
  await expect(page.getByTestId("clips-panel")).toBeVisible({ timeout: 120_000 });
  await expect(page).not.toHaveURL(/panel=clips/);
}

/**
 * Upload một video qua tab Clips và tạo job. Trả id job (đọc từ response) — các test cần trang
 * project (tải ZIP, đổi khung) mở `/app/projects/<id>`.
 */
export async function startClipsInEditor(
  page: Page,
  file: string,
  options: { aspect?: "9:16" | "1:1" | "16:9" } = {},
): Promise<string> {
  await openClipsPanel(page);
  await page.getByTestId("clips-file").setInputFiles(file);
  if (options.aspect) await page.getByTestId("clips-panel").getByRole("radio", { name: options.aspect }).check({ force: true });
  const created = page.waitForResponse(
    (response) => response.url().endsWith("/api/v1/editor/clipping") && response.request().method() === "POST",
    { timeout: 120_000 },
  );
  await page.getByTestId("clips-submit").click();
  const response = await created;
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}

/** Upload → chờ clip → Open: editor mở clip đầu tiên của job vừa tạo. */
export async function makeClipsInEditor(page: Page, file: string): Promise<string> {
  const jobId = await startClipsInEditor(page, file);
  const job = page.locator(`[data-job="${jobId}"]`);
  await expect(job.getByTestId("clips-open").first()).toBeVisible({ timeout: 150_000 });
  // Đang đứng ở một bản sửa khác: chờ URL ĐỔI, không chỉ khớp mẫu /app/editor/<id>.
  const current = page.url();
  await job.getByTestId("clips-open").first().click();
  await page.waitForURL((url) => url.href !== current && /\/app\/editor\/[0-9a-f-]+$/.test(url.pathname), { timeout: 60_000 });
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Loading media…")).toHaveCount(0, { timeout: 120_000 });
  return jobId;
}

/** Trang kết quả của job (My projects), chờ xong. */
export async function openProject(page: Page, jobId: string): Promise<void> {
  await page.goto(`/app/projects/${jobId}`);
  await waitForClips(page);
}
