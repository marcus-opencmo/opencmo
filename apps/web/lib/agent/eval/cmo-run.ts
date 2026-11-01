/**
 * Runs the CMO chat memory-safety cases (`cmo-tasks.ts`) through the app's own turn loop:
 *
 *   NODE_OPTIONS=--conditions=react-server tsx lib/agent/eval/cmo-run.ts --provider fake
 *   NODE_OPTIONS=--conditions=react-server tsx lib/agent/eval/cmo-run.ts --provider anthropic --yes   # COSTS API MONEY
 *
 * The seam is the Supabase client, not the loop: `runTurn` (loop.ts) and `cmoScope` (scope.ts) run
 * unchanged on a recording client that keeps the turn, its messages and every RPC in memory. So the
 * system prompt, tool specs, tool code and loop rules are the ones founders get; only the database
 * and the outside world (read tools with a canned answer) are stand-ins.
 */

import type { SupabaseClient } from "@/lib/api/handler";
import type { CaseResult } from "@/lib/eval/compare";
import { usageUsd } from "@/lib/eval/prices";

import { isCmoWrite } from "../cmo-tools";
import type { Ledger } from "../ledger";
import { runTurn } from "../loop";
import { anthropicProvider } from "../providers/anthropic";
import { fakeProvider } from "../providers/fake";
import { geminiKey, geminiProvider } from "../providers/gemini";
import type { Provider, StoredMessage } from "../providers/types";
import { cmoScope, type Scope } from "../scope";
import { slashDirective } from "../slash";
import { CMO_DOCS, CMO_TASKS, gradeCmoTask, type CmoCall, type CmoEvalTask } from "./cmo-tasks";

type Row = Record<string, unknown>;

/** Every RPC the turn made, with the turn's state, for grading. */
export type Recording = { rpcs: { name: string; args: Record<string, unknown> }[]; calls: CmoCall[]; messages: StoredMessage[]; turn: { status: string; error: string | null }; costUsd: number };

/**
 * A stand-in for the user's Supabase client: reads come from fixed tables, writes are recorded and
 * answered with the shape the real RPC returns. Filters other than `eq` are ignored: the fixture
 * tables only hold what the case needs.
 */
export function recordingClient(tables: Record<string, Row[]>): { client: SupabaseClient; ledger: Ledger; recording: Recording } {
  const recording: Recording = { rpcs: [], calls: [], messages: [], turn: { status: "running", error: null }, costUsd: 0 };
  const source = (table: string): Row[] => {
    if (table === "agent_turns") return [{ ...recording.turn, checkpoint_id: null, hold_credits: 1000 }];
    if (table === "agent_messages") return recording.messages as unknown as Row[];
    return tables[table] ?? [];
  };
  const from = (table: string) => {
    let rows = [...source(table)];
    const result = () => ({ data: rows, error: null });
    const query: Record<string, unknown> = {
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => !(column in row) || row[column] === value);
        return query;
      },
      // Paged reads (`history`, the session view): one page holds every fixture row.
      range: (from: number, to: number) => {
        rows = rows.slice(from, to + 1);
        return query;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: rows[0] ? null : { message: "no rows" } }),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
    };
    for (const method of ["select", "gte", "lte", "lt", "gt", "in", "or", "order", "limit", "not", "is"]) query[method] = () => query;
    return query;
  };
  const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
    agent_record_usage: (args) => {
      if (args.p_model === "fake") return 0;
      recording.costUsd += usageUsd({ model: String(args.p_model), input: Number(args.p_input), output: Number(args.p_output), cacheRead: Number(args.p_cache_read), cacheWrite: Number(args.p_cache_write) });
      return 0;
    },
    // The founder's research counters (review R4): under the limit, so the research tools really run.
    cmo_read_hit: () => true,
    agent_append: (args) => recording.messages.push({ role: args.p_role as StoredMessage["role"], content: args.p_content as unknown[] }) && null,
    agent_record_tool: (args) => {
      if (args.p_status !== "pending") recording.calls.push({ name: String(args.p_name), input: args.p_input, ok: args.p_status === "done" });
      return null;
    },
    agent_finish_turn: (args) => {
      recording.turn = { status: String(args.p_status), error: (args.p_error as string | null) ?? null };
      return { status: recording.turn.status, credits: 0, error: recording.turn.error };
    },
    agent_pause_turn: (args) => {
      recording.turn = { status: `awaiting_${String(args.p_reason)}`, error: null };
      return null;
    },
    agent_raise_hold_3d: () => 1000,
    agent_auto_extend: () => 1000,
    cmo_chat_save_document: () => ({ version: 2 }),
    cmo_add_item: (args) => ({ id: "00000000-0000-4000-8000-000000000001", day: args.p_day }),
    // "running", not "queued": a queued run would be kicked through Next's `after()`.
    enqueue_cmo_run: (args) => ({ id: "00000000-0000-4000-8000-000000000002", kind: args.p_kind, status: "running", created_at: new Date().toISOString() }),
  };
  const client = {
    from,
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      if (!name.startsWith("agent_")) recording.rpcs.push({ name, args });
      return { data: answers[name]?.(args) ?? null, error: null };
    },
  };
  // The server's ledger (`_for` RPCs under the service role) answers from the same recording.
  const ledger: Ledger = async <T,>(name: string, args: Record<string, unknown>) => (await client.rpc(name, args)).data as T;
  return { client: client as unknown as SupabaseClient, ledger, recording };
}

export async function runCmoTask(task: CmoEvalTask, provider: Provider): Promise<Recording> {
  const tables = { marketing_documents_latest: Object.entries(CMO_DOCS).map(([kind, body]) => ({ kind, body, created_by: "user", version: 1 })) };
  const { client, ledger, recording } = recordingClient(tables);
  const base = cmoScope(client);
  // The outside world answers with the case's canned text; everything else is the real tool code.
  const scope: Scope = {
    ...base,
    run: async (call) => {
      const canned = task.toolOutputs?.[call.name];
      return canned === undefined ? base.run(call) : { ok: true, content: JSON.stringify(canned), summary: `Canned ${call.name}` };
    },
  };
  // As `startTurn` (session.ts): documents and state ride along with the first message.
  const opening = `${slashDirective(task.prompt, scope.tools.map((tool) => tool.name))}${(await scope.context?.()) ?? ""}${await scope.state()}`;
  recording.messages.push({ role: "user", content: provider.userTurn(task.prompt, opening) as unknown[] });
  await runTurn({ supabase: client, ledger, provider, scope, turn: { id: "turn-1", session_id: "session-1", number: 1, prompt: task.prompt }, emit: () => undefined });
  return recording;
}

/** One `CaseResult` per task, in the shared report format (`lib/eval/compare.ts`). */
export async function runCmoTasks(provider: Provider, opts: { epoch?: number; tasks?: CmoEvalTask[]; log?: (line: string) => void } = {}): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const task of opts.tasks ?? CMO_TASKS) {
    const base = { id: task.id, epoch: opts.epoch ?? 0, ...(task.pending ? { pending: task.pending } : {}) };
    let recording: Recording;
    try {
      recording = await runCmoTask(task, provider);
    } catch (error) {
      results.push({ ...base, pass: false, decided_by: "error", notes: [error instanceof Error ? error.message : String(error)] });
      continue;
    }
    opts.log?.(`${task.id}: ${recording.calls.map((call) => `${call.name}${call.ok ? "" : " (failed)"}`).join(", ") || "no tools"} · ${recording.turn.status}`);
    if (recording.turn.status !== "done") {
      results.push({ ...base, pass: false, decided_by: "error", notes: [`turn ended ${recording.turn.status}${recording.turn.error ? `: ${recording.turn.error}` : ""}`], cost_usd: recording.costUsd });
      continue;
    }
    const grade = gradeCmoTask(task, recording.calls, isCmoWrite);
    results.push({ ...base, pass: grade.pass, decided_by: "code", ...(grade.notes.length ? { notes: grade.notes } : {}), cost_usd: recording.costUsd });
  }
  return results;
}

function providerFor(name: string): Provider {
  if (name === "fake") return fakeProvider;
  if (name === "anthropic") return anthropicProvider();
  if (name === "gemini") return geminiProvider(geminiKey());
  throw new Error(`Unknown provider ${name}; use fake, anthropic or gemini.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const name = argv[argv.indexOf("--provider") + 1] && argv.includes("--provider") ? argv[argv.indexOf("--provider") + 1]! : "fake";
  if (name !== "fake" && !argv.includes("--yes")) {
    console.log(`This runs ${CMO_TASKS.length} CMO chat turns on ${name}. Add --yes to run it.`);
    return;
  }
  if (name === "fake") process.env.OPENCMO_AGENT_FAKE ??= "1";
  const results = await runCmoTasks(providerFor(name), { log: (line) => console.log(line) });
  for (const r of results) console.log(`${r.pending ? "PEND" : r.pass ? "PASS" : "FAIL"} ${r.id}${r.notes?.length ? `  ${r.notes.join("; ")}` : ""}${r.pending ? `  (${r.pending})` : ""}`);
  const cost = results.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  const failed = results.filter((r) => !r.pending && r.pass !== true);
  console.log(`${results.length - failed.length - results.filter((r) => r.pending).length}/${results.length - results.filter((r) => r.pending).length} passed, ${results.filter((r) => r.pending).length} pending · $${cost.toFixed(3)}`);
  if (failed.length) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("cmo-run.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
