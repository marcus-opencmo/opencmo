import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { signIn, state } from "./helpers";

/**
 * Tầng CMO đợt 1–2, chạy thật trên Supabase local với model + Reddit giả (OPENCMO_AGENT_FAKE=1):
 * lập lịch tuần (W1) → soạn bài X (W2) → duyệt → đăng hỗ trợ (W3) → quét Reddit (W4) → chat CMO.
 *
 * User riêng (tạo ở đây) để document đã gieo không đổi màn `/app` của test khác.
 */
test("AI CMO: lập lịch, soạn bài X, duyệt, đánh dấu đã đăng, quét Reddit, chat", async ({ page }) => {
  test.setTimeout(240_000);
  const { url, service } = state();
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const email = `e2e-cmo-${Date.now()}@test.local`;
  const password = "e2e-cmo-password";
  const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !created.user) throw new Error(`Không tạo được user: ${error?.message}`);
  const userId = created.user.id;
  await admin.from("credit_ledger").insert({ user_id: userId, delta: 50, reason: "E2E top-up" });
  const docs = {
    product: { name: "Paylane", category: "SaaS", one_liner: "Invoicing that chases late payments for freelancers.", description: "Reminders on day 3, 7 and 14.", audience: "Freelancers", problems: ["Late payments"], features: ["Reminders"], pricing: "$12/month" },
    strategy: { icp: "Freelancers who invoice 3 to 15 clients a month and hate chasing payments.", pains: ["Late payments", "Awkward follow-ups"], positioning: "Invoicing that follows up for you.", value_props: ["Get paid faster"], voice: "Plain and friendly, a little dry.", avoid: ["revolutionary"] },
    competitors: { competitors: [{ name: "FreshBooks", website: "https://www.freshbooks.com", difference: "Simpler" }] },
    content_strategy: { pillars: [{ name: "Getting paid", why: "Core pain", ideas: ["The 3-7-14 reminder rule", "Why invoices go unpaid"] }], x: "One post a day.", reddit: "Help in r/freelance.", short_video: "Clips from demos.", cadence: "Daily" },
  };
  for (const [kind, body] of Object.entries(docs)) {
    const { error: insertError } = await admin.from("marketing_documents").insert({ user_id: userId, kind, version: 1, body, created_by: "agent" });
    if (insertError) throw new Error(insertError.message);
  }

  await signIn(page, { email, password, id: userId });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/app");
  await expect(page.getByTestId("cmo-workspace")).toBeVisible();

  // W1: Plan my week → lịch có mục, mỗi mục sửa/xoá được.
  await page.getByTestId("cmo-plan-week").click();
  const calendar = page.locator(".cmo-calendar li");
  await expect(calendar.first()).toBeVisible({ timeout: 60_000 });
  expect(await calendar.count()).toBeGreaterThanOrEqual(5);

  // W2: X Agent → Run now → thẻ bài X chờ duyệt.
  // Hàng agent mở ra giữ nguyên trạng thái mở → nút Run now phải tìm trong đúng hàng.
  const agentRow = (name: RegExp) => page.locator(".cmo-agent-row", { has: page.getByRole("button", { name }) });
  await page.getByRole("button", { name: /^X Agent/ }).click();
  await agentRow(/^X Agent/).getByRole("button", { name: "Run now" }).click();
  const card = page.getByTestId("cmo-feed-post").first();
  await expect(card).toBeVisible({ timeout: 60_000 });

  // W3 đăng hỗ trợ: Approve → "Post on X" mở trang soạn sẵn của X → đánh dấu đã đăng.
  await card.getByRole("button", { name: "Approve" }).click();
  const postLink = card.getByRole("link", { name: /Post on X/ });
  await expect(postLink).toBeVisible();
  expect(await postLink.getAttribute("href")).toMatch(/^https:\/\/x\.com\/intent\/post\?text=/);
  await card.getByRole("button", { name: "I posted it" }).click();
  await expect(page.getByTestId("cmo-feed-post")).toHaveCount(0);

  // W4: Reddit Agent → Run now → thẻ thread có điểm + bằng chứng + trả lời; KHÔNG có nút đăng.
  await page.getByRole("button", { name: /^Reddit Agent/ }).click();
  await agentRow(/^Reddit Agent/).getByRole("button", { name: "Run now" }).click();
  const sales = page.getByTestId("cmo-feed-sales").first();
  await expect(sales).toBeVisible({ timeout: 90_000 });
  await sales.getByRole("button", { name: "View reply" }).click();
  const drawer = page.getByTestId("cmo-card-sales");
  await expect(drawer.getByRole("link", { name: /Open thread/ })).toHaveAttribute("href", /^https:\/\/www\.reddit\.com\//);
  await drawer.getByRole("button", { name: /See why/ }).click();
  await expect(drawer.locator(".cmo-parts li")).toHaveCount(5);
  await expect(drawer.getByRole("button", { name: /^(Post|Publish|Reply)\b/ })).toHaveCount(0);
  const before = await page.getByTestId("cmo-feed-sales").count();
  await drawer.getByRole("button", { name: "I replied" }).click();
  await expect(page.getByTestId("cmo-feed-sales")).toHaveCount(before - 1);

  // W5: Video Agent → New video pack. Link chỉ gửi được sau khi xác nhận chính chủ (luật sản phẩm 3).
  await page.getByRole("button", { name: /^Video Agent/ }).click();
  await page.getByRole("button", { name: "New video pack" }).click();
  const pack = page.getByRole("dialog", { name: "New video pack" });
  await pack.getByRole("button", { name: "Paste a link instead" }).click();
  await pack.getByLabel("Paste a public video link").fill("https://youtu.be/dQw4w9WgXcQ");
  const make = pack.getByRole("button", { name: "Make my clips" });
  await expect(make).toBeDisabled();
  await pack.getByRole("checkbox", { name: /Is this your YouTube video\?/ }).check();
  await expect(make).toBeEnabled();
  await pack.getByRole("button", { name: "Cancel" }).click();
  await expect(pack).toBeHidden();

  // Activity: console mở ngay dưới thanh trên (không phải hộp thoại), ghi từng bước của W1, W2 và W4.
  await page.getByTestId("cmo-log-open").click();
  const consoleLog = page.getByTestId("cmo-log");
  await expect(consoleLog.getByText("next_due_item")).toBeVisible();
  await expect(consoleLog.getByText("reddit_search")).toBeVisible();
  await expect(page.getByTestId("cmo-feed-sales").first()).toBeVisible();
  await page.getByTestId("cmo-log-open").click();
  await expect(page.getByTestId("cmo-log-open")).toHaveAttribute("aria-expanded", "false");

  // Marketing plan nằm TRONG dashboard: tài liệu mở thành sheet, URL mang ?doc=, không tải lại trang.
  await page.evaluate(() => ((window as unknown as { __stay: boolean }).__stay = true));
  await page.getByTestId("cmo-docrow-strategy").click();
  const sheet = page.getByTestId("cmo-doc-sheet");
  await expect(sheet.getByRole("heading", { name: "Marketing Strategy" })).toBeVisible();
  await expect(page).toHaveURL(/\/app\?doc=strategy$/);
  // Sheet nằm trên màn 4 cột: rail vẫn thu thành cột icon, không bung ra ép cột.
  await expect(page.locator(".rail")).not.toHaveClass(/is-open/);
  await sheet.getByRole("button", { name: "Edit" }).click();
  await sheet.getByLabel("Brand voice").fill("Short, warm, no jargon.");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet.getByText("Short, warm, no jargon.")).toBeVisible();
  await expect(sheet.getByText(/Edited by you · version 2/)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(sheet.getByRole("heading", { name: "Competitor Analysis" })).toBeVisible();
  await expect(page).toHaveURL(/\?doc=competitors$/);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/\/app$/);
  expect(await page.evaluate(() => (window as unknown as { __stay?: boolean }).__stay)).toBe(true);
  // Link cũ /app/cmo vẫn tới đúng chỗ.
  await page.goto("/app/cmo");
  await expect(page).toHaveURL(/\/app\?doc=product$/);
  await expect(page.getByTestId("cmo-doc-sheet").getByRole("heading", { name: "Product Information" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Chat CMO (agent duy nhất): nhớ một điều người dùng dặn.
  await page.getByLabel("Ask your CMO").fill("Remember: never mention pricing in posts.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".cmo-msg.is-cmo").last()).toContainText("Noted", { timeout: 30_000 });
  const { data: memories } = await admin.from("cmo_memories").select("body").eq("user_id", userId);
  expect((memories ?? []).map((m) => m.body)).toContain("never mention pricing in posts.");

  // H2/H3: CMO nghiên cứu bằng tool ScrapeCreators (giả) rồi GIAO VIỆC cho agent Sales có brief.
  const { count: scansBefore } = await admin.from("cmo_runs").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("kind", "sales_scan");
  await page.getByLabel("Ask your CMO").fill("Do some research on who needs this");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".cmo-msg.is-cmo").last()).toContainText("On it", { timeout: 60_000 });
  await expect
    .poll(async () => (await admin.from("cmo_runs").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("kind", "sales_scan")).count, { timeout: 30_000 })
    .toBe((scansBefore ?? 0) + 1);
  const { data: briefed } = await admin.from("cmo_runs").select("input").eq("user_id", userId).eq("kind", "sales_scan").order("created_at", { ascending: false }).limit(1);
  expect(String((briefed?.[0]?.input as { brief?: string })?.brief)).toContain("reddit.com");

  // Việc video: thành mục lịch có nút Make clips mở tab Clips của editor (người dùng tự đưa video).
  await page.getByLabel("Ask your CMO").fill("Make clips from my onboarding video");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".cmo-msg.is-cmo").last()).toContainText("Added to your calendar", { timeout: 60_000 });
  const makeClips = page.getByTestId("cmo-make-clips").first();
  await expect(makeClips).toBeVisible({ timeout: 30_000 });
  await expect(makeClips).toHaveAttribute("href", "/app/editor?panel=clips&count=3&length=short");

  // Chat mới + lịch sử: cuộc vừa rồi nằm trong danh sách và mở lại được.
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.locator(".cmo-msg.is-user")).toHaveCount(0);
  await page.getByRole("button", { name: "Past conversations" }).click();
  await page.getByRole("menuitem", { name: /Remember: never mention pricing/ }).click();
  await expect(page.locator(".cmo-msg.is-user").first()).toContainText("never mention pricing");

  // H5: cột Results đọc số thật (post_metrics của bài đã "I posted it") và "What works now" của W7.
  const { data: posted } = await admin.from("content_items").select("id").eq("user_id", userId).eq("status", "published").limit(1);
  expect(posted?.length).toBe(1);
  await admin.rpc("cmo_save_metrics", { p_user: userId, p_rows: [{ item_id: posted![0]!.id, url: "https://x.com/paylane/status/1", views: 2400, likes: 31, replies: 5, reposts: 2 }] });
  await admin.rpc("cmo_save_insight", {
    p_user: userId,
    p_run: null,
    p_kind: "competitors",
    p_body: { accounts: [], hooks: [{ pattern: "Name the pain, then the shortcut", example: "Stop chasing invoices.", url: "https://x.com/freshbooks/status/9", lift: 6.2, why: "pain" }], formats: [], ideas: [], measured_at: new Date().toISOString() },
  });
  await page.reload();
  await expect(page.getByTestId("cmo-workspace")).toBeVisible();
  const results = page.locator("section[aria-labelledby='cmo-analytics-title']");
  await expect(results.locator(".cmo-tile-num", { hasText: "2,400" })).toBeVisible({ timeout: 30_000 });
  await expect(results.getByTestId("cmo-insight")).toContainText("Name the pain, then the shortcut");
  // SEO / Links chưa có nguồn thật: không hiện tab chỉ bật toast.
  await expect(results.getByRole("tab", { name: "SEO" })).toHaveCount(0);

  await admin.auth.admin.deleteUser(userId);
});
