/**
 * The v2 screen contracts hold (UI plan, Task U0):
 *
 *     cd apps/web && NODE_OPTIONS=--conditions=react-server npx tsx lib/screens/screens.check.ts
 *
 * Every fixture and every empty value parses with its screen's schema; `live` and `release` name real fields;
 * a field with a live flag has a loader; and `compose` never hands sample data to production.
 */
import assert from "node:assert/strict";

import { ApprovalCardSchema, CARD_KINDS, STUDIO_REF_KIND, ScheduleOptionsSchema, ScheduleSnapshotSchema, StudioSnapshotSchema } from "./approval-card";
import { approvalToCard, type ApprovalRow } from "./cards";
import { ALL_KINDS, SAMPLE_CARDS, SCHEDULE_SNAPSHOT, STATE_CARDS, STUDIO_SNAPSHOTS } from "./fixtures/cards";
import { videoSteps } from "./video-steps";
import { LOADERS } from "./load";
import { SCREEN_NAMES, SCREENS, compose, released, type ScreenName } from "./registry";

const failures: string[] = [];

function check(name: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

for (const name of SCREEN_NAMES) {
  const screen = SCREENS[name];
  const fields = Object.keys(screen.schema.shape);
  check(`${name}: fixture parses`, () => void screen.schema.parse(screen.fixture));
  check(`${name}: empty parses`, () => void screen.schema.parse(screen.empty));
  check(`${name}: live and release name fields`, () => {
    for (const field of [...screen.live, ...screen.release]) assert.ok(fields.includes(field), `unknown field ${field}`);
  });
  check(`${name}: a live field has a loader`, () => {
    if (screen.live.length > 0) assert.ok(LOADERS[name], "live fields but no loader");
  });

  check(`${name}: production never shows sample data`, () => {
    const loaded = screen.fixture as Record<string, unknown>;
    const out = compose(name as ScreenName, loaded as never, { production: true, sample: true });
    for (const field of fields) {
      const expected = (screen.live as readonly string[]).includes(field) ? loaded[field] : (screen.empty as Record<string, unknown>)[field];
      assert.deepEqual((out.data as Record<string, unknown>)[field], expected, field);
    }
  });

  check(`${name}: sample=1 gives the pure fixture, all fields not live`, () => {
    const out = compose(name as ScreenName, {}, { production: false, sample: true });
    assert.deepEqual(out.data, screen.schema.parse(screen.fixture));
    assert.ok(Object.values(out.live).every((v) => v === false));
  });

  check(`${name}: a loader cannot make an unlisted field live`, () => {
    const out = compose(name as ScreenName, screen.empty as never, { production: false, sample: false });
    for (const field of fields) {
      assert.equal(out.live[field as keyof typeof out.live], (screen.live as readonly string[]).includes(field), field);
      if (!(screen.live as readonly string[]).includes(field)) {
        assert.deepEqual((out.data as Record<string, unknown>)[field], (screen.fixture as Record<string, unknown>)[field], field);
      }
    }
  });

  check(`${name}: release follows live`, () => {
    assert.equal(released(name), screen.release.every((f) => (screen.live as readonly string[]).includes(f)));
  });
}

check("cards: one sample of each of the ten kinds", () => {
  assert.deepEqual(ALL_KINDS.map((c) => c.kind), [...CARD_KINDS]);
  for (const card of SAMPLE_CARDS) ApprovalCardSchema.parse(card);
});

check("cards: a body of another kind is refused", () => {
  const [post, reply] = ALL_KINDS;
  assert.equal(ApprovalCardSchema.safeParse({ ...post, body: reply.body }).success, false);
});

check("dashboard: queue holds only waiting cards, team has six nodes", () => {
  const { queue, team } = SCREENS.dashboard.fixture;
  assert.ok(queue.every((c) => c.status === "waiting"));
  assert.equal(team.nodes.length, 6);
});

const row = (kind: ApprovalRow["kind"], snapshot: Record<string, unknown>, extra: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id: "a1",
  kind,
  department: "writer",
  ref_kind: "content_item",
  ref_id: "r1",
  status: "waiting",
  snapshot,
  content_hash: "a".repeat(64),
  price_credits: null,
  post_at: null,
  account: null,
  expires_at: null,
  created_at: "2026-10-29T03:42:00.123456+00:00",
  decided_at: null,
  decided_via: null,
  ...extra,
});

check("cards: every wave-1 row maps to a valid card from its snapshot", () => {
  const rows = [
    row("post", { kind: "post", text: "Most AI video tools stop at the first draft. We built the editor first.", alternates: ["Alt one."], rationale: "Tuesday's insight", idea: "x" }),
    row("reply", {
      kind: "reply",
      url: "https://www.reddit.com/r/SaaS/comments/x/",
      community: "r/SaaS",
      title: "What do you use?",
      reply: "Same here.",
      score: 78,
      score_parts: [{ label: "Pain", score: 22, max: 25, evidence: "I spend more time cutting." }, { label: "Bogus" }],
    }, { department: "sales", ref_kind: "opportunity" }),
    row("goal", { kind: "goal", week: "2026-10-26", goal: "Publish 3 posts", metric: "posts", target: 3 }, { department: "brain", ref_kind: "goal" }),
    row("correction", { kind: "correction", rule: "No question openers.", source_edits: [{ before: "Tired?", after: "Editing takes long." }] }, { department: "brain", ref_kind: "correction" }),
  ];
  for (const r of rows) {
    const card = approvalToCard(r);
    assert.ok(card, r.kind);
    ApprovalCardSchema.parse(card);
    assert.equal(card.contentHash, r.content_hash, "the card carries the hash to send back");
  }
  const post = approvalToCard(rows[0]!)!;
  assert.equal(post.title, "Most AI video tools stop at the first draft.");
  assert.deepEqual(post.body.kind === "post" && post.body.platforms[0]!.versions, [
    "Most AI video tools stop at the first draft. We built the editor first.",
    "Alt one.",
  ]);
  const reply = approvalToCard(rows[1]!)!;
  assert.equal(reply.body.kind === "reply" && reply.body.parts.length, 1, "a malformed score part is dropped");
});

check("cards: a post planned with the calendar's label shows, with its platform's limits", () => {
  const post = (platform: string) =>
    approvalToCard(row("post", { kind: "post", platform, day: "2026-10-29", idea: "Idea", text: "One line.", alternates: [], rationale: "" }));
  const x = post("X");
  assert.ok(x && x.body.kind === "post", "a post planned as X is shown");
  assert.deepEqual(x.body.platforms.map((p) => [p.platform, p.limit]), [["x", 280]]);
  const linkedin = post("LinkedIn");
  assert.ok(linkedin && linkedin.body.kind === "post");
  assert.deepEqual(linkedin.body.platforms.map((p) => [p.platform, p.limit, p.visibleBeforeMore]), [["linkedin", 3000, 140]]);
  assert.match(linkedin.meta, /LinkedIn/);
  const unknown = post("Mastodon");
  assert.ok(unknown && unknown.body.kind === "post" && unknown.body.platforms[0]!.platform === "x", "an unknown label is decided as X, so shown as X");
});

check("cards: Studio kinds are not shown before A1; expired and elsewhere states", () => {
  assert.equal(approvalToCard(row("price", { kind: "price" })), null);
  const past = approvalToCard(row("goal", { kind: "goal", week: "2026-10-26", goal: "Goal", metric: "posts", target: 3 }, { expires_at: "2026-10-01T00:00:00+00:00" }))!;
  assert.equal(past.problem?.kind, "expired");
  const viaMcp = approvalToCard(row("goal", { kind: "goal", week: "2026-10-26", goal: "Goal", metric: "posts", target: 3 }, { status: "approved", decided_via: "mcp", decided_at: "2026-10-29T01:00:00+00:00" }))!;
  assert.equal(viaMcp.problem?.kind, "decided_elsewhere");
});

check("compose: a live field that breaks the contract drops back alone", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const out = compose("settings", { timezone: "UTC", weeklyCreditBudget: -5 } as never, { production: true, sample: false });
    assert.equal(out.live.timezone, true);
    assert.equal(out.data.timezone, "UTC");
    assert.equal(out.live.weeklyCreditBudget, false, "an out-of-bounds budget is not shown as live");
    assert.equal(out.data.weeklyCreditBudget, SCREENS.settings.empty.weeklyCreditBudget);
  } finally {
    console.warn = warn;
  }
});

// P4 A0: the schedule snapshot (SQL `approval_snapshot`) parses; platform fields are a closed set.
check("schedule snapshot parses", () => void ScheduleSnapshotSchema.parse(SCHEDULE_SNAPSHOT));
// P4 A2 writes TikTok's commercial content toggles into every new TikTok slot: a card that does not parse is dropped.
// A card built without its slot never offers Retry on a guess: the state comes from the slot (schedule-enrich.ts).
check("an un-enriched schedule card with a last error is not called failed", () => {
  const row = { id: "00000000-0000-4000-8000-000000000001", kind: "schedule", department: "schedule", ref_kind: "schedule_slot", ref_id: SCHEDULE_SNAPSHOT.slot_id, status: "waiting",
    snapshot: { ...SCHEDULE_SNAPSHOT, last_error: "It could not go out within its time window." }, content_hash: "0".repeat(64), price_credits: null, post_at: null, account: null,
    created_at: new Date().toISOString(), expires_at: null, decided_at: null, decided_via: null, reason: null } as unknown as ApprovalRow;
  const card = approvalToCard(row);
  assert.ok(card && card.body.kind === "schedule" && card.body.state === "waiting" && card.body.lastError);
});
check("schedule snapshot with TikTok's disclosure toggles parses", () => {
  const options = { allow_comment: false, allow_duet: false, allow_stitch: false, brand_organic: false, brand_content: false };
  void ScheduleSnapshotSchema.parse({ ...SCHEDULE_SNAPSHOT, options });
});
check("a schedule snapshot builds a card that parses, with its account in the foot", () => {
  const card = approvalToCard(row("schedule", { ...SCHEDULE_SNAPSHOT }, { department: "schedule", ref_kind: "schedule_slot" }))!;
  assert.ok(card, "the schedule row builds no card");
  ApprovalCardSchema.parse(card);
  assert.deepEqual(card.account, { platform: "tiktok", handle: "@opencmo" });
  assert.equal(card.body.kind === "schedule" && card.body.mode, "publish");
});
check("schedule options refuse unknown fields", () => {
  assert.equal(ScheduleOptionsSchema.safeParse({ ai_label: true, autopost: true }).success, false);
});

// P2 A0: the Studio snapshots (SQL `approval_snapshot`) parse, and every Studio kind has one.
for (const snapshot of STUDIO_SNAPSHOTS) {
  check(`studio snapshot ${snapshot.kind} parses`, () => void StudioSnapshotSchema.parse(snapshot));
}
check("every Studio kind has a snapshot and a source", () => {
  for (const kind of Object.keys(STUDIO_REF_KIND)) assert.ok(STUDIO_SNAPSHOTS.some((s) => s.kind === kind), kind);
});
check("a Studio snapshot builds a card that parses", () => {
  for (const snapshot of STUDIO_SNAPSHOTS) {
    const card = approvalToCard({
      id: `card-${snapshot.kind}`,
      kind: snapshot.kind,
      department: "studio",
      ref_kind: STUDIO_REF_KIND[snapshot.kind],
      ref_id: "ref",
      status: "waiting",
      snapshot: snapshot as unknown as Record<string, unknown>,
      content_hash: "a".repeat(64),
      price_credits: "price_credits" in snapshot ? snapshot.price_credits : null,
      post_at: null,
      account: null,
      expires_at: null,
      created_at: "2026-10-29T03:42:00.123+00:00",
      decided_at: null,
      decided_via: null,
    });
    assert.ok(card, snapshot.kind);
    ApprovalCardSchema.parse(card);
  }
});
check("the Video team's steps follow the order's steps", () => {
  const script = { tool: "create_video", kind: "script" as const, card: { beats: [1, 2, 3] }, next: null, next_done_at: null };
  const waiting = videoSteps({ status: "waiting_founder" }, [{ ...script, status: "waiting", decision: null }], false);
  assert.equal(waiting.find((s) => s.state === "running")?.label, "Storyboard · waits on you");
  assert.equal(waiting[1]!.label, "Director: 3 beats");
  const making = videoSteps({ status: "waiting_order" }, [{ ...script, status: "running", decision: "approve" }], false);
  assert.equal(making.find((s) => s.state === "running")?.label, "Keyframes");
  const sheet = { tool: "animate_video", kind: "price" as const, card: { shots: 4 }, next: { tool: "render" }, next_done_at: "2026-10-29T00:00:00Z", status: "done" as const, decision: "approve" };
  const rendering = videoSteps({ status: "waiting_order" }, [{ ...script, status: "done", decision: "approve", next_done_at: "x" }, sheet], false);
  assert.equal(rendering.find((s) => s.state === "running")?.label, "Render → finished video card");
  assert.ok(videoSteps({ status: "done" }, [{ ...script, status: "done", decision: "approve" }, sheet], false).every((s) => s.state === "done"));
});
check("a snapshot never holds a signed URL", () => {
  for (const snapshot of STUDIO_SNAPSHOTS) assert.doesNotMatch(JSON.stringify(snapshot), /https?:\/\//, snapshot.kind);
});


check("cards: a look check's note reaches the video card (P6 S4), and only when the snapshot has one", () => {
  const video = (look?: Record<string, unknown>) =>
    approvalToCard(
      row("finished_video", {
        kind: "finished_video", clip_id: "11111111-1111-4111-8111-111111111111", title: "Launch", document_hash: "a".repeat(64),
        render_task_id: "t", render_path: "u/c/t.mp4", seconds: 42, ...(look ? { look } : {}),
      }),
    );
  const noted = video({ pass: false, round: 1, note: "Look check: captions run off the bottom (at 0:12)." });
  assert.ok(noted && noted.body.kind === "finished_video");
  ApprovalCardSchema.parse(noted);
  assert.equal(noted.body.lookNote, "Look check: captions run off the bottom (at 0:12).");
  const clean = video();
  assert.ok(clean && clean.body.kind === "finished_video" && clean.body.lookNote === undefined, "no note on a pass");
});

check("cards: an X thread reaches the post card, and an HN reply says where it is (P6 W4, R4)", () => {
  const thread = ["Hook: 5 ways to cut a demo.", "1. Cut the silences.", "2. Captions.", "3. B-roll.", "4. A hook."];
  const post = approvalToCard(row("post", { kind: "post", platform: "X", day: "2026-10-29", idea: "Idea", text: thread[0], alternates: [], rationale: "", thread }));
  assert.ok(post && post.body.kind === "post");
  ApprovalCardSchema.parse(post);
  assert.deepEqual(post.body.platforms[0]!.thread, thread);
  const single = approvalToCard(row("post", { kind: "post", platform: "X", day: "2026-10-29", idea: "Idea", text: "One.", alternates: [], rationale: "" }));
  assert.ok(single && single.body.kind === "post" && single.body.platforms[0]!.thread === undefined, "a single post has no thread");
  const hn = approvalToCard(row("reply", { kind: "reply", platform: "hn", url: "https://news.ycombinator.com/item?id=4242", community: "", title: "Ask HN", reply: "Cut first.", score: 80, score_parts: [] }));
  assert.ok(hn && hn.body.kind === "reply");
  ApprovalCardSchema.parse(hn);
  assert.equal(hn.body.platform, "hn");
  assert.equal(hn.body.community, "Hacker News");

  // 270 code points with 15 emoji is 285 UTF-16 units: within X's 280, as SQL counts it. zod 4's `max` counts code
  // points too; this pins that, so a zod change that counted UTF-16 units would not silently drop thread cards.
  const emoji = "🚀".repeat(15) + "x".repeat(255);
  assert.equal([...emoji].length, 270);
  const long = [emoji, ...thread.slice(1)];
  const withEmoji = approvalToCard(row("post", { kind: "post", platform: "X", day: "2026-10-29", idea: "Idea", text: thread[0], alternates: [], rationale: "", thread: long }));
  assert.ok(withEmoji && withEmoji.body.kind === "post", "a thread post with emoji still makes its card");
  ApprovalCardSchema.parse(withEmoji);
  void ScheduleSnapshotSchema.parse({ ...SCHEDULE_SNAPSHOT, thread: long });
  assert.equal(ScheduleSnapshotSchema.safeParse({ ...SCHEDULE_SNAPSHOT, thread: ["x".repeat(281), ...thread.slice(1)] }).success, false, "281 is too long");
});

check("cards: a 100-character handle still makes a valid schedule card (the queue must not empty)", () => {
  const card = approvalToCard(row("schedule", { ...SCHEDULE_SNAPSHOT, handle: "h".repeat(100) }, { department: "schedule", ref_kind: "schedule_slot" }));
  assert.ok(card && card.body.kind === "schedule");
  ApprovalCardSchema.parse(card);
  assert.equal(card.body.where.handle.length, 80);
});

// Last: a check registered after this gate could never fail the script.
if (failures.length) {
  console.error(`screens.check: ${failures.length} failed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`screens.check: ${SCREEN_NAMES.length} screens, ${ALL_KINDS.length + STATE_CARDS.length} cards ok`);
