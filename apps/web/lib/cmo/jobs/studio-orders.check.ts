/**
 * The Studio order runner's pure parts (P2 A2):
 *
 *     cd apps/web && NODE_OPTIONS=--conditions=react-server npx tsx lib/cmo/jobs/studio-orders.check.ts
 *
 * A week plan keeps one video unless the founder asked for more; a video order's brief becomes the adapter's brief;
 * a redone keyframe swaps exactly one generation in card 2's input.
 */
import assert from "node:assert/strict";

import { toPlanItems, videosAsked } from "./plan-week";
import { briefOf, withKeyframe } from "./studio-orders";

const video = (idea: string) => ({ day_offset: 1, department: "video" as const, platform: "Shorts", idea, reason: "why" });
const post = { day_offset: 0, department: "post" as const, platform: "X", idea: "A post", reason: "why" };

assert.equal(toPlanItems({ items: [post, video("a"), video("b")] }).filter((i) => i.department === "video").length, 1, "one video a week");
assert.equal(toPlanItems({ items: [post, video("a"), video("b")] }, new Date(), 2).filter((i) => i.department === "video").length, 2, "unless asked");
assert.equal(videosAsked("Make 2 videos about the launch"), 2);
assert.equal(videosAsked("one video please"), 1);
assert.equal(videosAsked("posts only"), 0);
assert.equal(videosAsked(undefined), 0);

const order = (brief: Record<string, unknown>) => ({ id: "o", user_id: "u", kind: "build_video", brief });
const b = briefOf(order({ objective: "How the CMO plans a week", angle: "Launch week", seconds: 45, aspect: "16:9" }));
assert.deepEqual([b.objective, b.angle, b.seconds, b.aspect], ["How the CMO plans a week", "Launch week", 45, "16:9"]);
const d = briefOf(order({ objective: "x", seconds: 500, aspect: "4:3" }));
assert.equal(d.seconds, 90, "seconds are clamped");
assert.equal(d.aspect, "9:16", "an unknown frame falls back to vertical");
assert.ok(d.objective.length >= 3, "a too-short objective is replaced, not refused");
// P3 A2: the brief as SQL writes it once Writer's `write_video_brief` ran (`work_orders_brief_rules`).
const w = briefOf(order({ objective: "Show a demo cut by words", angle: "Founder's screen", hooks: ["Cut by words.", "No timeline.", "One take."],
  key_points: ["Delete words to cut"], cta: "Try it on your demo", seconds: 40, aspect: "9:16", platform: "TikTok", brief_from: "writer" }));
assert.deepEqual([w.hooks, w.keyPoints, w.cta, w.seconds], [["Cut by words.", "No timeline.", "One take."], ["Delete words to cut"], "Try it on your demo", 40],
  "Writer's hooks, key points and call to action reach the Director");
assert.equal(briefOf(order({ objective: "A plan item" })).cta, "", "a plan item alone has no call to action");

const input = { keyframes: [{ generation_id: "g0", note: 1 }, { generation_id: "g1" }], seconds: 30 };
assert.deepEqual(withKeyframe(input, 1, "g9"), { keyframes: [{ generation_id: "g0", note: 1 }, { generation_id: "g9" }], seconds: 30 });
assert.equal(withKeyframe(input, 5, "g9"), null, "only a keyframe on the sheet");
assert.equal(withKeyframe(null, 0, "g9"), null, "a step planned elsewhere has no input to redo from");

console.log("studio-orders.check: video cap, brief and redo input ok");
