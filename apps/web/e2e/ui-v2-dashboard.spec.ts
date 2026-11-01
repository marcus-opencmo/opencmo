import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { signIn, state } from "./helpers";
import { ensureOnboarded } from "./ui-v2-seed";

/**
 * The v2 Dashboard (U3, U4). Runs only in a build with NEXT_PUBLIC_OPENCMO_UI=v2: `npm run test:e2e:v2`.
 * One test on the fixture (`?sample=1`), one on real `approvals` rows decided through `approval_decide`.
 */
test.skip(process.env.NEXT_PUBLIC_OPENCMO_UI !== "v2", "v2 UI only: run with npm run test:e2e:v2");
test.beforeAll(ensureOnboarded);

test("on the fixture, approving drops every count, logs it, and empties the queue", async ({ page }) => {
  await signIn(page, state().users.a);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/app?sample=1");

  const queue = page.getByTestId("approval-queue");
  const headline = page.getByTestId("dash-headline");
  // The rail's status line under Dashboard (three-column shell): "N waiting on you".
  const badge = page.getByRole("navigation", { name: "Main" }).getByTestId("rail-pending");
  await expect(queue.getByTestId("approval-card")).toHaveCount(5);
  await expect(headline).toHaveText("5 things wait on you.");
  await expect(badge).toHaveText("5 waiting on you");
  const writer = page.getByRole("link", { name: /^Writer, working/ });
  await expect(writer).toContainText("1 waiting on you");

  await queue.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(headline).toHaveText("4 things wait on you.");
  await expect(badge).toHaveText("4 waiting on you");
  await expect(queue.getByTestId("queue-count")).toHaveText("4");
  await expect(writer).toContainText("Nothing waiting");
  await expect(page.getByTestId("live-log").locator("li").first()).toContainText("You approved the X post");

  // The schedule card decides the TikTok row of "Going out today".
  await queue.getByRole("button", { name: /Short 1 to TikTok/ }).click();
  await queue.getByRole("button", { name: "Approve time" }).click();
  await expect(page.getByRole("row", { name: /Edit by asking/ })).toContainText("Scheduled");

  // Dismissing asks for an optional reason before the card leaves.
  await queue.getByRole("button", { name: /r\/SaaS/ }).click();
  await queue.getByRole("button", { name: "Dismiss" }).click();
  await queue.getByLabel(/Why\?/).fill("Not my audience");
  await queue.locator(".v2-card-decline").getByRole("button", { name: "Dismiss" }).click();
  await expect(headline).toHaveText("2 things wait on you.");

  while ((await queue.getByTestId("approval-card").count()) > 0) {
    await queue.locator(".v2-card[data-open] .v2-button.is-primary").first().click();
  }
  await expect(headline).toHaveText("Nothing waits on you.");
  await expect(queue).toContainText("Nothing waits on you.");
  await expect(badge).toHaveCount(0);
});

test("on live rows, cards decide through approval_decide, a changed card is refused, Realtime refreshes", async ({ page }) => {
  const { url, service, users } = state();
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const user = users.b;
  const post = async (text: string) => {
    const { data, error } = await admin
      .from("content_items")
      .insert({ user_id: user.id, department: "post", platform: "x", day: new Date().toISOString().slice(0, 10), idea: text, status: "in_review", body: { text, alternates: [] } })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  };
  const first = await post("Live card one: cut a video by deleting words.");
  const second = await post("Live card two: ask for B-roll on the line.");

  try {
    await signIn(page, user);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/app");
    const queue = page.getByTestId("approval-queue");
    const headline = page.getByTestId("dash-headline");
    await expect(queue.getByText("Sample data")).toHaveCount(0);
    await expect(queue.getByTestId("approval-card")).toHaveCount(2);
    await expect(headline).toHaveText("2 things wait on you.");

    // Approve the first (open) card: the server decides it and the post moves on.
    await queue.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(headline).toHaveText("1 thing waits on you.");
    await expect.poll(async () => (await admin.from("content_items").select("status").eq("id", first).single()).data?.status).toBe("approved");
    await expect.poll(async () => (await admin.from("approvals").select("status, decided_via").eq("ref_id", first).eq("status", "approved").maybeSingle()).data?.decided_via).toBe("app");

    // The second card changes after the page read it. The old hash is refused by the route the cards use, and
    // Realtime brings the new version to the screen without a reload.
    const { data: stale } = await admin.from("approvals").select("id, content_hash").eq("ref_id", second).eq("status", "waiting").single();
    await admin.from("content_items").update({ body: { text: "Live card two, redrafted.", alternates: [] } }).eq("id", second);
    const refused = await page.request.post(`/api/v1/approvals/${stale!.id}`, { data: { action: "approve", contentHash: stale!.content_hash } });
    expect(refused.ok()).toBeFalsy();
    expect(JSON.stringify(await refused.json())).toMatch(/already decided|changed/);
    await expect(queue).toContainText("Live card two, redrafted.");
    expect((await admin.from("content_items").select("status").eq("id", second).single()).data?.status).toBe("in_review");

    // One card on its own page reads the same row.
    const { data: card } = await admin.from("approvals").select("id").eq("ref_id", second).eq("status", "waiting").single();
    await page.goto(`/app/inbox/${card!.id}`);
    await expect(page.getByTestId("inbox-card-page").getByTestId("approval-card")).toContainText("Live card two, redrafted.");
  } finally {
    await admin.from("content_items").delete().in("id", [first, second]);
  }
});

test("the phone shows the team list, the tab bar count and one card per page", async ({ page }) => {
  await signIn(page, state().users.a);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app?sample=1");

  await expect(page.getByRole("region", { name: "Your team" })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Main" }).filter({ hasText: "Today" });
  await expect(tabs.getByRole("link", { name: "Approve · 5" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await tabs.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("dialog", { name: "More" }).getByRole("link", { name: "Library" })).toBeVisible();
  await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Close" }).click();

  await page.goto("/app/inbox/card-reply");
  await expect(page.getByTestId("inbox-card-page").getByTestId("approval-card")).toContainText("r/SaaS");
  await page.goto("/app/inbox/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("This card is no longer here.")).toBeVisible();
});
