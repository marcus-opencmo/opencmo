/**
 * Eval for W2 (X post drafts), used to choose the default LLM provider:
 *
 *   npm run cmo:eval -- --provider fake                  # CI: checks the harness, costs nothing
 *   npm run cmo:eval -- --provider gemini --yes          # real model: COSTS API MONEY
 *   npm run cmo:eval -- --provider anthropic --yes
 *
 * Runs the real `post_draft` job (writer + checker + one fix) against an in-memory store for each
 * fixture product, then grades with code only: did the run finish, how many of the three
 * versions survived the code checks, and how long it took. Compare the two providers' tables and
 * set `CMO_LLM_PROVIDER` to the winner.
 */

import { checkPost } from "./check-post";
import { avoidList, knownNumbers } from "./context";
import { memoryStore } from "./memory-store";
import type { Documents } from "./types";

type Fixture = { name: string; docs: Documents; brief: string };

const FIXTURES: Fixture[] = [
  {
    name: "invoicing",
    docs: {
      product: { name: "Paylane", one_liner: "Invoicing that chases late payments.", pricing: "$12/month" },
      strategy: { icp: "Freelancers who invoice 3 to 15 clients a month", avoid: ["revolutionary", "game-changer"] },
      content_strategy: { pillars: [{ name: "Getting paid", ideas: ["The 3-7-14 reminder rule", "Why invoices go unpaid"] }] },
    },
    brief: "Why polite reminders on day 3, 7 and 14 get invoices paid",
  },
  {
    name: "uptime",
    docs: {
      product: { name: "Pingwise", one_liner: "Uptime checks that tell you which deploy broke the site.", pricing: "Free for 5 monitors, $9/month after" },
      strategy: { icp: "Solo developers running 1 to 10 small SaaS apps", avoid: ["unleash", "seamless"] },
      content_strategy: { pillars: [{ name: "Shipping safely", ideas: ["Roll back in one click", "The deploy checklist"] }] },
    },
    brief: "The one check every solo developer should run after a deploy",
  },
  {
    name: "booking",
    docs: {
      product: { name: "Slotty", one_liner: "Booking pages for hair salons with deposits built in.", pricing: "$19/month per salon" },
      strategy: { icp: "Owners of salons with 2 to 6 chairs", avoid: ["disrupt", "synergy"] },
      content_strategy: { pillars: [{ name: "Fewer no-shows", ideas: ["Why deposits cut no-shows", "The reminder text that works"] }] },
    },
    brief: "How a small deposit cuts no-shows without scaring clients away",
  },
];

function args() {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--provider");
  return { provider: index >= 0 ? argv[index + 1] : "fake", yes: argv.includes("--yes") };
}

async function main() {
  const { provider, yes } = args();
  if (!["fake", "gemini", "anthropic"].includes(provider)) throw new Error(`Unknown provider ${provider}.`);
  if (provider === "fake") {
    process.env.OPENCMO_AGENT_FAKE = "1";
  } else {
    if (!yes) {
      console.log(`This calls ${provider} about ${FIXTURES.length * 3} times (writer, checker, fix per fixture). Add --yes to run it.`);
      return;
    }
    process.env.OPENCMO_AGENT_FAKE = "";
    process.env.CMO_AGENT_X_WRITER_PROVIDER = provider;
    process.env.CMO_AGENT_CHECKER_PROVIDER = provider;
  }
  // Imported after the env is set: the job reads the provider when it runs.
  const { drainCmoQueue } = await import("./runner");

  const rows: { fixture: string; ok: boolean; passing: number; seconds: number; error: string | null }[] = [];
  const drafts: { fixture: string; texts: string[] }[] = [];
  for (const fixture of FIXTURES) {
    const mem = memoryStore(fixture.docs, []);
    const run = mem.enqueue("post_draft", { idea: fixture.brief });
    const started = Date.now();
    await drainCmoQueue(mem.store, { runId: run.id, budgetMs: 240_000 });
    const seconds = (Date.now() - started) / 1000;
    const item = mem.items.find((i) => i.run_id === run.id);
    const texts = item ? [String(item.body.text ?? ""), ...((item.body.alternates as string[] | undefined) ?? [])] : [];
    const rules = { avoid: avoidList(fixture.docs), known: knownNumbers(fixture.docs) };
    const passing = texts.filter((text) => text && checkPost(text, rules).length === 0).length;
    rows.push({ fixture: fixture.name, ok: run.status === "done", passing, seconds, error: run.error });
    drafts.push({ fixture: fixture.name, texts });
  }

  // The checks only catch rule breaks; the drafts still need reading before choosing a provider.
  if (provider !== "fake") {
    for (const { fixture, texts } of drafts) {
      console.log(`\n--- ${fixture} ---`);
      texts.forEach((text, i) => console.log(`[${i + 1}] ${text}`));
    }
    console.log("");
  }
  console.table(rows.map((r) => ({ ...r, seconds: r.seconds.toFixed(1) })));
  const finished = rows.filter((r) => r.ok).length;
  const versions = rows.reduce((sum, r) => sum + r.passing, 0);
  console.log(`${provider}: ${finished}/${rows.length} runs finished, ${versions}/${rows.length * 3} versions passed the checks.`);
  if (provider === "fake" && finished !== rows.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
