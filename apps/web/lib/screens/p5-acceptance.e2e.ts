/**
 * P5 acceptance (plan F13, sessions/A.md A4) against a local Supabase with fake providers: no real model, reader or
 * posting. Niche video research → a video brief citing the niche videos' URLs → the video order carries them; a Sales
 * scan with one help-only subreddit (its rules forbid self-promotion and plant an instruction) and one skipped
 * subreddit; a slideshow: rendering step → card with its captions → approve → slideshow deliverable → a TikTok
 * schedule card; a post's image: still → image deliverable → the post's approved schedule card goes back to the
 * founder with the image.
 *
 *     eval "$(supabase status -o env | sed 's/^/export /')"   # API_URL, ANON_KEY, SERVICE_ROLE_KEY, JWT_SECRET
 *     NEXT_PUBLIC_SUPABASE_URL=$API_URL NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY \
 *       SUPABASE_JWT_SECRET=$JWT_SECRET OPENCMO_AGENT_FAKE=1 \
 *       NODE_OPTIONS=--conditions=react-server npx tsx lib/screens/p5-acceptance.e2e.ts
 *
 * Renders are marked done the way the worker finishes them (B2's tests cover the real stills and their peak RSS;
 * the MP4 and PNG uploads to Zernio need the worker, as in P4). Leaves its founder in the database.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { drainCmoQueue } from "@/lib/cmo/jobs/runner";
import { supabaseStore } from "@/lib/cmo/jobs/store";
import { clipContext } from "@/lib/api/clips";
import { ensureProject } from "@/lib/editor/project";
import { brainClientFor, clientFor } from "@/lib/mcp/auth";

import { LOADERS } from "./load";
import { compose } from "./registry";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
assert.equal(process.env.OPENCMO_AGENT_FAKE, "1", "the acceptance run uses fake models and readers only");

const ok = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  assert.equal(r.error, null, `${what}: ${r.error?.message}`);
  return r.data;
};
const drain = () => drainCmoQueue(supabaseStore(admin as never), { budgetMs: 60_000 });

async function decide(userId: string, cardId: string, action: string, extra: Record<string, unknown> = {}) {
  const { data: card } = await admin.from("approvals").select("content_hash").eq("id", cardId).single();
  ok(await clientFor(userId).rpc("approval_decide", { p_id: cardId, p_action: action, p_payload: { content_hash: card!.content_hash, via: "app", ...extra } }), `${action} ${cardId}`);
}

async function screen<N extends "research" | "sales" | "studio">(name: N, userId: string) {
  const loader = LOADERS[name] as (c: never) => Promise<object>;
  return compose(name, (await loader({ supabase: clientFor(userId), userId, params: new URLSearchParams() } as never)) as never, { production: true, sample: false });
}

/** Marks a render done for the document as it is now, as the worker would, with B2's stills output. */
async function rendered(clipId: string, kind: "render_document" | "render_stills", userId: string): Promise<string> {
  const doc = ok(await admin.from("editor_projects").select("document").eq("clip_id", clipId).single(), "editor project") as { document: unknown };
  const hash = ok(await admin.rpc("editor_document_hash", { p_document: doc.document }), "document hash") as string;
  const clip = ok(await admin.from("clips").select("job_id").eq("id", clipId).single(), "clip") as { job_id: string };
  const id = randomUUID();
  const prefix = `${userId}/${clipId}/${id}`;
  const output = kind === "render_stills" ? { cover_index: 0, count: 1, stills: [{ index: 0, object: `${prefix}-01.png`, bytes: 2048 }], zip: { object: `${prefix}.zip`, bytes: 4096 } } : {};
  ok(
    await admin.from("tasks").insert({
      id, user_id: userId, kind, clip_id: clipId, job_id: clip.job_id, status: "queued", request_id: randomUUID(), settings_hash: hash,
      payload: { bucket: "exports", object: kind === "render_stills" ? `${prefix}.zip` : `${prefix}.mp4`, still_prefix: prefix },
    }),
    `${kind} queued`,
  );
  return id;
}
const finish = async (taskId: string, kind: "render_document" | "render_stills", prefix: string) =>
  ok(
    await admin.from("tasks").update({
      status: "done", finished_at: new Date().toISOString(), output_path: kind === "render_document" ? `${prefix}.mp4` : null,
      output: kind === "render_stills" ? { cover_index: 0, count: 1, stills: [{ index: 0, object: `${prefix}-01.png`, bytes: 2048 }], zip: { object: `${prefix}.zip`, bytes: 4096 } } : {},
    }).eq("id", taskId),
    `${kind} done`,
  );

async function main() {
  const created = await admin.auth.admin.createUser({ email: `p5-${randomUUID()}@test.local`, password: `pw-${randomUUID()}`, email_confirm: true });
  assert.equal(created.error, null);
  const userId = created.data.user!.id;
  await admin.from("profiles").update({ timezone: "UTC", credit_balance: 200 }).eq("id", userId);
  await admin.from("marketing_documents").insert([
    { user_id: userId, kind: "product", version: 1, created_by: "user", body: { name: "OpenCMO", one_liner: "An AI CMO for solo founders." } },
    { user_id: userId, kind: "strategy", version: 1, created_by: "user", body: { pains: ["late invoice payments"], avoid: [] } },
    { user_id: userId, kind: "content_strategy", version: 1, created_by: "user", body: { pillars: [{ name: "Cut demos by words", why: "", ideas: [] }] } },
  ]);

  // F7–F8: niche research, then a week plan with a video: its brief cites the niche videos and the order keeps them.
  ok(await admin.rpc("enqueue_cmo_run_for", { p_user: userId, p_kind: "niche_video_research", p_input: { source: "chat" } }), "niche research queued");
  await drain();
  const insight = ok(await admin.from("cmo_insights").select("body").eq("user_id", userId).eq("kind", "niche_video").single(), "niche insight") as { body: { videos: { url: string }[] } };
  assert.ok(insight.body.videos.length > 0 && insight.body.videos.every((v) => /^https:\/\/www\.(tiktok|youtube)\.com\//.test(v.url)), "every niche video has its URL");
  const plan = ok(await admin.from("cmo_runs").insert({ user_id: userId, kind: "plan_week", status: "running" }).select("id").single(), "plan run") as { id: string };
  ok(await admin.rpc("cmo_plan_week", { p_user: userId, p_run: plan.id, p_items: [{ day: new Date().toISOString().slice(0, 10), department: "video", platform: "TikTok", idea: "Cut a demo by words", reason: "Launch" }] }), "plan");
  await drain();
  const video = ok(await admin.from("work_orders").select("brief").eq("user_id", userId).eq("kind", "build_video").single(), "video order") as { brief: { sources?: string[] } };
  assert.ok(video.brief.sources?.length && video.brief.sources.every((u) => insight.body.videos.some((v) => v.url === u)), "the video order cites the niche videos it learned from");
  const research = await screen("research", userId);
  assert.ok(research.data.insights.some((i) => i.scope === "niche_video" && i.sources.length === 1), "Research shows what works on video");
  console.log(`F7–F8: ${insight.body.videos.length} niche videos; the brief cites ${video.brief.sources!.length}`);

  // F2–F6: a Sales scan with one help-only subreddit and one skipped (its verdict cached this week).
  ok(await admin.from("subreddit_rules").upsert({ subreddit: "smallbusiness", verdict: "skip", summary: "r/smallbusiness: no tool talk" }), "rules cache");
  ok(await admin.rpc("enqueue_cmo_run_for", { p_user: userId, p_kind: "sales_scan", p_input: { source: "chat" } }), "scan queued");
  await drain();
  const opps = ok(await admin.from("opportunities").select("community, rule, rule_why, reply").eq("user_id", userId), "opportunities") as { community: string; rule: string; rule_why: string; reply: string | null }[];
  assert.ok(opps.some((o) => o.community === "r/freelance" && o.rule === "help_only" && o.reply && !/https?:|example\.com/.test(o.reply)), "r/freelance: help only, and the planted link instruction changed nothing");
  assert.ok(opps.some((o) => o.community === "r/smallbusiness" && o.rule === "skip" && o.reply === null), "r/smallbusiness: skipped, no draft");
  const sales = await screen("sales", userId);
  assert.ok(sales.data.threads.some((t) => t.rule.kind === "skipped") && sales.data.threads.some((t) => t.rule.kind === "help_only"), "the Sales screen shows both");
  assert.deepEqual(sales.data.mentions, { used: 0, window: 10 });
  console.log(`F2–F6: ${opps.filter((o) => o.rule === "help_only").length} help-only drafts, ${opps.filter((o) => o.rule === "skip").length} skipped`);

  // F9–F12: a slideshow made by the squad → rendering → card with captions → approve → a TikTok schedule card.
  const root = ok(await admin.rpc("work_order_week_root", { p_user: userId }), "week root") as { id: string; week: string };
  const studioOrder = async (kind: string, title: string): Promise<{ id: string }> => {
    const made = ok(await admin.rpc("work_order_create", { p_user: userId, p_week: root.week, p_parent: root.id, p_kind: kind, p_title: title }), kind) as { id: string };
    ok(await admin.rpc("work_order_move", { p_id: made.id, p_to: "running" }), `${kind} running`);
    return made;
  };
  const show = ok(await clientFor(userId).rpc("create_slideshow", { p_name: "Three cuts", p_aspect: "9:16" }), "slideshow") as string;
  // A real document, as the editor opens one (Writer reads it for the captions).
  await ensureProject(clientFor(userId), await clipContext(clientFor(userId), show), show);
  const order = await studioOrder("build_slideshow", "Three cuts");
  const mp4 = await rendered(show, "render_document", userId);
  const stills = await rendered(show, "render_stills", userId);
  const step = ok(
    await brainClientFor(userId).rpc("studio_slideshow_rendering", {
      p_order_id: order.id, p_clip_id: show, p_input: {},
      p_card: { title: "Three cuts", aspect: "9:16", slides: [{ text: "Cut by words", still_path: `${userId}/${show}/${stills}-01.png`, seconds: 3 }], mp4_path: `${userId}/${show}/${mp4}.mp4`, png_set_path: `${userId}/${show}/${stills}.zip` },
      p_mp4_task: mp4, p_stills_task: stills,
    }),
    "rendering step",
  ) as string;
  await finish(mp4, "render_document", `${userId}/${show}/${mp4}`);
  await finish(stills, "render_stills", `${userId}/${show}/${stills}`);
  await drain(); // Writer writes the card's captions.
  const card = ok(await admin.from("approvals").select("id, kind, snapshot").eq("ref_id", step).eq("status", "waiting").single(), "slideshow card") as { id: string; kind: string; snapshot: { captions?: { profile: string }[] } };
  assert.equal(card.kind, "slideshow");
  assert.ok(card.snapshot.captions?.some((c) => c.profile === "tiktok_caption"), "the card carries its TikTok caption");
  await decide(userId, card.id, "approve");
  const deliverable = ok(await admin.from("deliverables").select("id").eq("kind", "slideshow").eq("ref_id", show).single(), "slideshow deliverable") as { id: string };
  const slot = ok(await admin.from("schedule_slots").select("platform, approval_id").eq("deliverable_id", deliverable.id).eq("platform", "tiktok").single(), "slideshow slot") as { approval_id: string };
  assert.ok(slot.approval_id, "a TikTok schedule card for the slideshow");
  const studio = await screen("studio", userId);
  assert.ok(studio.data.items.some((i) => i.kind === "slideshow" && i.status === "finished"), "Studio lists the approved slideshow");
  console.log("F9–F12: slideshow approved with its caption; its TikTok schedule card is waiting");

  // F11–F12: a post's image arrives after its time was approved: the card goes back to the founder with the image.
  const post = randomUUID();
  ok(await admin.from("content_items").insert({ id: post, user_id: userId, department: "post", platform: "LinkedIn", day: new Date().toISOString().slice(0, 10), idea: "Launch", status: "in_review", body: { text: "We shipped the editor.", alternates: [] } }), "post");
  const postDeliverable = ok(await admin.from("deliverables").insert({ user_id: userId, order_id: order.id, kind: "post", ref_kind: "content_item", ref_id: post, status: "waiting_founder" }).select("id").single(), "post deliverable") as { id: string };
  const postCard = ok(await admin.from("approvals").select("id").eq("ref_kind", "content_item").eq("ref_id", post).eq("status", "waiting").single(), "post card") as { id: string };
  await decide(userId, postCard.id, "approve");
  const postSlot = ok(await admin.from("schedule_slots").select("id, approval_id").eq("deliverable_id", postDeliverable.id).single(), "post slot") as { id: string; approval_id: string };
  await decide(userId, postSlot.approval_id, "approve");
  const imageOrder = await studioOrder("build_post_image", "Launch image");
  const imageEdit = ok(await brainClientFor(userId).rpc("create_post_image_edit", { p_name: "Launch image", p_aspect: "1:1", p_source_clip: null }), "image edit") as string;
  await ensureProject(clientFor(userId), await clipContext(clientFor(userId), imageEdit), imageEdit);
  const still = await rendered(imageEdit, "render_stills", userId);
  ok(await brainClientFor(userId).rpc("studio_post_image_rendering", { p_order_id: imageOrder.id, p_clip_id: imageEdit, p_post_id: post, p_stills_task: still }), "image step");
  await finish(still, "render_stills", `${userId}/${imageEdit}/${still}`);
  const back = ok(await admin.from("schedule_slots").select("status, approval_id").eq("id", postSlot.id).single(), "post slot again") as { status: string; approval_id: string };
  assert.equal(back.status, "proposed", "the approved time goes back to the founder");
  const newCard = ok(await admin.from("approvals").select("snapshot").eq("id", back.approval_id).single(), "new schedule card") as { snapshot: { image?: { object: string } } };
  assert.equal(newCard.snapshot.image?.object, `${userId}/${imageEdit}/${still}-01.png`, "with the image on it");
  console.log("F11–F12: the post's image is on its schedule card, asked again");

  console.log(`P5 acceptance passed for ${userId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
