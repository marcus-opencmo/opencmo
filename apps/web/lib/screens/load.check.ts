/**
 * The P3 and P4 loaders turn real rows into their screen contracts (A3):
 *
 *     cd apps/web && NODE_OPTIONS=--conditions=react-server npx tsx lib/screens/load.check.ts
 *
 * Writer: posts on their own platform (the calendar's labels), captions per platform with the card that shows them,
 * Writer's briefs for Studio, and the voice it reads (rules, voice notes, the product rule, words cut). Library: voice
 * notes with where they came from, their platform and weight; the read-only skills. Rows come from a stub client that
 * applies the same filters the loaders ask for, so a filter that drops the wrong rows shows here; the columns and RPCs
 * themselves are the ones pgTAP 211 and 212 exercise.
 */
import assert from "node:assert/strict";

import { LOADERS } from "./load";
import { compose } from "./registry";

type Row = Record<string, unknown>;

/** Enough of supabase-js for the loaders: filters, order, limit, maybeSingle, rpc. */
function stubClient(tables: Record<string, Row[]>, rpcs: Record<string, unknown[]>) {
  const query = (rows: Row[]) => {
    let out = [...rows];
    const q = {
      select: () => q,
      eq: (col: string, value: unknown) => ((out = out.filter((r) => r[col] === value)), q),
      neq: (col: string, value: unknown) => ((out = out.filter((r) => r[col] !== value)), q),
      in: (col: string, values: unknown[]) => ((out = out.filter((r) => values.includes(r[col]))), q),
      not: (col: string, op: string, value: unknown) => {
        assert.equal(op, "is", "only `not … is null` is stubbed");
        assert.equal(value, null);
        out = out.filter((r) => r[col] !== null && r[col] !== undefined);
        return q;
      },
      gte: (col: string, value: string) => ((out = out.filter((r) => String(r[col]) >= value)), q),
      lt: (col: string, value: string) => ((out = out.filter((r) => String(r[col]) < value)), q),
      order: () => q,
      limit: (n: number) => ((out = out.slice(0, n)), q),
      maybeSingle: async () => ({ data: out[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: out, error: null }).then(resolve, reject),
    };
    return q;
  };
  return {
    from: (table: string) => query(tables[table] ?? []),
    rpc: async (name: string) => ({ data: rpcs[name] ?? [], error: null }),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  };
}

const today = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();
const old = "2020-01-01";

const tables: Record<string, Row[]> = {
  content_items: [
    { id: "p-x", department: "post", platform: "X", day: today, idea: "Week one", status: "in_review", body: { text: "Week one.", alternates: ["Alt."] }, final_text: null, published_at: null, clip_id: null },
    { id: "p-li", department: "post", platform: "LinkedIn", day: today, idea: "Week one", status: "approved", body: { text: "Week one, longer." }, final_text: "Week one, mine.", published_at: null, clip_id: null },
    { id: "p-th", department: "post", platform: "Threads", day: today, idea: "Week one", status: "planned", body: {}, final_text: null, published_at: null, clip_id: null },
    { id: "p-old", department: "post", platform: "X", day: old, idea: "Long ago", status: "published", body: { text: "Old." }, final_text: "Old.", published_at: null, clip_id: null },
    // The plan's video item is not a caption.
    { id: "v-item", department: "video", platform: "TikTok", day: today, idea: "Cut by words", status: "planned", body: {}, final_text: null, published_at: null, clip_id: null },
    { id: "c-tt", department: "video", platform: "tiktok_caption", day: today, idea: "Cut by words", status: "in_review", body: { text: "Cut your demo by words. #saas" }, final_text: null, published_at: null, clip_id: "clip-short" },
    { id: "c-yt", department: "video", platform: "youtube", day: today, idea: "Cut", status: "in_review", body: { text: "Desc.", title: "Cut a demo by words", edited_at: now }, final_text: null, published_at: null, clip_id: "clip-video" },
  ],
  work_orders: [
    { id: "b-1", kind: "write_video_brief", status: "done", brief: { objective: "Show a demo cut by words", platform: "TikTok" }, due_at: `${today}T23:59:00Z`, created_at: now },
    { id: "b-2", kind: "write_video_brief", status: "failed", brief: { objective: "Failed brief" }, due_at: null, created_at: now },
  ],
  approvals: [
    { id: "card-post", ref_kind: "content_item", ref_id: "p-x", status: "waiting" },
    { id: "card-video", ref_kind: "editor_project", ref_id: "clip-video", status: "waiting" },
    { id: "card-batch", ref_kind: "short_batch", ref_id: "batch-1", status: "waiting" },
    { id: "card-time", ref_kind: "schedule_slot", ref_id: "sl-wait", status: "waiting" },
  ],
  shorts: [{ short_clip_id: "clip-short", batch_id: "batch-1", created_at: now }],
  cmo_corrections: [
    { rule: "End on the point itself: no closing ask, no summary line.", status: "active", created_at: now, decided_at: now },
    { rule: "A rejected rule.", status: "rejected", created_at: now, decided_at: now },
  ],
  marketing_documents_latest: [
    { kind: "strategy", body: { avoid: ["game-changer", "unlock", "a phrase far too long to be a single word anyone would cut from a post"] }, created_by: "user", created_at: now },
  ],
  editor_skills: [{ id: "sk-1", name: "demo-cut", description: "How I cut a product demo", created_at: now }],
  cmo_runs: [{ kind: "onboard", input: { site: "https://opencmo.io/" }, created_at: now }],
  brand_kits: [],
  profiles: [{ id: "u", timezone: "Asia/Ho_Chi_Minh", weekly_credit_budget: 50, digest_hour: null, cmo_paused_at: null, plan: "free" }],
  social_accounts: [
    { id: "acc-x", platform: "x", handle: "@founder", avatar_url: "https://pbs.example/x.png", status: "connected", updated_at: now },
    { id: "acc-tt", platform: "tiktok", handle: "@founder", avatar_url: null, status: "error", updated_at: now },
  ],
  // Embedded relations come back nested, as PostgREST returns them.
  schedule_slots: [
    { id: "sl-wait", platform: "x", status: "proposed", publish_at: `${today}T02:00:00Z`, error: null, approval_id: "card-time", account: { handle: "@founder" }, deliverable: { kind: "post", ref_kind: "content_item", ref_id: "p-li" } },
    { id: "sl-ok", platform: "x", status: "published", publish_at: `${today}T05:00:00Z`, error: null, approval_id: "card-old", account: { handle: "@founder" }, deliverable: { kind: "post", ref_kind: "content_item", ref_id: "p-x" } },
    { id: "sl-miss", platform: "tiktok", status: "missed", publish_at: `${today}T09:00:00Z`, error: null, approval_id: null, account: null, deliverable: { kind: "short", ref_kind: "clip", ref_id: "clip-short" } },
    { id: "sl-gone", platform: "x", status: "cancelled", publish_at: `${today}T10:00:00Z`, error: null, approval_id: null, account: null, deliverable: { kind: "post", ref_kind: "content_item", ref_id: "p-th" } },
    { id: "sl-far", platform: "x", status: "waiting", publish_at: "2099-01-01T09:00:00Z", error: null, approval_id: null, account: null, deliverable: null },
  ],
  clips: [{ id: "clip-short", hook: "Cut by words" }],
};

const rpcs: Record<string, unknown[]> = {
  voice_notes: [
    { id: "n-1", body: 'Edited on LinkedIn before approving (cut it shorter): "Week one, mine."', platform: "linkedin", source: "edited", edit_mode: "TOO_LONG", created_at: now, expires_at: now, weight: 0.98 },
    { id: "n-2", body: 'Approved as written on X: "Week one."', platform: "x", source: "approved", edit_mode: null, created_at: now, expires_at: now, weight: 0.5 },
    { id: "n-3", body: 'Skipped a draft on X about "Pricing": Too salesy', platform: null, source: "skipped", edit_mode: null, created_at: now, expires_at: now, weight: 0.1 },
  ],
};

async function main(): Promise<void> {
  const ctx = { supabase: stubClient(tables, rpcs), userId: "u", params: new URLSearchParams() } as never;

  const writer = compose("writer", (await LOADERS.writer!(ctx)) as never, { production: true, sample: false });
  assert.ok(writer.live.drafts && writer.live.voice, "Writer's drafts and voice are live");
  const drafts = new Map(writer.data.drafts.map((d) => [d.id, d]));
  assert.deepEqual([...drafts.keys()].sort(), ["b-1", "c-tt", "c-yt", "p-li", "p-th", "p-x"], "posts, captions and briefs of the last two weeks");
  assert.deepEqual(
    ["p-x", "p-li", "p-th"].map((id) => [drafts.get(id)!.platform, drafts.get(id)!.column]),
    [["x", "waiting"], ["linkedin", "scheduled"], ["threads", "drafting"]],
    "each post on its own platform",
  );
  assert.equal(drafts.get("p-x")!.approvalId, "card-post");
  assert.equal(drafts.get("p-li")!.note, "You edited it before approving");
  assert.deepEqual([drafts.get("c-tt")!.kind, drafts.get("c-tt")!.platform, drafts.get("c-tt")!.approvalId], ["caption", "tiktok", "card-batch"], "a short's caption opens its batch card");
  assert.deepEqual([drafts.get("c-yt")!.platform, drafts.get("c-yt")!.title, drafts.get("c-yt")!.approvalId, drafts.get("c-yt")!.note], ["youtube", "Cut a demo by words", "card-video", "You edited it on the card"]);
  assert.deepEqual([drafts.get("b-1")!.kind, drafts.get("b-1")!.platform, drafts.get("b-1")!.column, drafts.get("b-1")!.note], ["video_brief", "tiktok", "posted", "Fed the Studio team"]);
  assert.deepEqual(writer.data.voice.lines.map((l) => l.text.slice(0, 20)), ["End on the point its", "Edited on LinkedIn b", "Approved as written ", "Skipped a draft on X", "No links, no hashtag"],
    "rules first, then voice notes heaviest first, then the product rule");
  assert.match(writer.data.voice.lines[1]!.source, /^From your edit: shorter · LinkedIn · weight 0\.98$/);
  assert.deepEqual(writer.data.voice.wordsCut, ["game-changer", "unlock"], "the strategy's words to avoid, one or two words each");

  const library = compose("library", (await LOADERS.library!(ctx)) as never, { production: true, sample: false });
  assert.ok(library.live.voice && library.live.skills, "Library's voice and skills are live");
  assert.deepEqual(library.data.voice.notes.map((n) => [n.id, n.platform, n.source, n.weight]), [
    ["n-1", "linkedin", "From your edit: shorter", 0.98],
    ["n-2", "x", "Approved as written", 0.5],
    ["n-3", null, "From a skip reason", 0.1],
  ]);
  assert.deepEqual(library.data.skills.writing.map((s) => [s.id, s.readBy]), [
    ["no-ai-slop", ["Writer", "Checker", "Sales", "CMO chat"]],
    ["platform-profiles", ["Writer", "Checker"]],
  ]);
  assert.ok(library.data.skills.video.some((s) => s.origin === "built_in"), "the style skills we ship");
  assert.deepEqual(library.data.skills.video.filter((s) => s.origin === "yours").map((s) => s.name), ["demo-cut"], "and the founder's own");
  assert.equal(library.data.site, "opencmo.io");

  // P4 A3: Schedule reads this week's slots in the founder's time; Settings lists every platform to connect.
  const week = new URLSearchParams({ from: today });
  const sched = compose("schedule", (await LOADERS.schedule!({ ...(ctx as object), params: week } as never)) as never, { production: true, sample: false });
  assert.ok(sched.live.slots && sched.live.accounts && sched.live.timezone, "Schedule's slots, accounts and timezone are live");
  assert.equal(sched.data.timezone, "Asia/Ho_Chi_Minh");
  // The week starts at Monday midnight in Ho Chi Minh (17:00 UTC on Sunday), not at UTC midnight.
  assert.match(sched.data.from, /T17:00:00(\.000)?Z$/, "the week starts at the founder's Monday midnight");
  assert.equal(new Date(sched.data.from).getUTCDay(), 0);
  assert.deepEqual(
    sched.data.slots.map((x) => [x.id, x.status, x.note, x.approvalId]),
    [
      ["sl-wait", "waiting_founder", null, "card-time"],
      ["sl-ok", "posted", null, null],
      ["sl-miss", "failed", "missed", null],
    ],
    "a card waiting makes it the founder's turn; cancelled and other weeks are left out",
  );
  assert.deepEqual(sched.data.slots.map((x) => x.title), ["Week one, longer.", "Week one.", "Short · Cut by words"]);
  assert.deepEqual(sched.data.accounts.map((a) => [a.platform, a.status]), [["x", "connected"], ["tiktok", "reconnect"]], "only accounts the founder has");
  assert.ok(sched.data.rules.some((r) => r.includes("5 posts a day on X")));

  const settings = compose("settings", (await LOADERS.settings!(ctx)) as never, { production: true, sample: false });
  assert.ok(settings.live.accounts, "Settings → Accounts is live");
  assert.deepEqual(
    settings.data.accounts.map((a) => [a.platform, a.status, a.avatarUrl ?? null]),
    [["x", "connected", "https://pbs.example/x.png"], ["threads", "not_connected", null], ["linkedin", "not_connected", null], ["tiktok", "reconnect", null], ["youtube", "not_connected", null], ["instagram", "not_connected", null]],
    "every platform OpenCMO posts to, in one order",
  );

  console.log("load.check: Writer, Library, Schedule and Settings loaders ok");
}

main().catch((err) => {
  console.error(`load.check: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
