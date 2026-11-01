/**
 * Evals for the AI CMO jobs, used to compare models and prompts and to catch regressions:
 *
 *   npm run cmo:eval -- --provider fake                          # CI: checks the harness, costs nothing
 *   npm run cmo:eval -- --provider anthropic --yes               # real model: COSTS API MONEY
 *   npm run cmo:eval -- --provider gemini --yes --job w1,w2      # some jobs only
 *   npm run cmo:eval -- --provider anthropic --yes --epochs 3 --max-usd 2 --compare base.json
 *
 * Cases come from a registry (`eval/types.ts`): W1/W2 in `eval/core.ts`, the rest from every
 * file in `eval/cases/`. Each runs the real job (prompts, schemas, checks, fixes) against an
 * in-memory store, then is graded by code first and, where a case asks for it, by the cascade
 * judge (`judge.ts`) on the provider that did not draft.
 *
 * Flags:
 *   --epochs N     run everything N times (default 1); a comparison uses each case's majority
 *   --out path     report JSON (default .cmo-eval/report.json)
 *   --compare p    pair this run with an earlier report: McNemar exact, BETTER / WORSE / INCONCLUSIVE
 *   --max-usd X    stop starting cases once X USD is spent (also EVAL_MAX_USD)
 *   --list-jobs    print the registered jobs, comma-separated, and exit
 *
 * Pending cases (guarding something not built yet) are listed apart and never fail a run. A fake
 * run fails on any scored fail; a real run only reports.
 */

import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { summarize, type EvalReport } from "@/lib/eval/compare";
import { gitInfo, printComparison, writeReport } from "@/lib/eval/report";

type Provider = "fake" | "anthropic" | "gemini";

function args() {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const number = (flag: string, raw: string | undefined) => {
    if (raw === undefined || raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number, got "${raw}".`);
    return n;
  };
  const epochs = number("--epochs", value("--epochs")) ?? 1;
  if (!Number.isInteger(epochs)) throw new Error("--epochs needs a whole number.");
  return {
    provider: (value("--provider") ?? "fake") as Provider,
    yes: argv.includes("--yes"),
    jobs: value("--job")?.split(",").map((job) => job.trim()).filter(Boolean) ?? null,
    epochs,
    out: resolve(value("--out") ?? join(process.cwd(), ".cmo-eval", "report.json")),
    compare: value("--compare") ? resolve(value("--compare")!) : null,
    maxUsd: number("--max-usd", value("--max-usd") ?? process.env.EVAL_MAX_USD),
    listJobs: argv.includes("--list-jobs"),
  };
}

/** Every file in `eval/cases/` registers its own cases when imported; sorted, so the order is stable. */
async function loadCases() {
  await import("./eval/core");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "eval", "cases");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((file) => /\.ts$/.test(file) && !/\.check\.ts$/.test(file) && !file.endsWith(".d.ts")).sort();
  } catch {
    // No cases directory yet.
  }
  for (const file of files) await import(pathToFileURL(join(dir, file)).href);
  const { registeredCases } = await import("./eval/types");
  return registeredCases();
}

async function main() {
  const options = args();
  if (!["fake", "anthropic", "gemini"].includes(options.provider)) throw new Error(`Unknown provider ${options.provider}; use fake, anthropic or gemini.`);
  if (options.provider === "fake") {
    process.env.OPENCMO_AGENT_FAKE = "1";
  } else {
    process.env.OPENCMO_AGENT_FAKE = "";
    // Every CMO agent drafts on the chosen provider; the judge then prefers the other one.
    process.env.CMO_LLM_PROVIDER = options.provider;
  }

  const all = await loadCases();
  const known = [...new Set(all.map((c) => c.job))];
  if (options.listJobs) {
    console.log(known.join(","));
    return;
  }
  const unknown = (options.jobs ?? []).filter((job) => !known.includes(job));
  if (unknown.length) throw new Error(`Unknown job ${unknown.join(", ")}; use ${known.join(", ")}.`);
  const cases = options.jobs ? all.filter((c) => options.jobs!.includes(c.job)) : all;
  const { FIXTURES } = await import("./eval/fixtures");
  const count = cases.reduce((sum, c) => sum + (c.once ? 1 : FIXTURES.length), 0) * options.epochs;

  if (options.provider !== "fake" && !options.yes) {
    console.log(`This calls ${options.provider} for ${count} case runs (${[...new Set(cases.map((c) => c.job))].join(", ")} × ${FIXTURES.length} fixtures × ${options.epochs} epochs), plus the judge. Add --yes to run it${options.maxUsd ? `; it stops starting cases after $${options.maxUsd}` : ""}.`);
    return;
  }

  // Imported after the env is set: the jobs read the provider when they run.
  const { drainCmoQueue } = await import("./runner");
  const { fakeJudge, modelJudge } = await import("./judge");
  const { runCases, tableRow } = await import("./eval/runner");
  const judge = options.provider === "fake" ? fakeJudge() : modelJudge({ drafter: options.provider });

  const started_at = new Date().toISOString();
  const outcome = await runCases({
    cases,
    fixtures: FIXTURES,
    epochs: options.epochs,
    provider: options.provider,
    judge,
    drain: drainCmoQueue,
    maxUsd: options.maxUsd,
    onRun: (run) => {
      if (options.provider === "fake" || !run.lines.length) return;
      console.log(`\n--- ${run.job} · ${run.fixture}${options.epochs > 1 ? ` · epoch ${run.epoch}` : ""} ---`);
      for (const line of run.lines) console.log(line);
    },
  });

  const results = outcome.runs.flatMap((run) => run.results);
  const drafting = [...outcome.models].filter(([agent]) => agent !== "checker").flatMap(([, models]) => [...models]);
  const report: EvalReport = {
    suite: "cmo",
    git: gitInfo(),
    provider: options.provider,
    model: drafting.length ? [...new Set(drafting)].sort().join(", ") : null,
    prompt_versions: outcome.promptVersions,
    started_at,
    cases: results,
  };
  writeReport(options.out, report);

  console.log("");
  console.table(outcome.runs.map(tableRow));
  const pending = results.filter((r) => r.pending);
  if (pending.length) {
    console.log("\nPending (reported, never fail the run):");
    for (const r of pending) console.log(`  ${r.pass ? "pass" : r.pass === null ? "unscored" : "fail"}  ${r.id} — ${r.pending}`);
  }
  for (const job of [...new Set(outcome.runs.map((run) => run.job))]) {
    const mine = outcome.runs.filter((run) => run.job === job);
    const rows = mine.map(tableRow);
    const totals = summarize(mine.flatMap((run) => run.results.filter((r) => !r.id.endsWith(":run"))));
    console.log(
      `${options.provider} ${job}: ${rows.filter((row) => row.ok).length}/${rows.length} runs finished, ${totals.passed}/${totals.passed + totals.failed + totals.unscored} outputs passed` +
        `${totals.unscored ? ` (${totals.unscored} unscored)` : ""}${totals.pending ? `, ${totals.pending} pending` : ""}.`,
    );
  }
  const all_ = summarize(results);
  console.log(`spent $${outcome.spentUsd.toFixed(3)}${outcome.skipped ? ` · ${outcome.skipped} case runs not started (cap $${options.maxUsd})` : ""} · report ${options.out}`);
  if (options.compare) printComparison(options.compare, report);

  if (options.provider === "fake" && all_.failed > 0) {
    for (const r of results.filter((r) => !r.pending && r.pass === false)) console.error(`FAIL ${r.id}: ${(r.notes ?? []).join("; ").split("\n")[0]}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
