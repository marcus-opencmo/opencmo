/**
 * The Slideshow and Post image squads on a local stack with a local worker and no providers: order → MP4 and PNG set →
 * one card → approve → deliverable; post images from a captured page, from nothing, and from a frame that cannot be
 * drawn. The files are saved to look at. It refuses any Supabase that is not local, because
 * `apps/web/.env.local` is production.
 *
 *     eval "$(supabase status -o env)"; export NEXT_PUBLIC_SUPABASE_URL=$API_URL NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY \
 *       SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY SUPABASE_JWT_SECRET=$JWT_SECRET
 *     NODE_OPTIONS=--conditions=react-server npx tsx lib/departments/studio/slideshow/slideshow.e2e.ts <out dir>
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createClient } from "@supabase/supabase-js";

import { drainStudioOrders } from "@/lib/cmo/jobs/studio-orders";
import { clientFor } from "@/lib/mcp/auth";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost):/, "local Supabase only");
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const SLIDES = [
  { heading: "Cut a video by deleting words", body: "No timeline needed." },
  { heading: "Upload your own video", body: "Words appear as you speak them." },
  { heading: "Delete a sentence", body: "The video follows the text." },
  { heading: "Add captions in one click", body: "" },
  { heading: "Try it on your next demo", body: "Export when it reads right." },
];

/** A ready page capture of this founder, its screenshot in Storage as the capture task would leave it. */
async function capture(userId: string, out: string): Promise<string> {
  const id = randomUUID();
  const file = join(out, "page.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x800:d=1", "-frames:v", "1", file]);
  const path = `${userId}/${id}/page.png`;
  const uploaded = await admin.storage.from("captures").upload(path, readFileSync(file), { contentType: "image/png" });
  assert.ifError(uploaded.error);
  const row = await admin.from("page_captures").insert({ id, user_id: userId, url: "https://example.com/", status: "ready", image_path: path, boxes_path: `${userId}/${id}/boxes.json`, width: 1280, height: 800, finished_at: new Date().toISOString() });
  assert.ifError(row.error);
  return id;
}

async function postImage(userId: string, parent: { id: string; week: string }, out: string, name: string, platform: string, source: unknown): Promise<void> {
  const post = await admin.from("content_items").insert({ user_id: userId, department: "post", platform, day: new Date().toISOString().slice(0, 10), idea: name, status: "in_review", body: { text: "We shipped." } }).select("id").single();
  assert.ifError(post.error);
  const postId = (post.data as { id: string }).id;
  const order = await admin.rpc("work_order_create", {
    p_user: userId, p_week: parent.week, p_parent: parent.id, p_kind: "build_post_image", p_title: name,
    p_brief: { postId, title: "Cut a video by deleting words", platform, ...(source ? { source } : {}) },
  });
  assert.ifError(order.error);
  const orderId = (Array.isArray(order.data) ? order.data[0] : order.data).id as string;
  const deadline = Date.now() + 3 * 60_000;
  for (;;) {
    assert.ok(Date.now() < deadline, `${name}: no image within 3 minutes`);
    await drainStudioOrders(admin as never, { budgetMs: 15_000 });
    const { data: row } = await admin.from("work_orders").select("status, error").eq("id", orderId).single();
    assert.notEqual(row!.status, "failed", JSON.stringify(row!.error));
    if (row!.status === "done") break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const { data: image } = await admin.from("deliverables").select("kind, status, ref_id").eq("post_id", postId).single();
  assert.equal(image!.status, "ready");
  const { data: task } = await admin.from("tasks").select("output").eq("clip_id", image!.ref_id).eq("kind", "render_stills").single();
  const still = (task!.output as { stills: { object: string }[] }).stills[0]!.object;
  const { data, error } = await admin.storage.from("exports").download(still);
  assert.ifError(error);
  writeFileSync(join(out, `${name}.png`), Buffer.from(await data!.arrayBuffer()));
  console.log(`  ✓ ${name}: image deliverable on its post`);
}

async function postImages(userId: string, parent: { id: string; week: string }, out: string): Promise<void> {
  await postImage(userId, parent, out, "image-capture-x", "x", { captureId: await capture(userId, out) });
  await postImage(userId, parent, out, "image-plain-linkedin", "linkedin", null);
  // Looking is not set up on a local stack, so a frame falls back to the plain background instead of failing the post.
  const blank = await clientFor(userId).rpc("create_blank_edit", { p_name: "Source", p_aspect: "9:16" });
  assert.ifError(blank.error);
  await postImage(userId, parent, out, "image-frame-fallback-tiktok", "tiktok_caption", { clipId: blank.data, time: 0 });
}

async function main() {
  const out = process.argv[2] ?? ".";
  mkdirSync(out, { recursive: true });
  const created = await admin.auth.admin.createUser({ email: `p5-slideshow-${Date.now()}@test.local`, email_confirm: true });
  assert.ifError(created.error);
  const userId = created.data.user!.id;
  await admin.from("profiles").update({ credit_balance: 100, plan: "creator" }).eq("id", userId);
  const before = (await admin.from("profiles").select("credit_balance").eq("id", userId).single()).data!.credit_balance;

  const root = await admin.rpc("work_order_week_root", { p_user: userId });
  assert.ifError(root.error);
  const parent = (Array.isArray(root.data) ? root.data[0] : root.data) as { id: string; week: string };
  const order = await admin.rpc("work_order_create", {
    p_user: userId, p_week: parent.week, p_parent: parent.id, p_kind: "build_slideshow", p_title: "Editing by words",
    p_brief: { idea: "Cut a video by deleting words", aspect: "9:16", slides: SLIDES },
  });
  assert.ifError(order.error);
  const orderId = (Array.isArray(order.data) ? order.data[0] : order.data).id as string;

  const deadline = Date.now() + 5 * 60_000;
  type Card = { id: string; content_hash: string; snapshot: { clip_id: string; slides: { still_path: string; seconds: number; text: string }[]; mp4_path: string; png_set_path: string } };
  let raised: Card | null = null;
  while (!raised && Date.now() < deadline) {
    await drainStudioOrders(admin as never, { budgetMs: 20_000 });
    const { data: row } = await admin.from("work_orders").select("status, error").eq("id", orderId).single();
    assert.notEqual(row!.status, "failed", JSON.stringify(row!.error));
    const { data } = await admin.from("approvals").select("id, content_hash, snapshot").eq("user_id", userId).eq("kind", "slideshow").maybeSingle();
    raised = data as Card | null;
    if (!raised) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const card = raised as Card | null;
  assert.ok(card, "the card was raised within 5 minutes");
  const snapshot = card.snapshot;
  assert.equal(snapshot.slides.length, SLIDES.length);
  console.log(`  ✓ one card with ${snapshot.slides.length} slides, ${snapshot.slides.reduce((sum, slide) => sum + slide.seconds, 0)} s`);

  for (const [name, path] of [["slideshow.mp4", snapshot.mp4_path], ["slides.zip", snapshot.png_set_path], ...snapshot.slides.map((slide, index) => [`slide-${index + 1}.png`, slide.still_path])] as [string, string][]) {
    const { data, error } = await admin.storage.from("exports").download(path);
    assert.ifError(error);
    writeFileSync(join(out, name), Buffer.from(await data!.arrayBuffer()));
  }
  console.log("  ✓ MP4, zip and every still are in Storage");

  const decided = await clientFor(userId).rpc("approval_decide", { p_id: card.id, p_action: "approve", p_payload: { content_hash: card.content_hash, via: "app" } });
  assert.ifError(decided.error);
  const { data: done } = await admin.from("work_orders").select("status").eq("id", orderId).single();
  assert.equal(done!.status, "done");
  const { data: deliverable } = await admin.from("deliverables").select("kind, status, ref_id").eq("user_id", userId).eq("kind", "slideshow").single();
  assert.deepEqual(deliverable, { kind: "slideshow", status: "ready", ref_id: snapshot.clip_id });
  const after = (await admin.from("profiles").select("credit_balance").eq("id", userId).single()).data!.credit_balance;
  assert.equal(after, before, "the squad spends no credits");
  console.log("  ✓ approved: order done, deliverable ready, no credits spent");
  await postImages(userId, parent, out);
  process.exit(0);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
