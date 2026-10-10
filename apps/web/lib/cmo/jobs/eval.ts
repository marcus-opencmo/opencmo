/**
 * Evals for the AI CMO jobs, used to choose the default LLM provider and to catch regressions:
 *
 *   npm run cmo:eval -- --provider fake                       # CI: checks the harness, costs nothing
 *   npm run cmo:eval -- --provider anthropic --yes            # real model: COSTS API MONEY
 *   npm run cmo:eval -- --provider gemini --yes --job w1      # one job: w1, w2 or w5
 *
 * Each job runs for real (prompts, schemas, checks, fixes) against an in-memory store for every
 * fixture product, then is graded with code only:
 *   W1 plan_week   — finished, 5–10 items, at most one Reddit item a day, video only when the
 *                    strategy mentions it, every item has a reason, no avoid words or invented numbers
 *   W2 post_draft  — finished, how many of the three versions pass `checkPost`
 *   W5 video_pack  — finished, how many clips got real captions (not the hook-only fallback)
 *                    that pass `checkCaptions`
 * Code checks only catch rule breaks, so real runs also print what the model wrote.
 */

import { checkPost } from "./check-post";
import { avoidList, knownNumbers, normalizeNumber } from "./context";
import { memoryStore } from "./memory-store";
import type { ClipInfo, Documents, PlatformCaptions } from "./types";
import { checkCaptions } from "./video-pack";

type Fixture = { name: string; docs: Documents; brief: string; clips: ClipInfo[] };

const clip = (idx: number, hook: string, text: string): ClipInfo => ({
  id: `clip-${idx}`, idx, hook, reason: "A clear, self-contained point", start: idx * 60, end: idx * 60 + 35, score: 0.8, text,
});

const FIXTURES: Fixture[] = [
  {
    name: "invoicing",
    docs: {
      product: { name: "Paylane", one_liner: "Invoicing that chases late payments.", pricing: "$12/month" },
      strategy: { icp: "Freelancers who invoice 3 to 15 clients a month", avoid: ["revolutionary", "game-changer"] },
      content_strategy: {
        pillars: [{ name: "Getting paid", ideas: ["The 3-7-14 reminder rule", "Why invoices go unpaid"] }],
        short_video: "Clips from my demo recordings and a weekly founder talk.",
      },
    },
    brief: "Why polite reminders on day 3, 7 and 14 get invoices paid",
    clips: [
      clip(0, "Most late invoices are forgotten, not refused", "Most late invoices are not refused. The client just forgot. So we send a polite reminder on day three, again on day seven, and a last one on day fourteen."),
      clip(1, "Stop writing awkward follow-up emails", "I used to write every follow-up by hand and it felt awkward every time. Now the reminders go out on their own and I never chase anyone."),
    ],
  },
  {
    name: "uptime",
    docs: {
      product: { name: "Pingwise", one_liner: "Uptime checks that tell you which deploy broke the site.", pricing: "Free for 5 monitors, $9/month after" },
      strategy: { icp: "Solo developers running 1 to 10 small SaaS apps", avoid: ["unleash", "seamless"] },
      content_strategy: { pillars: [{ name: "Shipping safely", ideas: ["Roll back in one click", "The deploy checklist"] }] },
    },
    brief: "The one check every solo developer should run after a deploy",
    clips: [
      clip(0, "Which deploy broke the site?", "When the site goes down at night, the first question is which deploy did it. Pingwise ties every check to the last deploy, so a red check points at a change."),
    ],
  },
  {
    name: "booking",
    docs: {
      product: { name: "Slotty", one_liner: "Booking pages for hair salons with deposits built in.", pricing: "$19/month per salon" },
      strategy: { icp: "Owners of salons with 2 to 6 chairs", avoid: ["disrupt", "synergy"] },
      content_strategy: { pillars: [{ name: "Fewer no-shows", ideas: ["Why deposits cut no-shows", "The reminder text that works"] }] },
    },
    brief: "How a small deposit cuts no-shows without scaring clients away",
    clips: [
      clip(0, "A small deposit changes who shows up", "Salon owners worry a deposit scares people off. In my experience it only filters out the people who were never going to come."),
      clip(1, "The reminder text that works", "Send one short text the day before. Name, time, and a link to move the booking. That is all it needs."),
    ],
  },
];

type Job = "w1" | "w2" | "w5";
type Row = { job: Job; fixture: string; ok: boolean; passing: number; of: number; seconds: number; error: string | null };
type Output = { job: Job; fixture: string; lines: string[] };

function args() {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const job = value("--job");
  return { provider: value("--provider") ?? "fake", yes: argv.includes("--yes"), jobs: (job ? [job] : ["w1", "w2", "w5"]) as Job[] };
}

/**
 * Avoid words and numbers the documents do not contain, in a plan item's idea (it becomes the
 * post's brief). The reason is not checked for numbers: it may quote the playbook's mix ("about
 * 30% of the week"). Lengths such as "a 30-second clip" are formats, not claims.
 */
function ideaIssues(idea: string, reason: string, docs: Documents): string[] {
  const issues: string[] = [];
  const lower = `${idea} ${reason}`.toLowerCase();
  for (const word of avoidList(docs)) if (word.length >= 3 && lower.includes(word.toLowerCase())) issues.push(`uses "${word}"`);
  const known = knownNumbers(docs);
  const text = idea.replace(/\d+[- ]?(seconds?|secs?|minutes?|mins?)\b/gi, "");
  for (const raw of text.match(/\d[\d,.]*%?/g) ?? []) {
    const n = normalizeNumber(raw.replace(/%$/, ""));
    if (!raw.endsWith("%") && Number(n) < 10) continue;
    if (/^(19|20)\d\d$/.test(n)) continue;
    if (!known.has(n)) issues.push(`says ${raw}`);
  }
  return issues;
}

const mentionsVideo = (docs: Documents) => /video|clip|record|reel|short|tiktok/i.test(JSON.stringify(docs.content_strategy ?? {}));

async function runW1(fixture: Fixture, drain: Drain): Promise<[Row, Output]> {
  const mem = memoryStore(fixture.docs, []);
  const run = mem.enqueue("plan_week", {});
  const started = Date.now();
  await drain(mem.store, { runId: run.id, budgetMs: 240_000 });
  const plan = mem.items.filter((i) => i.run_id === run.id);
  const salesPerDay = new Map<string, number>();
  for (const item of plan) if (item.department === "sales") salesPerDay.set(item.day, (salesPerDay.get(item.day) ?? 0) + 1);
  const shapeOk =
    plan.length >= 5 && plan.length <= 10 &&
    [...salesPerDay.values()].every((n) => n <= 1) &&
    (mentionsVideo(fixture.docs) || plan.every((i) => i.department !== "video"));
  const passing = plan.filter((i) => i.reason.trim() && ideaIssues(i.idea, i.reason, fixture.docs).length === 0).length;
  const lines = plan.map((i) => {
    const issues = ideaIssues(i.idea, i.reason, fixture.docs);
    return `${i.day} ${i.department.padEnd(5)} ${i.idea} — ${i.reason}${issues.length ? `  ✗ ${issues.join("; ")}` : ""}`;
  });
  if (!shapeOk) lines.push(`(plan shape is off: ${plan.length} items, Reddit per day ${JSON.stringify(Object.fromEntries(salesPerDay))})`);
  const row: Row = { job: "w1", fixture: fixture.name, ok: run.status === "done" && shapeOk, passing, of: plan.length, seconds: (Date.now() - started) / 1000, error: run.error };
  return [row, { job: "w1", fixture: fixture.name, lines }];
}

async function runW2(fixture: Fixture, drain: Drain): Promise<[Row, Output]> {
  const mem = memoryStore(fixture.docs, []);
  const run = mem.enqueue("post_draft", { idea: fixture.brief });
  const started = Date.now();
  await drain(mem.store, { runId: run.id, budgetMs: 240_000 });
  const item = mem.items.find((i) => i.run_id === run.id);
  const texts = item ? [String(item.body.text ?? ""), ...((item.body.alternates as string[] | undefined) ?? [])] : [];
  const rules = { avoid: avoidList(fixture.docs), known: knownNumbers(fixture.docs) };
  const passing = texts.filter((text) => text && checkPost(text, rules).length === 0).length;
  const row: Row = { job: "w2", fixture: fixture.name, ok: run.status === "done", passing, of: 3, seconds: (Date.now() - started) / 1000, error: run.error };
  return [row, { job: "w2", fixture: fixture.name, lines: texts.map((text, i) => `[${i + 1}] ${text}`) }];
}

async function runW5(fixture: Fixture, drain: Drain): Promise<[Row, Output]> {
  const mem = memoryStore(fixture.docs, []);
  mem.jobs.set("job-1", { status: "done", error: null, createdAt: new Date().toISOString(), title: "Founder talk", clips: fixture.clips });
  const run = mem.enqueue("video_pack", { job_id: "job-1" });
  const started = Date.now();
  await drain(mem.store, { runId: run.id, budgetMs: 240_000 });
  const pack = mem.packs.find((p) => p.runId === run.id);
  const rules = { avoid: avoidList(fixture.docs), known: knownNumbers(fixture.docs) };
  const lines: string[] = [];
  let passing = 0;
  for (const c of fixture.clips) {
    const captions: PlatformCaptions | undefined = pack?.captions[c.id];
    if (!captions) continue;
    // The hook-only fallback means the model's captions failed the checks twice.
    const fellBack = captions.tiktok.trim() === c.hook.trim() && captions.threads.trim() === c.hook.trim();
    const issues = checkCaptions(captions, { ...rules, spoken: normalizeNumber(c.text) });
    if (!fellBack && issues.length === 0) passing += 1;
    lines.push(`clip ${c.idx}${fellBack ? " (fell back to the hook)" : ""}`, ...Object.entries(captions).map(([platform, text]) => `  ${platform}: ${text.replace(/\n/g, " ⏎ ")}`));
  }
  const row: Row = { job: "w5", fixture: fixture.name, ok: run.status === "done", passing, of: fixture.clips.length, seconds: (Date.now() - started) / 1000, error: run.error };
  return [row, { job: "w5", fixture: fixture.name, lines }];
}

type Drain = typeof import("./runner").drainCmoQueue;
const RUNNERS: Record<Job, (fixture: Fixture, drain: Drain) => Promise<[Row, Output]>> = { w1: runW1, w2: runW2, w5: runW5 };
const AGENTS: Record<Job, string[]> = { w1: ["PLANNER"], w2: ["X_WRITER", "CHECKER"], w5: ["VIDEO"] };

async function main() {
  const { provider, yes, jobs } = args();
  if (!["fake", "gemini", "anthropic"].includes(provider)) throw new Error(`Unknown provider ${provider}.`);
  if (jobs.some((job) => !(job in RUNNERS))) throw new Error(`Unknown job ${jobs.join(", ")}; use w1, w2 or w5.`);
  if (provider === "fake") {
    process.env.OPENCMO_AGENT_FAKE = "1";
  } else {
    if (!yes) {
      console.log(`This calls ${provider} for ${jobs.join(", ")} on ${FIXTURES.length} fixtures each. Add --yes to run it.`);
      return;
    }
    process.env.OPENCMO_AGENT_FAKE = "";
    for (const job of jobs) for (const agent of AGENTS[job]) process.env[`CMO_AGENT_${agent}_PROVIDER`] = provider;
  }
  // Imported after the env is set: the jobs read the provider when they run.
  const { drainCmoQueue } = await import("./runner");

  const rows: Row[] = [];
  const outputs: Output[] = [];
  for (const job of jobs) {
    for (const fixture of FIXTURES) {
      const [row, output] = await RUNNERS[job](fixture, drainCmoQueue);
      rows.push(row);
      outputs.push(output);
    }
  }

  if (provider !== "fake") {
    for (const { job, fixture, lines } of outputs) {
      console.log(`\n--- ${job} · ${fixture} ---`);
      for (const line of lines) console.log(line);
    }
    console.log("");
  }
  console.table(rows.map((r) => ({ ...r, seconds: r.seconds.toFixed(1) })));
  for (const job of jobs) {
    const mine = rows.filter((r) => r.job === job);
    const finished = mine.filter((r) => r.ok).length;
    console.log(`${provider} ${job}: ${finished}/${mine.length} runs finished, ${mine.reduce((s, r) => s + r.passing, 0)}/${mine.reduce((s, r) => s + r.of, 0)} outputs passed the checks.`);
  }
  if (provider === "fake" && rows.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
