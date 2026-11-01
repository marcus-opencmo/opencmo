/**
 * Writer's pure parts: the contract (kinds, the video brief shared with Studio); W0's post rules (no links,
 * no hashtags) and No AI Slop as guidance read by the writer, the checker, sales and CMO chat; W1's posts per
 * platform profile (one writer agent each, one cached prefix, checks from `platforms.json`); W2's voice notes; W3's
 * runs for Studio (video brief, captions per profile, YouTube text, slides) on the fake provider.
 *
 *     cd apps/web && NODE_OPTIONS=--conditions=react-server npx tsx lib/cmo/writer/writer.check.ts
 */
import assert from "node:assert/strict";

import { VideoBriefSchema as StudioBriefSchema } from "@/lib/departments/studio/types";
import { briefRequest } from "@/lib/departments/studio/video";

import { AGENT_SPECS, CAPTION_WRITERS, POST_WRITERS } from "../agents/registry";
import { checkPost } from "../jobs/check-post";
import { postProfile, REVIEW_SYSTEM } from "../jobs/draft-post";
import { memoryStore } from "../jobs/memory-store";
import { drainCmoQueue } from "../jobs/runner";
import { duePerPlatform } from "../schedule";
import { isoDay, type ItemRow } from "../jobs/types";
import { stockPatterns } from "../jobs/eval/style";
import { CAPTION_PROFILES, countHashtags, POST_PROFILES, profileOf } from "../platforms";
import { CMO_SKILLS } from "../skills/index.gen";
import { skillIndex } from "../skills";

import { captionText, checkCaption, checkPostFor, checkSlides, checkYoutube, cleanHashtags, moreAdvice } from "./checks";
import { profileBlock, profileFromPrompt, voiceBlock, writerData } from "./context";
import { createWriter, type WriterThink } from "./draft";
import { writerAgent } from "./jobs";
import { firstLine } from "./video-source";
import { CAPTION_SYSTEM, SLIDES_SYSTEM, VIDEO_BRIEF_SYSTEM, YOUTUBE_SYSTEM } from "./prompts";
import { PROFILE_KIND, VideoBriefSchema, WRITER_KINDS, type WriterContext, type WriterProfile } from "./types";

assert.equal(StudioBriefSchema, VideoBriefSchema, "Studio takes Writer's video brief, not a copy");
assert.deepEqual(Object.keys(PROFILE_KIND).sort(), [...WRITER_KINDS].sort(), "every kind says which profile it drafts for");

const brief = VideoBriefSchema.parse({ objective: "Show founders a demo video made from one slash command", hooks: ["What if your demo made itself?"] });
assert.deepEqual([brief.cta, brief.angle, brief.seconds, brief.aspect], ["", "", 30, "9:16"], "an older brief without a call to action still parses");
assert.doesNotMatch(briefRequest(brief).prompt, /call to action/, "no call to action line when the brief has none");
const withCta = VideoBriefSchema.parse({ ...brief, cta: "Try /video on your own demo" });
assert.match(briefRequest(withCta).prompt, /End with this call to action: Try \/video on your own demo/, "the Director reads the brief's call to action");

// W0: no links and no hashtags in a post; tech names, "#1" and "C#" are neither.
const rules = { avoid: [], known: new Set<string>() };
for (const text of ["Read more at https://example.com", "Details on www.example.com", "Try opencmo.io/pricing today", "Our docs live at Paylane.app"]) {
  assert.ok(checkPost(text, rules).some((issue) => issue.includes("link")), `a link is refused: ${text}`);
}
for (const text of ["Shipping this week #buildinpublic", "#saas tip of the day", "We ship.\n#indiehackers"]) {
  assert.ok(checkPost(text, rules).some((issue) => issue.includes("hashtag")), `a hashtag is refused: ${text}`);
}
for (const text of ["We moved the app to Next.js and Node.js.", "Our #1 rule: answer within a day.", "I wrote it in C# first.", "Ship it. Then measure."]) {
  assert.deepEqual(checkPost(text, rules), [], `not a link or a hashtag: ${text}`);
}

// No AI Slop is guidance in a skill, read by the writer, the checker, sales and CMO chat; never a code check.
assert.deepEqual([...CMO_SKILLS["no-ai-slop"].agents].sort(), ["checker", "cmo", "sales", "x_writer"]);
assert.match(CMO_SKILLS["no-ai-slop"].license, /MIT — Copyright \(c\) 2026 Peter Yang/);
for (const agent of ["x_writer", "checker", "sales", "cmo"] as const) assert.ok(skillIndex(agent).includes("- no-ai-slop:"), `${agent} lists no-ai-slop`);
assert.ok(REVIEW_SYSTEM.includes('<skill name="no-ai-slop">') && /advice/.test(REVIEW_SYSTEM), "the checker reads the guidance as advice");
const body = CMO_SKILLS["no-ai-slop"].body;
const words = body.split(/\s+/).filter(Boolean).length;
assert.ok(words >= 1400 && words <= 2000, `about 1,700 words (got ${words})`);
for (const left of ["What changed", "Two jobs", "What to ask for", "ask them to paste"]) assert.ok(!body.includes(left), `its chat parts stay out: ${left}`);
const xWriting = CMO_SKILLS["x-writing"].body;
for (const taught of ["isn't what you think", "is wrong. Here's why:", "the last post sums up", "1-2 hashtags", "link in reply"]) {
  assert.ok(!xWriting.includes(taught), `x-writing no longer teaches: ${taught}`);
}

// The eval's stock-pattern measure: catches the old fake drafts, passes the new ones and plain posts.
assert.deepEqual(stockPatterns("Most founders skip this: polite reminders get invoices paid."), ["faux_insight", "colon_reveal"]);
assert.deepEqual(stockPatterns("A small thing we changed in Paylane: reminders on day 3."), ["colon_reveal"]);
assert.deepEqual(stockPatterns("The question isn't the model. It's the eval."), ["binary_contrast"]);
assert.deepEqual(stockPatterns("Reminders work.\n\nUltimately, consistency wins."), ["recap_ending"]);
assert.deepEqual(stockPatterns("We ship daily — and it shows."), ["em_dash"]);
for (const clean of [
  "Why polite reminders on day 3, 7 and 14 get invoices paid.\n\nWe learned it building Paylane this week.",
  "We tried the usual advice first and it did not work for us. Why polite reminders on day 3, 7 and 14 get invoices paid.",
  "We changed one small thing in Paylane this week. Why polite reminders on day 3, 7 and 14 get invoices paid.",
  "How to get paid without chasing:\n1. Send the invoice the day the work ends.",
  "Overall revenue grew after we added reminders.",
]) assert.deepEqual(stockPatterns(clean), [], `clean: ${clean}`);

// Writer core: code checks per kind and profile.
const profile = (id: string): WriterProfile => {
  const found = profileOf(id);
  assert.ok(found, `profile ${id}`);
  return found;
};
const instagram = profile("instagram_caption");
const tiktok = profile("tiktok_caption");
const youtube = profile("youtube");
const threads = profile("threads");
const tiktok3: WriterProfile = { ...tiktok, hashtags: 3 };
assert.deepEqual(cleanHashtags(["#BuildInPublic", "buildinpublic", " #saas ", "#", "#1", "build in public"]), ["BuildInPublic", "saas"], "one tag per word, no empty or number-only tags");
assert.equal(captionText({ text: "Hook line ", hashtags: ["saas", "#founder"] }), "Hook line\n\n#saas #founder");
assert.deepEqual(checkCaption({ text: "Hook line", hashtags: ["a1", "b", "c", "d", "e", "f"] }, tiktok, rules), ["It has 6 hashtags; the TikTok caption takes at most 5."]);
assert.deepEqual(checkCaption({ text: "Hook #saas line", hashtags: ["b", "c", "d"] }, tiktok3, rules), ["It has 4 hashtags; the TikTok caption takes at most 3."], "tags in the text count too");
assert.ok(checkCaption({ text: "See paylane.app", hashtags: [] }, instagram, rules).some((issue) => issue.includes("link")));
// The founder's product may be named like a domain: its bare name is not a link; any other domain, or a path, is.
const calRules = { ...rules, names: ["Cal.com"] };
assert.deepEqual(checkCaption({ text: "Booked in a minute with Cal.com.", hashtags: [] }, instagram, calRules), [], "the product's own name");
assert.ok(checkCaption({ text: "Booked with Cal.com, see acme.io", hashtags: [] }, instagram, calRules).some((issue) => issue.includes("link")), "another domain");
assert.ok(checkCaption({ text: "Pricing at cal.com/pricing", hashtags: [] }, instagram, calRules).some((issue) => issue.includes("link")), "a path");
assert.ok(checkPost("We shipped it on Cal.com today.", calRules).every((issue) => !issue.includes("link")), "a post may name the product");
assert.deepEqual(checkCaption({ text: "Built on Next.js and Node.js.", hashtags: [] }, instagram, rules), [], "a framework is not a link");
assert.ok(checkCaption({ text: "x".repeat(2195), hashtags: ["saas"] }, instagram, rules)[0]?.includes("2202 characters"), "the limit counts the published caption with its hashtags");
assert.deepEqual(checkYoutube({ title: "How Paylane chases late invoices", description: "A walk through.", hashtags: ["saas"] }, youtube, rules), []);
assert.ok(checkYoutube({ title: "t".repeat(101), description: "d", hashtags: [] }, youtube, rules)[0]?.includes("101 characters"));
assert.ok(checkYoutube({ title: "Late invoices #saas", description: "d", hashtags: [] }, youtube, rules).some((issue) => issue.includes("title has a hashtag")));
assert.ok(checkSlides([{ heading: "One", body: "" }], rules)[0]?.includes("1 slides"));
assert.deepEqual(checkSlides(Array.from({ length: 5 }, (_, i) => ({ heading: `Slide ${i + 1}`, body: "" })), rules), []);

// The data after the cached prefix: profile, then the founder's rules, then their voice (newest, heaviest first).
assert.match(profileBlock(threads), /platform: threads \(Threads\)[\s\S]*limit: 500 characters[\s\S]*hashtags: none[\s\S]*links: none/);
assert.match(profileBlock(youtube), /title limit: 100 characters; description limit: 5000 characters/);
const voice = voiceBlock([
  { body: "Old note", platform: "x", weight: 0.2, createdAt: "2026-09-01T00:00:00Z" },
  { body: "Cuts the last line", platform: "linkedin", weight: 0.9, createdAt: "2026-10-20T00:00:00Z" },
]);
assert.ok(voice.indexOf("Cuts the last line") < voice.indexOf("Old note"), "heavier notes first");
assert.match(voice, /- \(LinkedIn, weight 0\.90, 2026-10-20\) Cuts the last line/, "each note says its platform and weight");
const ctx: WriterContext = {
  documents: { product: { name: "Paylane", pricing: "$12/month" }, strategy: { avoid: ["revolutionary"] } },
  corrections: ["Never end with a summary line."],
  voiceNotes: [{ body: "Writes in lowercase", platform: "threads", weight: 1, createdAt: "2026-10-28T00:00:00Z" }],
  recent: [],
};
const data = writerData(ctx, threads, "BRIEF");
assert.ok(data.indexOf("<platform>") < data.indexOf("<founder_rules") && data.indexOf("<founder_rules") < data.indexOf("<founder_voice") && data.indexOf("<founder_voice") < data.indexOf("<documents>") && data.endsWith("BRIEF"));
for (const system of [CAPTION_SYSTEM, YOUTUBE_SYSTEM, VIDEO_BRIEF_SYSTEM, SLIDES_SYSTEM]) {
  assert.ok(system.includes('<skill name="no-ai-slop">'), "every writer kind reads No AI Slop");
}

// draft(): the same prefix for every profile of a kind; one fix round; what still fails never reaches a card.
type Call = { agent: string; system: string; prompt: string; label: string };
function scripted(answers: unknown[]): { think: WriterThink; calls: Call[] } {
  const calls: Call[] = [];
  const think: WriterThink = async (opts) => {
    calls.push({ agent: opts.agent, system: opts.system, prompt: opts.prompt, label: opts.label });
    if (!answers.length) throw new Error("no scripted answer left");
    return opts.schema.parse(answers.shift());
  };
  return { think, calls };
}
const video = { clipId: "c1", kind: "short" as const, title: "Chasing late invoices", hook: "Your invoice is 14 days late.", transcript: "Your invoice is 14 days late. Paylane sends the reminder.", seconds: 32 };

async function writerChecks() {
  const caption = { text: "Your invoice is 14 days late.\n\nPaylane sends the reminder for you.", hashtags: ["#freelancer", "invoicing"], rationale: "Leads with the hook." };
  const run = scripted([caption, caption]);
  const writer = createWriter({ think: run.think, agentFor: () => "x_writer", canFix: true });
  const ig = await writer.draft("caption", instagram, { video }, ctx);
  assert.deepEqual(ig.hashtags, ["freelancer", "invoicing"], "hashtags cleaned, the 14 from the transcript is a known number");
  await writer.draft("caption", tiktok, { video }, ctx);
  assert.equal(run.calls[0]!.system, run.calls[1]!.system, "one cached prefix for every caption profile");
  assert.ok(run.calls[0]!.prompt.includes("platform: instagram_caption") && run.calls[1]!.prompt.includes("platform: tiktok_caption"));

  // A failed code check gets one fix round with the reasons; the fixed caption is kept.
  const tooMany = { ...caption, hashtags: ["a1", "b1", "c1", "d1", "e1", "f1"] };
  const fixed = scripted([tooMany, caption]);
  const out = await createWriter({ think: fixed.think, agentFor: () => "x_writer", canFix: true }).draft("caption", tiktok, { video }, ctx);
  assert.equal(fixed.calls.length, 2);
  assert.match(fixed.calls[1]!.prompt, /<problems>It has 6 hashtags; the TikTok caption takes at most 5\.<\/problems>/);
  assert.equal(fixed.calls[1]!.label, "write_caption_tiktok_caption_fix");
  assert.deepEqual(out.hashtags, ["freelancer", "invoicing"]);

  // Still failing after the fix (or no fix allowed): the run fails with the reasons, no card.
  const stuck = scripted([tooMany]);
  await assert.rejects(createWriter({ think: stuck.think, agentFor: () => "x_writer", canFix: false }).draft("caption", tiktok, { video }, ctx), /failed our checks\. It has 6 hashtags/);

  // Posts: the versions that pass the code are kept; a link or hashtag drops a version, never the style.
  const post = { versions: [{ text: "We send the reminder on day 3.", angle: "a" }, { text: "Try it at paylane.app", angle: "b" }, { text: "Day 7 is the second nudge #saas", angle: "c" }], rationale: "r" };
  const posted = await createWriter({ think: scripted([post]).think, agentFor: () => "x_writer", canFix: false, postSystem: "POST SYSTEM" }).draft("post", threads, { idea: "Reminders" }, ctx);
  assert.deepEqual(posted.versions.map((v) => v.angle), ["a"]);

  // The checker's review joins the fix round as advice; it never drops a version on its own.
  const reviewed = scripted([{ ...post, versions: [post.versions[0]!, { text: "Most founders skip this: reminders.", angle: "b" }, { text: "Day 7 helps.", angle: "c" }] }, { ...post, versions: [post.versions[0]!, { text: "Reminders on day 7 get paid.", angle: "b" }, { text: "Day 7 helps.", angle: "c" }] }]);
  const withReview = await createWriter({ think: reviewed.think, agentFor: () => "x_writer", canFix: true, postSystem: "POST SYSTEM", review: async () => [[], ["Cut the faux-insight setup."], []] }).draft("post", threads, { idea: "Reminders" }, ctx);
  assert.equal(withReview.versions.length, 3);
  assert.match(reviewed.calls[1]!.prompt, /Cut the faux-insight setup/);
  const noFix = scripted([{ ...post, versions: [post.versions[0]!, { text: "Most founders skip this: reminders.", angle: "b" }, { text: "Day 7 helps.", angle: "c" }] }]);
  const kept = await createWriter({ think: noFix.think, agentFor: () => "x_writer", canFix: false, postSystem: "POST SYSTEM", review: async () => [[], ["Cut the faux-insight setup."], []] }).draft("post", threads, { idea: "Reminders" }, ctx);
  assert.equal(kept.versions.length, 3, "a style problem the writer could not fix still reaches the founder");

  // Video brief: exactly three hooks, facts from the documents, parsed into Studio's type.
  const brief = { objective: "Show how Paylane chases a late invoice", angle: "Show it working", hooks: ["Your invoice is late.", "Paylane sends the reminder.", "Stop chasing invoices."], keyPoints: ["Plans start at $12/month"], cta: "Try Paylane", seconds: 30, aspect: "9:16", rationale: "r", learnedFrom: [] };
  const b = await createWriter({ think: scripted([brief]).think, agentFor: () => "x_writer", canFix: false }).draft("video_brief", null, { idea: "Late invoices" }, ctx);
  assert.deepEqual([b.brief.hooks.length, b.brief.cta, b.brief.seconds], [3, "Try Paylane", 30]);
  assert.equal(VideoBriefSchema.parse(b.brief).objective, brief.objective, "Studio's buildVideo takes it as is");
  await assert.rejects(createWriter({ think: scripted([{ ...brief, hooks: ["One"] }]).think, agentFor: () => "x_writer", canFix: false }).draft("video_brief", null, { idea: "x" }, ctx), /1 hooks; a brief has 3/);
  await assert.rejects(createWriter({ think: scripted([{ ...brief, keyPoints: ["Used by 4,000 freelancers"] }]).think, agentFor: () => "x_writer", canFix: false }).draft("video_brief", null, { idea: "x" }, ctx), /4,000/);

  // The CI fakes pass their own checks for every kind, so fake runs and e2e reach a card.
  const fake: WriterThink = async (opts) => opts.schema.parse(opts.fake!());
  const fakeWriter = createWriter({ think: fake, agentFor: () => "x_writer", canFix: false, postSystem: "POST SYSTEM" });
  assert.equal((await fakeWriter.draft("post", threads, { idea: "Why reminders on day 3 and 7 work" }, ctx)).versions.length, 3);
  for (const profile of [instagram, tiktok]) assert.ok((await fakeWriter.draft("caption", profile, { video }, ctx)).hashtags.length <= profile.hashtags);
  assert.ok((await fakeWriter.draft("youtube", youtube, { video }, ctx)).title);
  assert.equal((await fakeWriter.draft("video_brief", null, { idea: "Chasing a late invoice", seconds: 45 }, ctx)).brief.seconds, 45);
  assert.equal((await fakeWriter.draft("slides", null, { idea: "Three reminders that get invoices paid", count: 7 }, ctx)).slides.length, 7);

  // A kind on the wrong profile is a programming error, not a draft.
  await assert.rejects(createWriter({ think: scripted([]).think, agentFor: () => "x_writer", canFix: false }).draft("caption", threads, { video }, ctx), /caption profile/);
}

// W1: posts per platform profile.
async function postChecks() {
  for (const p of POST_PROFILES) {
    const agent = POST_WRITERS[p.id];
    assert.ok(agent && AGENT_SPECS[agent].tier === "draft", `${p.id} has its own drafting agent`);
  }
  assert.deepEqual([postProfile("threads").id, postProfile("linkedin").id, postProfile("x").id], ["threads", "linkedin", "x"]);
  assert.deepEqual([postProfile("Threads").id, postProfile("LinkedIn").id, postProfile("X").id, postProfile("Twitter").id], ["threads", "linkedin", "x", "x"], "the calendar's labels");
  assert.deepEqual([postProfile(null).id, postProfile("reddit").id, postProfile("tiktok_caption").id], ["x", "x", "x"], "no item, an unknown or a caption platform: X");
  const linkedin = profile("linkedin");
  const x = profile("x");
  const long = `${"Late invoices are a process problem. ".repeat(11).trim()}`;
  assert.ok([...long].length > 280 && [...long].length <= 500);
  assert.deepEqual(checkPostFor(long, threads, rules), [], "Threads takes 500 characters");
  assert.ok(checkPostFor(long, x, rules)[0]?.includes("X allows 280"));
  assert.deepEqual(checkPostFor(`${long}\n\n${long}\n\n${long}`, linkedin, rules), [], "LinkedIn takes 3,000");
  assert.ok(checkPostFor(long.repeat(9), linkedin, rules)[0]?.includes("LinkedIn allows 3000"));
  assert.ok(checkPostFor("Ship it #buildinpublic", linkedin, rules).some((issue) => issue.includes("hashtag")), "no hashtags on any post profile");
  assert.ok(moreAdvice(long, linkedin)[0]?.includes('LinkedIn shows about 140 before "more"'), "a long first line gets advice on LinkedIn");
  assert.deepEqual(moreAdvice(`Late invoices are a process.\n\n${long}`, linkedin), [], "a short first line lands before the cut");
  assert.deepEqual(moreAdvice(long, threads), [], "Threads shows the whole post");

  // The schedule drafts one post per platform a tick, the oldest first: an X backlog never crowds out the others.
  const due = [{ id: "x-old", platform: "X" }, { id: "x-older", platform: "x" }, { id: "x-today", platform: "Twitter" }, { id: "t", platform: "Threads" }, { id: "l", platform: "LinkedIn" }, { id: "unknown", platform: null }];
  assert.deepEqual(duePerPlatform(due).map((d) => d.id), ["x-old", "t", "l"]);

  // A Threads item through the founder's Claude: its own agent, the <platform> block first, X's prefix.
  process.env.OPENCMO_AGENT_FAKE = "1";
  const docs = { product: { name: "Paylane", pricing: "$12/month" }, strategy: { avoid: ["revolutionary"] }, content_strategy: { pillars: [{ name: "Getting paid", ideas: ["The 3-7-14 reminder rule"] }] } };
  const item = (platform: string, id: string): ItemRow => ({ id, run_id: null, department: "post", platform, day: isoDay(), idea: "Why reminders on day 3, 7 and 14 get invoices paid", reason: "pillar", status: "planned", priority: "medium", body: {}, final_text: null, external_url: null, decided_at: null, published_at: null, created_at: new Date().toISOString() });
  const mem = memoryStore(docs, []);
  mem.items.push(item("threads", "t1"), item("x", "x1"));
  mem.enqueue("post_draft", { brain: "claude", item_id: "t1" });
  mem.enqueue("post_draft", { brain: "claude", item_id: "x1" });
  await drainCmoQueue(mem.store);
  const [onThreads, onX] = mem.inbox;
  assert.ok(onThreads && onX, "both runs wait for Claude");
  assert.deepEqual([onThreads.request.agent, onX.request.agent], ["threads_writer", "x_writer"]);
  assert.equal(onThreads.request.system, onX.request.system, "one cached prefix for every post profile");
  assert.deepEqual([profileFromPrompt(onThreads.request.prompt), profileFromPrompt(onX.request.prompt)], ["threads", "x"]);
  assert.match(onThreads.request.title, /today's Threads post/);
  // A 400-character version is a Threads post, never an X one.
  const answer = { versions: [{ text: long, angle: "long" }, { text: "Reminders on day 3, 7 and 14.", angle: "short" }], rationale: "r" };
  mem.submit(onThreads.id, "draft_post", answer);
  mem.submit(onX.id, "draft_post", answer);
  await drainCmoQueue(mem.store);
  const threadsCard = mem.items.find((i) => i.id === "t1")!;
  const xCard = mem.items.find((i) => i.id === "x1")!;
  assert.equal(threadsCard.status, "in_review");
  assert.deepEqual([threadsCard.body.text, threadsCard.body.alternates], [long, ["Reminders on day 3, 7 and 14."]]);
  assert.deepEqual([xCard.body.text, xCard.body.alternates], ["Reminders on day 3, 7 and 14.", []], "the long version is dropped on X");

  // W2: the founder's rules first, then their voice notes (newest, weightiest), then documents; the prefix is the same
  // whatever the founder's notes say; voice notes are not read twice through the general memories.
  const voiced = memoryStore(docs, ["Skipped a draft: too salesy"], [], ["Never end with a summary line."]);
  voiced.voice.push(
    { body: 'Edited on LinkedIn before approving (cut it shorter): "Reminders get paid."', platform: "linkedin", created_at: "2026-10-28T09:00:00Z", weight: 0.98 },
    { body: 'Approved as written on X: "Day 3, 7, 14."', platform: "x", created_at: "2026-09-10T09:00:00Z", weight: 0.2 },
  );
  voiced.items.push(item("LinkedIn", "lv"));
  voiced.enqueue("post_draft", { brain: "claude", item_id: "lv" });
  await drainCmoQueue(voiced.store);
  const asked = voiced.inbox[0]!.request;
  assert.equal(profileFromPrompt(asked.prompt), "linkedin", "a calendar label resolves to its profile");
  assert.equal(asked.agent, "linkedin_writer");
  const at = (tag: string) => asked.prompt.indexOf(tag);
  assert.ok(at("<platform>") === 0 && at("<platform>") < at("<founder_rules") && at("<founder_rules") < at("<founder_voice") && at("<founder_voice") < at("<documents>") && at("<documents>") < at("<memories>"), "rules, then voice, then documents and memories");
  assert.ok(asked.prompt.indexOf("cut it shorter") < asked.prompt.indexOf("Day 3, 7, 14."), "the newer, heavier note first");
  assert.match(asked.prompt, /\(LinkedIn, weight 0\.98, 2026-10-28\)/);
  assert.equal(asked.system, onX.request.system, "the founder's notes never change the cached prefix");
  assert.match(asked.system, /When their voice and the no-ai-slop guidance disagree, write it their way/);

  // The fake writer drafts LinkedIn too, end to end.
  const fake = memoryStore(docs, []);
  fake.items.push(item("linkedin", "l1"));
  const run = fake.enqueue("post_draft", { item_id: "l1" });
  await drainCmoQueue(fake.store);
  assert.equal(run.status, "done", `LinkedIn draft (${run.error})`);
  assert.equal(fake.items.find((i) => i.id === "l1")!.status, "in_review");
  delete process.env.OPENCMO_AGENT_FAKE;
}

// W3: Writer's runs for Studio, through the runner on the fake provider.
async function studioChecks() {
  for (const p of CAPTION_PROFILES) assert.ok(CAPTION_WRITERS[p.id] && AGENT_SPECS[CAPTION_WRITERS[p.id]!].tier === "draft", `${p.id} has its own writer agent`);
  assert.deepEqual([writerAgent("video_brief", null), writerAgent("slides", null), writerAgent("caption", profile("tiktok_caption")), writerAgent("youtube", youtube), writerAgent("post", threads)], ["brief_writer", "slides_writer", "tiktok_writer", "youtube_writer", "threads_writer"]);

  assert.deepEqual([firstLine("Your invoice is late. Paylane sends it."), firstLine("no stop at all"), firstLine("v1.2 shipped today! More soon.")], ["Your invoice is late.", "no stop at all", "v1.2 shipped today!"], "the first sentence said, not a decimal point");
  process.env.OPENCMO_AGENT_FAKE = "1";
  const docs = { product: { name: "Paylane", pricing: "$12/month" }, strategy: { avoid: ["revolutionary"] } };

  // write_video_brief: SQL's input → Writer's brief, as Studio takes it.
  const briefRun = memoryStore(docs, []);
  const b = briefRun.enqueue("write_video_brief", { order_id: "o1", idea: "Chasing a late invoice in one take", reason: "pillar: getting paid", seconds: 30, aspect: "9:16", platform: "Reels" });
  await drainCmoQueue(briefRun.store);
  assert.equal(b.status, "done", `brief run (${b.error})`);
  const out = b.output as { brief: unknown; reason: string };
  const parsed = VideoBriefSchema.parse(out.brief);
  assert.deepEqual([parsed.hooks.length, parsed.seconds, parsed.aspect, Boolean(parsed.cta), typeof out.reason], [3, 30, "9:16", true, "string"]);
  assert.deepEqual(Object.keys(out.brief as object).sort(), ["angle", "aspect", "cta", "hooks", "keyPoints", "objective", "seconds"], "the keys SQL copies into the video order");
  assert.deepEqual((b.output as { sources: string[] }).sources, [], "no niche research, no sources");
  // P5 F8: with niche research the brief cites its videos, and only URLs the research read.
  const nicheRun = memoryStore(docs, []);
  const nicheVideo = (n: number) => ({ platform: "tiktok" as const, url: `https://www.tiktok.com/@a/video/${n}`, author: "@a", views: 9000, lift: 4, hook: "Stop editing on a timeline", format: "Screen demo", why: "Names the pain" });
  await nicheRun.store.saveNicheInsight("u", "r", { topics: ["invoices"], videos: [nicheVideo(1), nicheVideo(2), nicheVideo(3)], formats: ["Screen demo"], measured_at: new Date().toISOString() });
  const nb = nicheRun.enqueue("write_video_brief", { order_id: "o3", idea: "Chasing a late invoice in one take" });
  await drainCmoQueue(nicheRun.store);
  assert.equal(nb.status, "done", `brief with niche research (${nb.error})`);
  assert.deepEqual((nb.output as { sources: string[] }).sources, [nicheVideo(1).url, nicheVideo(2).url], "the brief cites the niche videos it learned from");
  const noIdea = briefRun.enqueue("write_video_brief", { order_id: "o2", idea: "" });
  await drainCmoQueue(briefRun.store);
  assert.equal(noIdea.status, "failed", "a brief with no idea fails its order");

  // write_caption: each edit × each profile, saved through the store with the published text.
  const cap = memoryStore(docs, []);
  cap.videos.push(
    { clipId: "s1", kind: "short", title: "Late invoices", hook: "Your invoice is 14 days late.", transcript: "Your invoice is 14 days late. Paylane sends the reminder.", seconds: 31 },
    { clipId: "s2", kind: "short", title: "The day 3 reminder", hook: "Day 3 is the first nudge.", transcript: "Day 3 is the first nudge. Then day 7.", seconds: 24 },
  );
  cap.captions.push({ runId: "earlier", clipId: "s2", profile: "tiktok_caption", text: "The founder's own words", title: null, gen: {}, edited: true });
  const c = cap.enqueue("write_caption", { order_id: "o3", clip_ids: ["s1", "s2", "s1"], profiles: ["instagram_caption", "tiktok_caption", "youtube", "x", "made_up"], ref_kind: "short_batch", ref_id: "b1" });
  await drainCmoQueue(cap.store);
  assert.equal(c.status, "done", `caption run (${c.error})`);
  assert.equal((c.output as { saved: number }).saved, 6, "two edits × three caption profiles; X and unknown ids ignored, a repeated edit once");
  assert.equal(cap.captions.find((row) => row.clipId === "s2" && row.profile === "tiktok_caption")!.text, "The founder's own words", "a caption the founder edited is never overwritten");
  for (const row of cap.captions.filter((r) => r.runId === c.id)) {
    const p = profile(row.profile);
    assert.ok([...row.text].length <= p.limit && countHashtags(row.text) <= p.hashtags && !/https?:\/\/|www\./i.test(row.text), `${row.profile} passes cmo_save_caption's rules`);
    assert.equal(row.title === null, p.kind !== "youtube", "a title only on YouTube");
    assert.ok(row.title === null || [...row.title].length <= (p.title ?? 100));
    assert.deepEqual(Object.keys(row.gen).sort(), ["model", "prompt_version"]);
  }
  assert.deepEqual(new Set(c.steps.map((step) => step.tool)).has("write_caption_youtube_1"), true, "one step per edit and profile");

  const gone = memoryStore(docs, []);
  gone.videos.push({ clipId: "s1", kind: "video", title: "Demo", transcript: "Paylane sends the reminder.", seconds: 40 });
  const partial = gone.enqueue("write_caption", { order_id: "o4", clip_ids: ["s1", "missing"], profiles: ["youtube"] });
  await drainCmoQueue(gone.store);
  assert.equal(partial.status, "done");
  assert.deepEqual([(partial.output as { saved: number }).saved, (partial.output as { failed: string[] }).failed.length], [1, 1], "a missing edit is reported, the others still get captions");
  const nothing = gone.enqueue("write_caption", { order_id: "o5", clip_ids: ["missing"], profiles: ["youtube"] });
  const empty = gone.enqueue("write_caption", { order_id: "o6", clip_ids: [], profiles: ["youtube"] });
  await drainCmoQueue(gone.store);
  assert.deepEqual([nothing.status, empty.status], ["failed", "failed"], "no caption saved fails the run (its credit is refunded)");

  // write_slides: 5 to 10 slides, the hook first and the call to action last.
  const sl = memoryStore(docs, []);
  const slides = sl.enqueue("write_slides", { order_id: "o7", idea: "Three reminders that get invoices paid", count: 6 });
  await drainCmoQueue(sl.store);
  assert.equal(slides.status, "done", `slides run (${slides.error})`);
  const list = (slides.output as { slides: { heading: string }[] }).slides;
  assert.equal(list.length, 6);
  assert.match(list.at(-1)!.heading, /Paylane/, "the call to action last");
  delete process.env.OPENCMO_AGENT_FAKE;
}

writerChecks().then(postChecks).then(studioChecks).then(
  () => console.log("writer.check: ok"),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
