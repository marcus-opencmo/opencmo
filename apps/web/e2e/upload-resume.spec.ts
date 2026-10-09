import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { RESUME_VIDEO } from "./global-setup";
import { openClipsPanel, signIn, state } from "./helpers";

test("TUS tiếp tục sau khi một chunk bị ngắt", async ({ page }) => {
  const { users, url, service } = state();
  await signIn(page, users.b);
  await openClipsPanel(page);

  let patches = 0;
  let interrupted = false;
  await page.route("**/storage/v1/upload/resumable/**", async (route) => {
    if (route.request().method() === "PATCH") {
      patches += 1;
      if (patches === 2 && !interrupted) {
        interrupted = true;
        await route.abort("connectionreset");
        return;
      }
    }
    await route.continue();
  });

  // Stop after Storage succeeds: this test isolates resumability and does not
  // spend another minute rendering the same fixture.
  await page.route("**/api/v1/editor/clipping", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Upload resume verified." }),
    });
  });

  // Tab Clips của editor: upload là đường chính.
  await page.getByTestId("clips-file").setInputFiles(RESUME_VIDEO);
  await page.getByTestId("clips-submit").click();
  await expect(page.getByText("Upload resume verified.", { exact: true })).toBeVisible({
    timeout: 90_000,
  });

  expect(interrupted).toBeTruthy();
  expect(patches).toBeGreaterThanOrEqual(51);

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data, error } = await admin.storage.from("sources").list(users.b.id);
  expect(error).toBeNull();
  expect(data?.filter((item) => item.name.endsWith(".mp4"))).toHaveLength(1);
});
