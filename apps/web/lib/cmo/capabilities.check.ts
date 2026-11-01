/**
 * The capability registry holds (`packages/contracts/capabilities.json`, brain.md §7, P2 F1):
 *
 *     cd apps/web && npx tsx lib/cmo/capabilities.check.ts
 *
 * Every entry follows `capabilities.schema.json` (the same rules as the zod schema below, compared field by field so
 * the two cannot drift), every CMO job is listed once, and a job's fixed price is the one SQL charges
 * (`cmo_job_price` in the latest migration that defines it). Studio (A4): the six adapter entries have the callers
 * `STUDIO_ACCESS` gives them, and every priced Studio tool (MCP's `PRICED`, the caption tools) is listed.
 *
 * Caller paths (A4): every file that starts a CMO job or calls the Studio adapter must be in `CALLER_PATHS`, and
 * every job or entry it reaches must list that file's caller. A new path (a private brain shortcut, a new route)
 * fails here until the registry says who it is.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { STUDIO_ACCESS, STUDIO_ENTRIES, type StudioEntry } from "../departments/studio/types";

import { CMO_JOB_KINDS } from "./jobs/types";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (...path: string[]) => JSON.parse(readFileSync(join(ROOT, ...path), "utf8")) as unknown;

export const DEPARTMENTS = ["brain", "research", "writer", "studio", "sales", "schedule", "publish"] as const;
export const EFFECTS = ["read", "write", "spend", "outbound"] as const;
export const APPROVALS = ["none", "founder", "price"] as const;
export const CALLERS = ["brain", "assistant", "mcp", "ui"] as const;

const name = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
export const CapabilitySchema = z
  .object({
    name,
    department: z.enum(DEPARTMENTS),
    effect: z.enum(EFFECTS),
    approval: z.enum(APPROVALS),
    callers: z
      .array(z.enum(CALLERS))
      .min(1)
      .refine((list) => new Set(list).size === list.length, "callers repeat"),
    order_kind: name.nullable(),
    max_steps: z.number().int().min(1).max(200),
    credits: z.union([z.number().int().min(0), z.literal("quote"), z.literal("usage")]),
    input: z.string().min(1).max(80),
    $comment: z.string().optional(),
  })
  .strict();
export type Capability = z.infer<typeof CapabilitySchema>;

export const RegistrySchema = z
  .object({ $schema: z.string().optional(), $comment: z.string().optional(), capabilities: z.array(CapabilitySchema).min(1) })
  .strict();

const failures: string[] = [];
function check(label: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const registry = RegistrySchema.parse(read("packages", "contracts", "capabilities.json"));
const byName = new Map(registry.capabilities.map((c) => [c.name, c]));

check("names are unique", () => assert.equal(byName.size, registry.capabilities.length));

check("the JSON schema has the zod schema's enums and fields", () => {
  type Def = { required: string[]; properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }> };
  const schema = read("packages", "contracts", "capabilities.schema.json") as { $defs: { capability: Def } };
  const def = schema.$defs.capability;
  assert.deepEqual(def.properties.department!.enum, [...DEPARTMENTS]);
  assert.deepEqual(def.properties.effect!.enum, [...EFFECTS]);
  assert.deepEqual(def.properties.approval!.enum, [...APPROVALS]);
  assert.deepEqual(def.properties.callers!.items!.enum, [...CALLERS]);
  const fields = Object.keys(CapabilitySchema.shape).filter((key) => key !== "$comment");
  assert.deepEqual([...def.required].sort(), [...fields].sort());
  assert.deepEqual(Object.keys(def.properties).sort(), Object.keys(CapabilitySchema.shape).sort());
});

check("every CMO job is listed, with its order kind", () => {
  for (const kind of [...CMO_JOB_KINDS, "onboard"]) {
    const entry = byName.get(kind);
    assert.ok(entry, `${kind} missing`);
    if (kind !== "onboard") assert.equal(entry.order_kind, kind, kind);
  }
});

/** `cmo_job_price` as the latest migration defining it writes it: `when '<kind>' then <n>`. */
export function sqlPrices(sql: string): Map<string, number> | null {
  const matches = [...sql.matchAll(/function public\.cmo_job_price\(p_kind text\)[\s\S]*?\$\$([\s\S]*?)\$\$/gi)];
  const last = matches.at(-1);
  if (!last) return null;
  return new Map([...last[1]!.matchAll(/when '([a-z_]+)' then (\d+)/g)].map((m) => [m[1]!, Number(m[2])]));
}

check("a job's price is the one SQL charges", () => {
  const dir = join(ROOT, "supabase", "migrations");
  let prices: Map<string, number> | null = null;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    prices = sqlPrices(readFileSync(join(dir, file), "utf8")) ?? prices;
  }
  assert.ok(prices, "cmo_job_price not found in any migration");
  for (const kind of CMO_JOB_KINDS) assert.equal(byName.get(kind)!.credits, prices.get(kind) ?? 0, kind);
});

check("spending needs a card or a fixed price", () => {
  for (const c of registry.capabilities) {
    if (c.credits === "quote") assert.equal(c.approval, "price", `${c.name}: a quoted price is shown on a card`);
    if (c.credits === "usage") assert.equal(c.effect, "spend", `${c.name}: charged by usage, so it spends`);
    if (c.effect === "outbound") assert.notEqual(c.approval, "none", `${c.name}: outbound always waits on the founder`);
  }
});

// ------------------------------------------------------------------ Studio (A4)

/** The registry name of each adapter entry. */
export const ENTRY_NAME: Record<StudioEntry, string> = {
  plan: "studio_plan",
  decide: "studio_decide",
  buildVideo: "build_video",
  cutShorts: "cut_shorts",
  markFinished: "mark_finished",
  renderShort: "render_short",
  buildSlideshow: "build_slideshow",
  buildPostImage: "build_post_image",
};

const source = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8");
const sameSet = (a: readonly string[], b: readonly string[], label: string) => assert.deepEqual([...new Set(a)].sort(), [...new Set(b)].sort(), label);

check("every Studio adapter entry has STUDIO_ACCESS's callers", () => {
  for (const entry of STUDIO_ENTRIES) {
    const listed = byName.get(ENTRY_NAME[entry]);
    assert.ok(listed, `${ENTRY_NAME[entry]} missing`);
    assert.equal(listed.department, "studio", entry);
    sameSet(listed.callers, STUDIO_ACCESS[entry], entry);
  }
});

/** MCP's `PRICED` set plus the caption tools it spreads in (read as text: the module needs a server). */
export function pricedTools(studioGroup: string, captions: string): string[] {
  const block = /export const PRICED = new Set\(\[([\s\S]*?)\]\)/.exec(studioGroup);
  assert.ok(block, "PRICED not found in packages/mcp-server/src/groups/studio.ts");
  const names = [...block[1]!.matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]!);
  if (block[1]!.includes("...CAPTION_TOOLS")) {
    const specs = /export const CAPTION_TOOL_SPECS[^=]*= \[([\s\S]*?)\n\];/.exec(captions);
    assert.ok(specs, "CAPTION_TOOL_SPECS not found in apps/web/lib/agent/captions-tool.ts");
    names.push(...[...specs[1]!.matchAll(/spec\(\s*"([a-z_0-9]+)"/g)].map((m) => m[1]!));
  }
  return names;
}

check("every priced Studio tool is listed, priced on a card, for the Assistant and MCP", () => {
  const tools = pricedTools(source("packages", "mcp-server", "src", "groups", "studio.ts"), source("apps", "web", "lib", "agent", "captions-tool.ts"));
  assert.ok(tools.length >= 10, `only ${tools.length} priced tools found`);
  for (const tool of tools) {
    const listed = byName.get(tool);
    assert.ok(listed, `${tool} missing`);
    assert.equal(listed.department, "studio", tool);
    assert.equal(listed.approval, "price", tool);
    for (const caller of ["assistant", "mcp"] as const) assert.ok(listed.callers.includes(caller), `${tool}: ${caller}`);
  }
  const adapter = new Set(Object.values(ENTRY_NAME));
  const studioTools = registry.capabilities.filter((c) => c.department === "studio" && !adapter.has(c.name)).map((c) => c.name);
  sameSet(studioTools, tools, "Studio tools listed but not priced in MCP");
});

check("the brain reaches single Studio tools only through the long-take team", () => {
  const team = new Set(["create_video", "animate_video", "redo_keyframe"]);
  for (const c of registry.capabilities) {
    if (c.department === "studio" && !Object.values(ENTRY_NAME).includes(c.name) && c.callers.includes("brain")) {
      assert.ok(team.has(c.name), `${c.name}: the brain briefs the team, it does not drive single tools (brain.md §7b)`);
      assert.equal(c.order_kind, "build_video", c.name);
    }
  }
});

// ------------------------------------------------------------- Caller paths (A4)

type Caller = (typeof CALLERS)[number];
type CallerPath = {
  callers: readonly Caller[];
  /** What the file reaches: CMO job kinds or Studio registry names, read from its source. */
  reaches: (text: string) => string[];
};

const literals = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[1]!);
const studioEntries = (text: string) => literals(text, /\.(plan|decide|buildVideo|cutShorts|markFinished|renderShort)\(/g).map((e) => ENTRY_NAME[e as StudioEntry]);

/**
 * Every path into a CMO job or the Studio adapter, from the repo root. Helpers that only define the call
 * (`jobs/start.ts`, the adapter itself) are not paths. Checks, evals and e2e are not callers.
 */
export const CALLER_PATHS: Record<string, CallerPath> = {
  // The founder's buttons: "Plan my week", "Run now".
  "apps/web/app/api/v1/cmo/runs/route.ts": { callers: ["ui"], reaches: (t) => literals(/kind: z\.enum\(\[([^\]]*)\]/.exec(t)?.[1] ?? "", /"([a-z_]+)"/g) },
  "apps/web/lib/cmo/onboard.ts": { callers: ["ui"], reaches: (t) => literals(t, /p_kind: "([a-z_]+)"/g) },
  // The CMO chat (Assistant, scope `cmo`) and MCP's CMO tools share this file (`lib/cmo/mcp/cmo.ts` runs it).
  "apps/web/lib/agent/cmo-tools.ts": { callers: ["assistant", "mcp"], reaches: (t) => literals(/const JOB_OF = \{([^}]*)\}/.exec(t)?.[1] ?? "", /: "([a-z_]+)"/g) },
  // The brain's loops: the daily schedule runs the kinds `loops.ts` names; the progress check replans the week.
  "apps/web/lib/cmo/schedule.ts": { callers: ["brain"], reaches: () => literals(source("apps", "web", "lib", "cmo", "loops.ts"), /kind: "([a-z_]+)"/g) },
  "apps/web/lib/cmo/jobs/progress-run.ts": { callers: ["brain"], reaches: (t) => literals(t, /p_kind: "([a-z_]+)"/g) },
  // The brain's Studio order runner (P2 A2): build_video and cut_shorts orders, approved steps, card 2.
  "apps/web/lib/cmo/jobs/studio-orders.ts": { callers: ["brain"], reaches: studioEntries },
  // B5: the founder's Mark finished and Cut shorts buttons.
  "apps/web/app/api/v1/studio/[clipId]/finished/route.ts": { callers: ["ui"], reaches: studioEntries },
  "apps/web/app/api/v1/studio/[clipId]/shorts/route.ts": { callers: ["ui"], reaches: studioEntries },
  // MCP's studio group: every Studio tool through the adapter.
  "packages/mcp-server/src/groups/studio.ts": { callers: ["mcp"], reaches: studioEntries },
};

/** A file is a path when it starts a CMO job or builds the Studio adapter. */
const CALL = /\bstartCmoRun\(|["'](?:enqueue_cmo_run|enqueue_cmo_run_for|start_cmo_run)["']|\bstudio\(\s*\{/;
const DEFINES = new Set(["apps/web/lib/cmo/jobs/start.ts", "apps/web/lib/departments/studio/adapter.ts"]);
const NOT_CALLERS = /(\.check\.ts|\.test\.ts|\.e2e\.ts|\.spec\.ts)$|\/eval\/|\/e2e\//;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

check("every caller path is listed, and reaches only what lists its caller", () => {
  const files = [...walk("apps/web/app"), ...walk("apps/web/lib"), ...walk("apps/web/components"), ...walk("packages/mcp-server/src")];
  const found = files.filter((f) => !DEFINES.has(f) && !NOT_CALLERS.test(f) && CALL.test(source(f)));
  for (const file of found) assert.ok(CALLER_PATHS[file], `${file} starts a CMO job or calls Studio but is not in CALLER_PATHS`);
  for (const [file, path] of Object.entries(CALLER_PATHS)) {
    // Listed ahead of its commit (a session lists a path before the route lands): nothing to read yet.
    if (!existsSync(join(ROOT, file))) continue;
    const text = source(file);
    const reached = path.reaches(text);
    assert.ok(reached.length > 0, `${file}: reaches nothing (is the pattern stale?)`);
    for (const name of reached) {
      const listed = byName.get(name);
      assert.ok(listed, `${file} reaches ${name}, which the registry does not list`);
      for (const caller of path.callers) assert.ok(listed.callers.includes(caller), `${file} (${caller}) reaches ${name}, which does not list ${caller}`);
    }
  }
  assert.ok(source("apps", "web", "lib", "cmo", "mcp", "cmo.ts").includes("runCmoTool"), "MCP's CMO tools no longer run cmo-tools.ts");
});

if (failures.length) {
  console.error(`capabilities.check: ${failures.length} failed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`capabilities.check: ${registry.capabilities.length} capabilities ok`);
