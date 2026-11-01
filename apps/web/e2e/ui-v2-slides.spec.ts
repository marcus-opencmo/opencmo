import { createHmac, randomUUID } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import type { E2EUser } from "./global-setup";
import { signIn, state } from "./helpers";

/**
 * P5 C3 (sessions/C.md): a 5-slide slideshow built in the Slides view, a slideshow card approved, and a help-only
 * Sales card that says why and has no post button. Rows come from the same RPCs the squad and the scan use, so no
 * worker or model runs. v2 build only: `npm run test:e2e:slides`.
 */
test.skip(process.env.NEXT_PUBLIC_OPENCMO_UI !== "v2", "v2 UI only: run with npm run test:e2e:slides");

const admin = () => {
  const { url, service } = state();
  return createClient(url, service, { auth: { persistSession: false } });
};

/** The founder's session as Studio's order runner has it: only it records squad steps. */
function brainClient(userId: string): SupabaseClient {
  const { url, anon } = state();
  const now = Math.floor(Date.now() / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ opencmo_actor: "brain", sub: userId, role: "authenticated", aud: "authenticated", iat: now, exp: now + 600 })}`;
  const token = `${body}.${createHmac("sha256", process.env.SUPABASE_JWT_SECRET!).update(body).digest("base64url")}`;
  return createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
}

/** A founder of their own per test, past Setup, with the order runner paused so it leaves this test's rows alone. */
async function founder(db: SupabaseClient): Promise<{ user: E2EUser; me: SupabaseClient }> {
  const { url, anon } = state();
  const user = { email: `slides-${randomUUID()}@test.local`, password: `pw-${randomUUID()}`, id: "" };
  const created = await db.auth.admin.createUser({ email: user.email, password: user.password, email_confirm: true });
  expect(created.error).toBeNull();
  user.id = created.data.user!.id;
  await db.from("profiles").update({ credit_balance: 100, plan: "creator", cmo_paused_at: new Date().toISOString() }).eq("id", user.id);
  const doc = await db
    .from("marketing_documents")
    .insert({ user_id: user.id, kind: "product", version: 1, created_by: "user", body: { name: "OpenCMO", one_liner: "An AI CMO for solo founders." } });
  expect(doc.error).toBeNull();
  const me = createClient(url, anon, { auth: { persistSession: false } });
  expect((await me.auth.signInWithPassword({ email: user.email, password: user.password })).error).toBeNull();
  return { user, me };
}

type SlideGroup = { kind: string; start: number; end: number; marks?: { visual?: { op?: string } }; children: { name: string; text?: string; fill?: string }[] };

/** The slides of the edit as saved, in play order. */
async function savedSlides(page: Page, clipId: string): Promise<SlideGroup[]> {
  const response = await page.request.get(`/api/v1/editor/project?clip_id=${clipId}`);
  expect(response.ok()).toBeTruthy();
  const { document } = (await response.json()) as { document: { stage: { children: { kind: string; active?: boolean; children?: SlideGroup[] }[] } } };
  const scene = document.stage.children.find((node) => node.kind === "scene" && node.active) ?? document.stage.children.find((node) => node.kind === "scene");
  return (scene?.children ?? []).filter((node) => node.kind === "group" && node.marks?.visual?.op === "add_slide").sort((a, b) => a.start - b.start);
}

const heading = (slide: SlideGroup) => slide.children.find((child) => child.name === "Heading")?.text;

async function noSeriousAxe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("New slideshow: build 5 slides in the Slides view, reorder, retime, and switch to the Timeline", async ({ page }) => {
  const { user } = await founder(admin());
  await signIn(page, user);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/app/studio");
  await page.getByTestId("studio-new").click();
  await page.getByTestId("new-slideshow").click();
  await expect(page).toHaveURL(/\/app\/editor\/[0-9a-f-]{36}\?view=slides/);
  const clipId = /\/app\/editor\/([0-9a-f-]{36})/.exec(page.url())![1]!;

  const strip = page.getByTestId("slides-strip");
  await expect(strip).toBeVisible();
  // The timeline is hidden in the Slides view.
  await expect(page.locator(".ed2-tl-wrap")).toHaveCount(0);

  const panel = page.getByTestId("slide-panel");
  const words = ["Cut a video by deleting words", "Upload your own video", "Delete a sentence", "Add captions in one click", "Try it on your next demo"];
  for (const [index, text] of words.entries()) {
    await strip.getByTestId("slide-add").click();
    await expect(strip.getByTestId("slide-item")).toHaveCount(index + 1);
    // A new slide follows the one on screen and becomes the one on screen.
    await strip.getByTestId("slide-item").nth(index).getByRole("button", { name: /^Slide \d+:/ }).click();
    await panel.getByTestId("slide-heading").fill(text);
    await panel.getByTestId("slide-heading").press("Enter");
    await expect(strip.getByTestId("slide-item").nth(index)).toContainText(text);
  }

  // Slide 5 moves to the front; slide 1 (now 2) shows for 6 s.
  await strip.getByRole("button", { name: "Move slide 5 up" }).click();
  await strip.getByRole("button", { name: "Move slide 4 up" }).click();
  await strip.getByRole("button", { name: "Move slide 3 up" }).click();
  await strip.getByRole("button", { name: "Move slide 2 up" }).click();
  await expect(strip.getByTestId("slide-item").first()).toContainText("Try it on your next demo");
  await strip.getByTestId("slide-item").nth(1).getByRole("button", { name: /^Slide 2:/ }).click();
  await panel.getByTestId("slide-seconds").fill("6");
  await panel.getByTestId("slide-seconds").press("Enter");
  await panel.getByTestId("slide-body").fill("No timeline needed.");
  await panel.getByTestId("slide-body").blur();

  // Saved as five slides that touch, in the new order, with the new length and words.
  await expect.poll(async () => (await savedSlides(page, clipId)).map(heading), { timeout: 30_000 }).toEqual([words[4], words[0], words[1], words[2], words[3]]);
  const saved = await savedSlides(page, clipId);
  expect(saved[1]!.end - saved[1]!.start).toBe(6);
  expect(saved[1]!.children.find((child) => child.name === "Body")?.text).toBe("No timeline needed.");
  for (let index = 1; index < saved.length; index++) expect(saved[index]!.start).toBe(saved[index - 1]!.end);

  // Drag the last slide onto the first; delete one; give one a colour of its own.
  await strip.getByTestId("slide-item").nth(4).dragTo(strip.getByTestId("slide-item").nth(0));
  await expect(strip.getByTestId("slide-item").first()).toContainText(words[3]!);
  await strip.getByTestId("slide-item").nth(4).getByTestId("slide-delete").click();
  await expect(strip.getByTestId("slide-item")).toHaveCount(4);
  await strip.getByTestId("slide-item").nth(0).getByRole("button", { name: /^Slide 1:/ }).click();
  await panel.getByTestId("slide-color").fill("#ffd400");
  await panel.getByTestId("slide-color").blur();
  await expect
    .poll(async () => (await savedSlides(page, clipId)).map((slide) => [heading(slide), slide.children.find((child) => child.name === "Background")?.fill]), { timeout: 30_000 })
    .toEqual([[words[3], "#FFD400"], [words[4], expect.anything()], [words[0], expect.anything()], [words[1], expect.anything()]]);
  await strip.getByTestId("slide-add").click();
  await expect(strip.getByTestId("slide-item")).toHaveCount(5);

  await page.screenshot({ path: test.info().outputPath("slides-view-1440.png") });

  // "Timeline" is the full editor on the same document; "Slides" comes back.
  await strip.getByTestId("slides-timeline").click();
  await expect(page.locator(".ed2-tl-wrap")).toBeVisible();
  await page.getByTestId("tool-slides").click();
  await expect(page.getByTestId("slides-strip")).toBeVisible();
});

test("Slideshow card: slides, quick text edit, approve finishes the order", async ({ page }) => {
  const db = admin();
  const { user, me } = await founder(db);

  // A slideshow the squad made: its edit, its order, and both renders of the document as it is.
  const { data: clipId, error: clipError } = await me.rpc("create_slideshow", { p_name: "3 ways to cut a demo", p_aspect: "9:16" });
  expect(clipError).toBeNull();
  const empty = { version: 1, stage: { name: "3 ways to cut a demo" } };
  expect((await db.from("editor_projects").insert({ clip_id: clipId, document: empty })).error).toBeNull();
  const { data: clipRow } = await db.from("clips").select("job_id").eq("id", clipId).single();
  const { data: hash } = await db.rpc("editor_document_hash", { p_document: empty });
  const root = await db.rpc("work_order_week_root", { p_user: user.id });
  expect(root.error).toBeNull();
  const parent = (Array.isArray(root.data) ? root.data[0] : root.data) as { id: string; week: string };
  const order = await db.rpc("work_order_create", { p_user: user.id, p_week: parent.week, p_parent: parent.id, p_kind: "build_slideshow", p_title: "3 ways to cut a demo" });
  expect(order.error).toBeNull();
  const orderId = (Array.isArray(order.data) ? order.data[0] : order.data).id as string;
  expect((await db.rpc("work_order_move", { p_id: orderId, p_to: "running" })).error).toBeNull();
  const mp4 = randomUUID();
  const stills = randomUUID();
  const tasks = [mp4, stills].map((id, index) => ({
    id,
    user_id: user.id,
    kind: index === 0 ? "render_document" : "render_stills",
    clip_id: clipId,
    job_id: clipRow!.job_id,
    status: "queued",
    request_id: randomUUID(),
    payload: {},
    settings_hash: hash,
  }));
  expect((await db.from("tasks").insert(tasks)).error).toBeNull();
  // Writer's TikTok caption for this slideshow: the card carries it, as a finished video's (P5 A3).
  const caption = await db.from("content_items").insert({
    user_id: user.id,
    department: "video",
    platform: "tiktok_caption",
    clip_id: clipId,
    day: new Date().toISOString().slice(0, 10),
    idea: "3 ways to cut a demo",
    status: "in_review",
    body: { text: "Three ways to cut a demo #editing" },
  });
  expect(caption.error).toBeNull();
  const slides = ["3 ways to cut a demo", "1. Cut by words", "2. Ask for B-roll"].map((text) => ({ text, still_path: null, seconds: 3 }));
  const step = await brainClient(user.id).rpc("studio_slideshow_rendering", {
    p_order_id: orderId,
    p_clip_id: clipId,
    p_input: {},
    p_card: { title: "3 ways to cut a demo", aspect: "9:16", slides, mp4_path: null, png_set_path: null },
    p_mp4_task: mp4,
    p_stills_task: stills,
  });
  expect(step.error).toBeNull();
  expect((await db.from("tasks").update({ status: "done", finished_at: new Date().toISOString() }).in("id", [mp4, stills])).error).toBeNull();
  const { data: card } = await db.from("approvals").select("id").eq("user_id", user.id).eq("kind", "slideshow").eq("status", "waiting").single();

  await signIn(page, user);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    await page.goto(`/app/inbox/${card!.id}`);
    const shown = page.getByTestId("inbox-card-page").getByTestId("approval-card");
    await expect(shown).toBeVisible();
    await expect(shown.getByRole("list", { name: "3 slides" }).getByRole("listitem")).toHaveCount(3);
    await expect(shown.getByRole("link", { name: "Open in Slides" })).toHaveAttribute("href", `/app/editor/${clipId}?view=slides`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await noSeriousAxe(page);
  }

  const shown = page.getByTestId("inbox-card-page").getByTestId("approval-card");
  // A caption edited on the card: the card keeps its id with a new hash, and Approve sends that hash.
  const before = (await db.from("approvals").select("content_hash").eq("id", card!.id).single()).data!.content_hash;
  await shown.getByRole("button", { name: /^Edit / }).first().click();
  await shown.getByTestId("caption").getByLabel("Caption").fill("Three ways to cut a demo by words #editing");
  await shown.getByRole("button", { name: "Save caption" }).click();
  await expect.poll(async () => (await db.from("approvals").select("content_hash").eq("id", card!.id).single()).data?.content_hash).not.toBe(before);
  await expect(shown).toContainText("Three ways to cut a demo by words #editing");
  await shown.getByRole("button", { name: "Approve" }).click();
  await expect.poll(async () => (await db.from("approvals").select("status").eq("id", card!.id).single()).data?.status).toBe("approved");
  await expect.poll(async () => (await db.from("work_orders").select("status").eq("id", orderId).single()).data?.status).toBe("done");
  const { data: deliverable } = await db.from("deliverables").select("kind, ref_id").eq("user_id", user.id).eq("kind", "slideshow").single();
  expect(deliverable).toEqual({ kind: "slideshow", ref_id: clipId });

  // A quick text edit (sample card: nothing is sent): the renders are older, so Approve waits for the new card.
  await page.goto("/app/inbox/card-slideshow");
  const sample = page.getByTestId("inbox-card-page").getByTestId("approval-card");
  await sample.getByRole("button", { name: /^Slide 2,/ }).click();
  await sample.getByLabel("Slide 2 heading").fill("Cut by deleting words");
  await sample.getByRole("button", { name: "Save slide 2" }).click();
  await expect(sample.getByTestId("slideshow-edited")).toBeVisible();
  await expect(sample.getByRole("list", { name: "3 slides" })).toContainText("Cut by deleting words");
  await expect(sample.getByRole("button", { name: "Approve" })).toBeDisabled();
});

/**
 * A slideshow with real slides and a waiting card, the way the squad leaves it: the founder's own edit (built through
 * the ops route), a Slideshow order, both renders of the document as it is, done.
 */
async function liveSlideshow(page: Page, db: SupabaseClient, user: E2EUser, me: SupabaseClient) {
  const { data: clipId, error } = await me.rpc("create_slideshow", { p_name: "Three cuts", p_aspect: "9:16" });
  expect(error).toBeNull();
  const opened = await page.request.get(`/api/v1/editor/project?clip_id=${clipId}`);
  expect(opened.ok()).toBeTruthy();
  const { version } = (await opened.json()) as { version: number };
  const built = await page.request.post("/api/v1/editor/ops", {
    data: { clip_id: clipId, expected_version: version, ops: ["Cut by words", "Ask for B-roll", "Try it"].map((heading) => ({ op: "add_slide", heading })) },
  });
  expect(built.ok(), await built.text()).toBeTruthy();
  const root = await db.rpc("work_order_week_root", { p_user: user.id });
  const parent = (Array.isArray(root.data) ? root.data[0] : root.data) as { id: string; week: string };
  const order = await db.rpc("work_order_create", { p_user: user.id, p_week: parent.week, p_parent: parent.id, p_kind: "build_slideshow", p_title: "Three cuts" });
  const orderId = (Array.isArray(order.data) ? order.data[0] : order.data).id as string;
  expect((await db.rpc("work_order_move", { p_id: orderId, p_to: "running" })).error).toBeNull();
  const { data: clipRow } = await db.from("clips").select("job_id").eq("id", clipId).single();
  const { data: project } = await db.from("editor_projects").select("document_hash").eq("clip_id", clipId).single();
  const [mp4, stills] = [randomUUID(), randomUUID()];
  const rows = [mp4, stills].map((id, index) => ({ id, user_id: user.id, kind: index ? "render_stills" : "render_document", clip_id: clipId, job_id: clipRow!.job_id, status: "queued", request_id: randomUUID(), payload: {}, settings_hash: project!.document_hash }));
  expect((await db.from("tasks").insert(rows)).error).toBeNull();
  const slides = ["Cut by words", "Ask for B-roll", "Try it"].map((text) => ({ text, still_path: null, seconds: 4 }));
  const step = await brainClient(user.id).rpc("studio_slideshow_rendering", {
    p_order_id: orderId, p_clip_id: clipId, p_input: {}, p_card: { title: "Three cuts", aspect: "9:16", slides, mp4_path: null, png_set_path: null }, p_mp4_task: mp4, p_stills_task: stills,
  });
  expect(step.error).toBeNull();
  expect((await db.from("tasks").update({ status: "done" }).in("id", [mp4, stills])).error).toBeNull();
  const { data: card } = await db.from("approvals").select("id").eq("ref_id", step.data as string).eq("status", "waiting").single();
  return { clipId: clipId as string, stepId: step.data as string, cardId: card!.id as string };
}

/** The renders "render again" queued (the worker is not running here), finished as the worker would. */
async function finishNewRenders(db: SupabaseClient, clipId: string, stepId: string) {
  let input: { mp4_task?: string; stills_task?: string } = {};
  await expect
    .poll(async () => {
      const { data } = await db.from("studio_steps").select("status, input").eq("id", stepId).single();
      input = (data?.input ?? {}) as typeof input;
      return data?.status;
    })
    .toBe("running");
  const { data: project } = await db.from("editor_projects").select("document_hash").eq("clip_id", clipId).single();
  const { data: tasks } = await db.from("tasks").select("settings_hash").in("id", [input.mp4_task!, input.stills_task!]);
  expect(tasks!.map((t) => t.settings_hash)).toEqual([project!.document_hash, project!.document_hash]);
  expect((await db.from("tasks").update({ status: "done" }).in("id", [input.mp4_task!, input.stills_task!])).error).toBeNull();
}

test("A slide edited on the card renders again into a new card; an edit in Slides is rendered again from the card", async ({ page }) => {
  const db = admin();
  const { user, me } = await founder(db);
  await signIn(page, user);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const live = await liveSlideshow(page, db, user, me);

  // A quick text edit on the card: the old card closes, the new renders raise a new card with the new words.
  await page.goto(`/app/inbox/${live.cardId}`);
  let shown = page.getByTestId("inbox-card-page").getByTestId("approval-card");
  await shown.getByRole("button", { name: /^Slide 2,/ }).click();
  await shown.getByLabel("Slide 2 heading").fill("Ask for B-roll on a word");
  await shown.getByRole("button", { name: "Save slide 2" }).click();
  await expect(shown.getByTestId("slideshow-edited")).toContainText("Rendering again");
  await expect(shown.getByRole("button", { name: "Approve" })).toBeDisabled();
  await expect.poll(async () => (await db.from("approvals").select("status").eq("id", live.cardId).single()).data?.status).toBe("cancelled");
  await finishNewRenders(db, live.clipId, live.stepId);
  const { data: next } = await db.from("approvals").select("id, snapshot").eq("ref_id", live.stepId).eq("status", "waiting").single();
  expect((next!.snapshot as { slides: { text: string }[] }).slides.map((x) => x.text)).toEqual(["Cut by words", "Ask for B-roll on a word", "Try it"]);

  // An edit in the Slides view (here through the same ops route): approving is refused, and the card renders it again.
  const opened = await page.request.get(`/api/v1/editor/project?clip_id=${live.clipId}`);
  const { version, document } = (await opened.json()) as { version: number; document: { stage: { children: { children?: { id: string; kind: string }[] }[] } } };
  const firstSlide = document.stage.children[0]!.children!.find((node) => node.kind === "group")!.id;
  const edited = await page.request.post("/api/v1/editor/ops", { data: { clip_id: live.clipId, expected_version: version, ops: [{ op: "set_slide_text", slide_id: firstSlide, heading: "Cut a demo by words" }] } });
  expect(edited.ok(), await edited.text()).toBeTruthy();
  await page.goto(`/app/inbox/${next!.id}`);
  shown = page.getByTestId("inbox-card-page").getByTestId("approval-card");
  await shown.getByRole("button", { name: "Approve" }).click();
  await shown.getByRole("button", { name: "Render again" }).click();
  await expect(shown.getByTestId("slideshow-edited")).toBeVisible();
  await expect.poll(async () => (await db.from("approvals").select("status").eq("id", next!.id).single()).data?.status).toBe("cancelled");
  await finishNewRenders(db, live.clipId, live.stepId);
  const { data: third } = await db.from("approvals").select("snapshot").eq("ref_id", live.stepId).eq("status", "waiting").single();
  expect((third!.snapshot as { slides: { text: string }[] }).slides[0]!.text).toBe("Cut a demo by words");
});

test("Help-only Sales card says why and has no post button", async ({ page }) => {
  const db = admin();
  const { user } = await founder(db);
  const thread = await db
    .from("opportunities")
    .insert({
      user_id: user.id,
      url: "https://www.reddit.com/r/startups/comments/e2e/how_do_you_make_launch_videos/",
      community: "r/startups",
      title: "Solo founders: how do you make launch videos?",
      score: 71,
      reply: "Record once, then cut by deleting words from the transcript. Captions and one zoom on the click are enough.",
      rule: "help_only",
      rule_why: "r/startups bans self-promotion: help only",
      status: "in_review",
    })
    .select("id")
    .single();
  expect(thread.error).toBeNull();
  const { data: card } = await db.from("approvals").select("id").eq("ref_kind", "opportunity").eq("ref_id", thread.data!.id).single();

  // A thread the community's rules rule out: on the Sales screen with why, no draft and no card.
  const skipped = await db
    .from("opportunities")
    .insert({
      user_id: user.id,
      url: "https://www.reddit.com/r/marketing/comments/e2e/do_ai_captions_hurt_reach/",
      community: "r/marketing",
      title: "Do AI captions hurt reach?",
      score: 61,
      rule: "skip",
      rule_why: "Skipped: r/marketing bans tool mentions",
    })
    .select("id")
    .single();
  expect(skipped.error).toBeNull();
  expect((await db.from("approvals").select("id").eq("ref_id", skipped.data!.id)).data).toEqual([]);

  await signIn(page, user);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    await page.goto(`/app/inbox/${card!.id}`);
    const shown = page.getByTestId("inbox-card-page").getByTestId("approval-card");
    await expect(shown.getByTestId("reply-help-only")).toContainText("r/startups bans self-promotion: help only");
    await expect(shown.getByRole("button", { name: "Copy and open thread" })).toBeVisible();
    await expect(shown.getByRole("button", { name: /post/i })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await noSeriousAxe(page);
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/app/sales");
  const threads = page.getByRole("list", { name: "Threads" });
  await expect(threads).toContainText("r/startups bans self-promotion: help only");
  await threads.getByRole("button", { name: /Do AI captions hurt reach\?/ }).click();
  await expect(page.getByText("Sales did not draft a reply.")).toBeVisible();
  // The Sales screen itself (the shell's chat column suggests "Draft a post…" prompts, which post nothing).
  await expect(page.getByTestId("v2-sales").getByRole("button", { name: /post/i })).toHaveCount(0);
});

test("Sales settings save live; a stuck scan points at them, not at credits", async ({ page }) => {
  const db = admin();
  const { user } = await founder(db);
  // Two finished scans that raised no card: the Sales screen says so (A3's `stuck`).
  for (const minutes of [20, 10]) {
    const run = await db.from("cmo_runs").insert({
      user_id: user.id,
      kind: "sales_scan",
      status: "done",
      output: { cards: 0 },
      created_at: new Date(Date.now() - minutes * 60_000).toISOString(),
    });
    expect(run.error).toBeNull();
  }

  await signIn(page, user);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    await page.goto("/app/sales");
    await expect(page.getByTestId("sales-settings")).toBeVisible();
    const banner = page.getByRole("alert").filter({ hasText: "found no conversation worth joining" });
    await expect(banner).toBeVisible();
    await expect(banner).not.toContainText("threads found before it stopped");
    await expect(banner.getByRole("button", { name: /credits/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await noSeriousAxe(page);
  }
  await page.getByRole("alert").getByRole("button", { name: "Change where Sales looks" }).click();
  await expect(page.locator("#sales-settings-title")).toBeFocused();

  const settings = page.getByTestId("sales-settings");
  await settings.getByLabel("Never scan this subreddit").fill("r/Memes");
  await settings.getByRole("button", { name: "Exclude" }).click();
  await settings.getByLabel("A thread must mention").fill("Video");
  await settings.getByLabel("and also").fill("editor");
  await settings.getByRole("button", { name: "Add pair" }).click();
  await settings.getByRole("button", { name: "Save where Sales looks" }).click();
  await expect(settings.getByRole("status").filter({ hasText: "Saved. The next scan skips these." })).toBeVisible();
  await expect
    .poll(async () => (await db.from("sales_settings").select("excluded_subreddits, co_occurrence").eq("user_id", user.id).maybeSingle()).data)
    .toEqual({ excluded_subreddits: ["memes"], co_occurrence: [["video", "editor"]] });

  await page.reload();
  await expect(page.getByTestId("sales-settings").getByRole("list", { name: "Excluded subreddits" })).toContainText("r/memes");
  await expect(page.getByTestId("sales-settings").getByRole("list", { name: "Word pairs" })).toContainText("video + editor");
});
