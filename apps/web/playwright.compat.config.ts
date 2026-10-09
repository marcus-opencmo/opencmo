import { defineConfig, devices } from "@playwright/test";

/**
 * Editor trên nhiều trình duyệt — không cần Supabase/worker (xem e2e-compat/compat.spec.ts).
 *
 *     npx playwright test -c playwright.compat.config.ts
 *
 * CI cài firefox + webkit; máy dev chỉ có Chromium thì chạy `--project chromium`.
 */
export default defineConfig({
  testDir: "./e2e-compat",
  timeout: 60_000,
  reporter: process.env.CI ? "github" : "list",
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.E2E_EXECUTABLE ? { launchOptions: { executablePath: process.env.E2E_EXECUTABLE } } : {}),
      },
    },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
