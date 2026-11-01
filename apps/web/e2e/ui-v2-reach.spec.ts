import { mkdirSync } from "node:fs";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { signIn, state } from "./helpers";
import { ensureOnboarded } from "./ui-v2-seed";

/**
 * P6 reach (C2, C4): every card kind decides on a phone (390, the shell's phone layout) and at 1024 (chat as a
 * drawer), axe clean; the thread card and the look note; the morning digest lands in the stack's mail catcher and its
 * link opens the card; Analytics reads stored Zernio numbers. Screenshots go to the P6 acceptance folder.
 * Runs with `npm run test:e2e:v2` (or `NEXT_PUBLIC_OPENCMO_UI=v2 tsx e2e/run.ts ui-v2-reach`).
 */
test.skip(process.env.NEXT_PUBLIC_OPENCMO_UI !== "v2", "v2 UI only: run with npm run test:e2e:v2");
test.beforeAll(ensureOnboarded);

const OUT = join(__dirname, "..", "..", "..", "docs", "plans", "cmo", "2026-10-28-p6-acceptance");

async function axeClean(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** One sample card per kind (and the P6 ones), with the button that decides it. */
const KINDS: { id: string; decide: RegExp }[] = [
  { id: "card-post", decide: /^Approve$/ },
  { id: "card-thread", decide: /^Approve thread$/ },
  { id: "card-reply", decide: /^I replied$/ },
  { id: "card-goal", decide: /^Approve/ },
  { id: "card-script", decide: /^Approve/ },
  { id: "card-price", decide: /^Approve/ },
  { id: "card-finished", decide: /^Approve/ },
  { id: "card-finished-look", decide: /^Approve/ },
  { id: "card-shorts", decide: /^Approve/ },
  { id: "card-slideshow", decide: /^Approve/ },
  { id: "card-time", decide: /^Approve time$/ },
  { id: "card-correction", decide: /^Keep as a rule$/ },
];

for (const kind of KINDS) {
  test(`${kind.id} decides at 390 and 1024, axe clean`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await signIn(page, state().users.a);
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const width of [390, 1024]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
      await page.goto(`/app/inbox/${kind.id}`);
      const card = page.getByTestId("inbox-card-page").getByTestId("approval-card");
      await expect(card).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth), "no sideways scroll").toBeLessThanOrEqual(width);
      await axeClean(page);
      if (kind.id === "card-thread" || kind.id === "card-finished-look") await page.screenshot({ path: join(OUT, `${kind.id}-${width}.png`), fullPage: true });
      const button = card.getByRole("button", { name: kind.decide }).first();
      await expect(button).toBeVisible();
      const box = (await button.boundingBox())!;
      expect(box.x + box.width, "the decide button fits the screen").toBeLessThanOrEqual(width);
      expect(box.height, "a thumb-sized target").toBeGreaterThanOrEqual(32);
      await button.click();
      await expect(card).not.toHaveAttribute("data-status", "waiting");
    }
  });
}

test("the phone layout keeps the queue and the chat one tap away; 1024 has the chat as a drawer", async ({ page }) => {
  await signIn(page, state().users.a);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app?sample=1");
  // The phone tab bar (shell S1-S3): Today, Approve, Calendar, Chat, More. The queue and the chat are one tap each.
  const tabs = page.getByRole("navigation", { name: "Main" }).last();
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole("button", { name: "Chat" })).toBeVisible();
  await expect(tabs.getByRole("link", { name: /^Approve/ })).toBeVisible();
  await expect(page.getByTestId("approval-queue").getByTestId("approval-card").first()).toBeVisible();
  await page.screenshot({ path: join(OUT, "phone-queue-390.png"), fullPage: true });

  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/app?sample=1");
  await expect(page.getByRole("button", { name: /^Chat/ }).first()).toBeVisible();
  await expect(page.getByTestId("approval-queue").getByTestId("approval-card").first()).toBeVisible();
});

test("the thread card numbers its posts and cannot be edited; the look note sits on the video card", async ({ page }) => {
  await signIn(page, state().users.a);
  await page.goto("/app/inbox/card-thread");
  const thread = page.getByTestId("inbox-card-page").getByTestId("approval-card");
  await expect(thread.getByTestId("thread-posts").locator("li")).toHaveCount(6);
  await expect(thread.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(thread).toContainText("posted as one thread on X");

  await page.goto("/app/inbox/card-finished-look");
  const video = page.getByTestId("inbox-card-page").getByTestId("approval-card");
  await expect(video.getByTestId("look-note")).toContainText("captions run past the frame's right edge at 0:12");
  await expect(video.getByTestId("look-note")).not.toContainText(/^Look check: Look check/);
});

test("the morning digest lands in the mail catcher and its link opens the card behind login", async ({ page, request }) => {
  const { url, service, users } = state();
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const user = users.b;
  const hour = new Date().getUTCHours();
  await admin.from("profiles").update({ timezone: "UTC", digest_hour: hour }).eq("id", user.id);
  await admin.from("email_log").delete().eq("user_id", user.id);
  await admin.from("notify_settings").upsert({ user_id: user.id, email_digest: true });
  const { data: item, error } = await admin
    .from("content_items")
    .insert({ user_id: user.id, department: "post", platform: "x", day: new Date().toISOString().slice(0, 10), idea: "Digest card", status: "in_review", body: { text: "A digest card: cut by words.", alternates: [] } })
    .select("id")
    .single();
  expect(error).toBeNull();
  try {
    const cron = await request.get("/api/cron/cmo-digest", { headers: { authorization: "Bearer e2e-cron-secret" } });
    expect(cron.ok()).toBeTruthy();
    expect((await cron.json()).sent).toBeGreaterThanOrEqual(1);
    const again = await request.get("/api/cron/cmo-digest", { headers: { authorization: "Bearer e2e-cron-secret" } });
    expect((await again.json()).sent, "one digest a day").toBe(0);

    // The stack's mail catcher (Mailpit API, as the Supabase CLI ships it).
    const mail = process.env.E2E_INBUCKET_URL!.replace(/\/$/, "");
    let html = "";
    await expect(async () => {
      const list = (await (await fetch(`${mail}/api/v1/search?query=${encodeURIComponent(`to:${user.email}`)}`)).json()) as { messages: { ID: string; Subject: string }[] };
      const digest = list.messages.find((m) => /wait/.test(m.Subject));
      expect(digest).toBeTruthy();
      html = ((await (await fetch(`${mail}/api/v1/message/${digest!.ID}`)).json()) as { HTML: string }).HTML;
    }).toPass({ timeout: 20_000 });
    expect(html).toContain("support@opencmo.io");
    expect(html).toContain("/unsubscribe?token=");
    expect(html).not.toMatch(/approve\?|action=approve/i);
    const link = /href="(http[^"]+\/app\/inbox\/[0-9a-f-]{36})"/.exec(html)![1]!;

    const path = new URL(link).pathname;
    await page.goto(path);
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, user);
    await page.goto(path);
    await expect(page.getByTestId("inbox-card-page").getByTestId("approval-card")).toContainText("A digest card");
    await page.screenshot({ path: join(OUT, "digest-link-card-1024.png"), fullPage: true });

    // The unsubscribe link asks first; the button stops the emails.
    const unsubscribe = /href="(http[^"]+\/unsubscribe\?token=[0-9a-f-]{36})"/.exec(html)![1]!;
    await page.goto(new URL(unsubscribe).pathname + new URL(unsubscribe).search);
    await expect(page.getByRole("heading", { name: "Stop OpenCMO emails?" })).toBeVisible();
    await page.getByRole("button", { name: "Stop emails" }).click();
    await expect(page.getByRole("heading", { name: "You will not get these emails anymore" })).toBeVisible();
    const { data: settings } = await admin.from("notify_settings").select("email_digest").eq("user_id", user.id).single();
    expect(settings!.email_digest).toBe(false);
  } finally {
    await admin.from("content_items").delete().eq("id", item!.id);
    await admin.from("notify_settings").update({ email_digest: true, unsubscribed_at: null }).eq("user_id", user.id);
  }
});

test("Analytics reads stored Zernio numbers for a connected account", async ({ page }) => {
  const { url, service, users } = state();
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const user = users.b;
  await admin.from("zernio_profiles").upsert({ user_id: user.id, zernio_profile_id: `prof-e2e-${user.id.slice(0, 8)}` });
  const { data: account } = await admin
    .from("social_accounts")
    .upsert({ user_id: user.id, platform: "x", handle: "@e2e_founder", zernio_account_id: `acc-e2e-${user.id.slice(0, 8)}`, status: "connected" }, { onConflict: "user_id,platform" })
    .select("id")
    .single();
  const days = Array.from({ length: 30 }, (_, i) => {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    return { user_id: user.id, social_account_id: account!.id, platform: "x", handle: "@e2e_founder", day, followers: 500 - i, impressions: 1000 + (i % 7) * 100, engagements: 40, video_views: null, posts: 1 };
  });
  await admin.from("account_metrics").delete().eq("user_id", user.id);
  expect((await admin.from("account_metrics").insert(days)).error).toBeNull();
  try {
    await signIn(page, user);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/app/analytics");
    await expect(page.getByTestId("v2-analytics")).toBeVisible();
    await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
    await expect(page.getByText("Sample data")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Totals" })).toContainText("Impressions");
    await expect(page.getByRole("region", { name: "By account" }).first()).toContainText("@e2e_founder");
    await axeClean(page);
    await page.screenshot({ path: join(OUT, "analytics-1440.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/app/analytics");
    await expect(page.getByTestId("v2-analytics")).toBeVisible();
    await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: join(OUT, "analytics-390.png"), fullPage: true });

    // The rail says how many accounts Analytics reads.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/app/analytics");
    await expect(page.getByRole("link", { name: /^Analytics, 1 account$/ })).toBeVisible();
  } finally {
    await admin.from("account_metrics").delete().eq("user_id", user.id);
  }
});
