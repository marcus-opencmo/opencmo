/**
 * The `publish_post` order's rules with the fake Zernio and in-memory deps: posts once as approved; refuses a
 * stale card, a changed account, time or setting, a passed window, a disconnected account; falls back to copy
 * and open without an account; a video waits on its upload, re-checks, then posts with Zernio's URL.
 *
 *     cd apps/web && npx tsx lib/cmo/jobs/publish-post.check.ts
 */
import assert from "node:assert/strict";

import { createFakePublishAdapter, fakeAccountId, fakePublishCount, resetFakePublish } from "@/lib/departments/publish/fake";
import { publishDeps } from "@/lib/departments/publish/job";
import type { PublishAdapter } from "@/lib/departments/publish/types";
import type { ScheduleSnapshot } from "@/lib/screens/approval-card";

import { platformFields, runPublishPost, type FiredSlot, type MediaUpload, type PublishPostDeps, type PublishStatusUpdate } from "./publish-post";

const SLOT = "00000000-0000-4000-8000-0000000000b1";
const ACCOUNT = "00000000-0000-4000-8000-0000000000c1";
const HASH = "a".repeat(64);
const NOW = new Date("2026-11-02T09:01:00Z");

async function main() {
  resetFakePublish();
  const adapter = createFakePublishAdapter();
  const { zernioProfileId } = await adapter.createProfile("user-1");
  await adapter.connectLink(zernioProfileId, "x", "http://127.0.0.1/cb");
  await adapter.connectLink(zernioProfileId, "tiktok", "http://127.0.0.1/cb");

  const snapshot = (over: Partial<ScheduleSnapshot> = {}): ScheduleSnapshot => ({
    kind: "schedule",
    slot_id: SLOT,
    deliverable_id: "00000000-0000-4000-8000-0000000000a1",
    deliverable_kind: "post",
    platform: "x",
    mode: "publish",
    account_id: ACCOUNT,
    handle: "fake_x",
    publish_at: "2026-11-02T09:00:00Z",
    options: { ai_label: false },
    last_error: null,
    clip_id: null,
    text: "Shipped captions today.",
    title: null,
    content_hash: HASH,
    ...over,
  });
  const fired = (over: Partial<FiredSlot> = {}): FiredSlot => ({
    id: SLOT,
    status: "publishing",
    platform: "x",
    mode: "publish",
    accountId: ACCOUNT,
    zernioAccountId: fakeAccountId(zernioProfileId, "x"),
    accountStatus: "connected",
    publishAt: "2026-11-02T09:00:00+00:00",
    windowEndsAt: "2026-11-02T09:30:00Z",
    options: { ai_label: false },
    idempotencyKey: "slot-key-1",
    approvalStatus: "approved",
    snapshot: snapshot(),
    current: { content_hash: HASH, text: "Shipped captions today.", title: null, clip_id: null },
    ...over,
  });

  function deps(slots: FiredSlot[], extra: Partial<PublishPostDeps> = {}) {
    const updates: PublishStatusUpdate[] = [];
    let i = 0;
    const d: PublishPostDeps = {
      adapter,
      now: () => NOW,
      slot: async () => slots[Math.min(i++, slots.length - 1)] ?? null,
      exportFor: async () => ({ object: "u/c/t.mp4", bytes: 1234, contentType: "video/mp4" as const }),
      media: async () => ({ state: "none" }),
      startMedia: async () => "task-1",
      status: async (_id, u) => void updates.push(u),
      ...extra,
    };
    return { d, updates };
  }

  // Approved and unchanged: posts once; the same slot again gets Zernio's first answer, never a second post.
  {
    const { d, updates } = deps([fired()]);
    assert.deepEqual(await runPublishPost(d, SLOT), { kind: "done", status: "published" });
    assert.equal(updates[0]!.status, "published");
    await runPublishPost(deps([fired()]).d, SLOT);
    assert.equal(fakePublishCount(), 1);
  }

  // Refusals: nothing reaches the adapter.
  const before = fakePublishCount();
  const refusals: [string, FiredSlot][] = [
    ["not approved", fired({ approvalStatus: "superseded" })],
    ["content edited", fired({ current: { content_hash: "b".repeat(64), text: "Edited", title: null, clip_id: null } })],
    ["account changed", fired({ accountId: "00000000-0000-4000-8000-0000000000c2" })],
    ["time moved", fired({ publishAt: "2026-11-02T10:00:00Z" })],
    ["setting changed", fired({ options: { ai_label: true } })],
    ["window passed", fired({ windowEndsAt: "2026-11-02T09:00:30Z" })],
    ["other slot's card", fired({ snapshot: snapshot({ slot_id: "00000000-0000-4000-8000-0000000000b9" }) })],
    ["account disconnected", fired({ accountStatus: "disconnected" })],
  ];
  for (const [why, slot] of refusals) {
    const { d, updates } = deps([slot]);
    assert.deepEqual(await runPublishPost(d, SLOT), { kind: "done", status: "failed" }, why);
    assert.equal(updates[0]!.status, "failed", why);
  }
  assert.equal(fakePublishCount(), before, "no refused slot posted");

  // Not ours to touch: cancelled, paused or settled slots are skipped without a status change.
  for (const status of ["cancelled", "waiting", "published"]) {
    const { d, updates } = deps([fired({ status })]);
    assert.equal((await runPublishPost(d, SLOT)).kind, "skipped");
    assert.equal(updates.length, 0);
  }

  // No connected account → the copy and open card.
  {
    const { d, updates } = deps([fired({ mode: "intent", accountId: null, zernioAccountId: null, accountStatus: null, snapshot: snapshot({ mode: "intent", account_id: null }) })]);
    assert.deepEqual(await runPublishPost(d, SLOT), { kind: "done", status: "intent" });
    assert.deepEqual(updates, [{ status: "intent" }]);
  }

  // A refusal from the platform settles the slot failed with its reason.
  {
    const { d, updates } = deps([fired({ idempotencyKey: "slot-key-bad", current: { content_hash: HASH, text: "x [fake:invalid]", title: null, clip_id: null } })]);
    assert.deepEqual(await runPublishPost(d, SLOT), { kind: "done", status: "failed" });
    assert.ok(updates[0]!.status === "failed" && updates[0]!.error.message.includes("refused"));
  }

  // A video: upload first, wait, re-check, then post with Zernio's public URL and TikTok's approved fields.
  {
    const tiktok = (over: Partial<FiredSlot> = {}) =>
      fired({
        platform: "tiktok",
        zernioAccountId: fakeAccountId(zernioProfileId, "tiktok"),
        idempotencyKey: "slot-key-tt",
        options: { privacy: "SELF_ONLY", allow_comment: true, allow_duet: false, allow_stitch: false, ai_label: true },
        snapshot: snapshot({
          platform: "tiktok",
          deliverable_kind: "short",
          clip_id: "00000000-0000-4000-8000-0000000000d1",
          options: { privacy: "SELF_ONLY", allow_comment: true, allow_duet: false, allow_stitch: false, ai_label: true },
        }),
        current: { content_hash: HASH, text: "Half the editing time", title: null, clip_id: "00000000-0000-4000-8000-0000000000d1" },
        ...over,
      });
    let upload: MediaUpload = { state: "none" };
    const started: string[] = [];
    const seen: unknown[] = [];
    const watching: PublishAdapter = { ...adapter, publish: async (dl, sl) => (seen.push({ dl, sl }), adapter.publish(dl, sl)) };
    const { d, updates } = deps([tiktok()], {
      adapter: watching,
      media: async () => upload,
      startMedia: async (_s, file, presigned) => (started.push(`${file.object} → ${presigned.uploadUrl}`), "task-1"),
    });
    assert.deepEqual(await runPublishPost(d, SLOT), { kind: "waiting", text: "Uploading the video" });
    assert.equal(started.length, 1);
    upload = { state: "running", startedAt: "2026-11-02T09:00:30Z" };
    assert.equal((await runPublishPost(d, SLOT)).kind, "waiting");
    assert.equal(started.length, 1, "a running upload is not started twice");
    upload = { state: "done", publicUrl: "https://media.example.com/fake_media_1", contentType: "video/mp4" };
    assert.deepEqual(await runPublishPost(d, SLOT), { kind: "done", status: "published" });
    const call = seen[0] as { dl: { media: { url: string }[] }; sl: { fields: unknown } };
    assert.equal(call.dl.media[0]!.url, "https://media.example.com/fake_media_1");
    assert.deepEqual(call.sl.fields, { platform: "tiktok", privacy: "SELF_ONLY", allowComment: true, allowDuet: false, allowStitch: false, brandOrganic: false, brandContent: false, aiGenerated: true });
    assert.equal(updates.at(-1)!.status, "published");

    // P5 F12: a post with its image uploads the approved still as image/png, then posts it with the text.
    {
      const image = { clip_id: "00000000-0000-4000-8000-0000000000e1", object: "u/e1/t-01.png", bytes: 2048 };
      const withImage = fired({
        idempotencyKey: "slot-key-img",
        snapshot: { ...snapshot({}), image },
        current: { content_hash: HASH, text: "We shipped.", title: null, clip_id: null, image },
      });
      let up: MediaUpload = { state: "none" };
      const presigned: string[] = [];
      const posted: unknown[] = [];
      const { d: di } = deps([withImage], {
        adapter: { ...adapter, presignMedia: async (f) => (presigned.push(`${f.filename} ${f.contentType}`), adapter.presignMedia(f)), publish: async (dl, sl) => (posted.push(dl), adapter.publish(dl, sl)) },
        exportFor: async () => ({ object: image.object, bytes: 2048, contentType: "image/png" }),
        media: async () => up,
      });
      assert.deepEqual(await runPublishPost(di, SLOT), { kind: "waiting", text: "Uploading the image" });
      assert.deepEqual(presigned, [`${SLOT}.png image/png`]);
      up = { state: "done", publicUrl: "https://media.example.com/img", contentType: "image/png" };
      assert.deepEqual(await runPublishPost(di, SLOT), { kind: "done", status: "published" });
      assert.deepEqual((posted[0] as { media: unknown[] }).media, [{ url: "https://media.example.com/img", contentType: "image/png" }]);
      // A newer still than the approved one is never sent in its place.
      const { d: dj, updates: uj } = deps([fired({ idempotencyKey: "slot-key-img2", snapshot: { ...snapshot({}), image }, current: { content_hash: HASH, text: "We shipped.", title: null, clip_id: null, image } })], {
        exportFor: async () => ({ object: "u/e1/other-01.png", bytes: 1, contentType: "image/png" }),
      });
      await runPublishPost(dj, SLOT);
      assert.ok(uj[0]!.status === "failed" && uj[0]!.error.message.includes("image"));
    }

    // Edited while it uploaded: the re-check refuses it before posting.
    const { d: d2, updates: u2 } = deps([tiktok({ idempotencyKey: "slot-key-tt2" }), tiktok({ idempotencyKey: "slot-key-tt2", current: { content_hash: "c".repeat(64), text: "new", title: null, clip_id: null } })], {
      media: async () => ({ state: "done", publicUrl: "https://media.example.com/m", contentType: "video/mp4" }),
    });
    assert.deepEqual(await runPublishPost(d2, SLOT), { kind: "done", status: "failed" });
    assert.ok(u2[0]!.status === "failed" && u2[0]!.error.message.includes("changed"));

    // No finished export → failed with what to do; an upload that failed → retryable failure.
    const { d: d3, updates: u3 } = deps([tiktok({ idempotencyKey: "slot-key-tt3" })], { exportFor: async () => null });
    await runPublishPost(d3, SLOT);
    assert.ok(u3[0]!.status === "failed" && u3[0]!.error.message.includes("Export it"));
    const { d: d4, updates: u4 } = deps([tiktok({ idempotencyKey: "slot-key-tt4" })], { media: async () => ({ state: "failed", error: "Uploading the video for posting failed. Please retry." }) });
    await runPublishPost(d4, SLOT);
    assert.ok(u4[0]!.status === "failed" && u4[0]!.error.retryable);
  }

  // A TikTok card without its privacy level settles failed instead of posting with a default.
  {
    const { d, updates } = deps([
      fired({
        platform: "tiktok",
        zernioAccountId: fakeAccountId(zernioProfileId, "tiktok"),
        idempotencyKey: "slot-key-nofields",
        snapshot: snapshot({ platform: "tiktok" }),
      }),
    ]);
    assert.deepEqual(await runPublishPost(d, SLOT), { kind: "done", status: "failed" });
    assert.ok(updates[0]!.status === "failed" && updates[0]!.error.message.includes("missing a setting"));
  }

  // TikTok without every field the card must show is a bug, not a default.
  assert.throws(() => platformFields("tiktok", { ai_label: false }));
  assert.deepEqual(platformFields("x", {}), { platform: "x", aiGenerated: false });

  // A time kept with a fraction of a second still matches the snapshot's whole seconds (review #9).
  {
    const { d, updates } = deps([fired({ publishAt: "2026-11-02T09:00:00.400+00:00" })]);
    assert.deepEqual(await runPublishPost(d, SLOT), { kind: "done", status: "published" });
    assert.equal(updates[0]!.status, "published");
  }

  // An adapter that throws after the slot is posting settles it failed, never left to read "unconfirmed" (review #4).
  {
    const throwing: PublishAdapter = { ...adapter, publish: async () => { throw new Error("boom"); } };
    const { d, updates } = deps([fired({ idempotencyKey: "slot-key-throw" })], { adapter: throwing });
    assert.deepEqual(await runPublishPost(d, SLOT), { kind: "done", status: "failed" });
    assert.ok(updates[0]!.status === "failed" && updates[0]!.error.retryable);
  }

  // A refused start (changed after approval) goes on the slot's card with SQL's reason; a dropped call is retried (review #5).
  {
    const sent: { name: string; args: Record<string, unknown> }[] = [];
    let status = "due";
    const rpc = async (name: string, args: Record<string, unknown>) => {
      sent.push({ name, args });
      if (name === "publish_slot_start") return { data: null, error: { code: "P0001", message: "This post changed after it was approved." } };
      if (name === "publish_status") status = "failed";
      return { data: name === "publish_slot_read" ? { id: SLOT, status, export: null, media: { state: "none" } } : null, error: null };
    };
    const slot = await publishDeps(rpc, adapter, "user-1", "order-1").slot(SLOT);
    assert.equal(slot?.status, "failed");
    assert.deepEqual(sent.find((c) => c.name === "publish_status")!.args.p_error, { code: "invalid", message: "This post changed after it was approved.", retryable: true });
    const down = async (name: string) => ({ data: name === "publish_slot_read" ? { id: SLOT, status: "due" } : null, error: name === "publish_slot_start" ? { message: "fetch failed" } : null });
    await assert.rejects(publishDeps(down, adapter, "user-1", "order-1").slot(SLOT), /fetch failed/);
  }

  // The job's deps over A2's RPCs: every call but publish_status names the run's user and order; a `due` slot is
  // started (re-checked in SQL) before the handler sees it; status goes back in A2's argument names.
  {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let status = "due";
    const rpc = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "publish_slot_start") status = "publishing";
      if (name === "publish_slot_read") return { data: { id: SLOT, status, export: { object: "u/c/t.mp4", bytes: 9 }, media: { state: "none" } }, error: null };
      return { data: name === "publish_media_queue" ? "task-1" : null, error: null };
    };
    const deps = publishDeps(rpc, createFakePublishAdapter(), "user-1", "order-1");
    assert.equal((await deps.slot(SLOT))?.status, "publishing");
    assert.deepEqual(calls.map((c) => c.name), ["publish_slot_read", "publish_slot_start", "publish_slot_read"]);
    assert.ok(calls.every((c) => c.args.p_user === "user-1" && c.args.p_order === "order-1"));
    assert.deepEqual(await deps.exportFor("clip", "hash"), { object: "u/c/t.mp4", bytes: 9 });
    assert.equal(await deps.startMedia(SLOT, { object: "u/c/t.mp4", bytes: 9, contentType: "video/mp4" }, { uploadUrl: "https://up", publicUrl: "https://pub", expiresInSeconds: 3600 }), "task-1");
    assert.deepEqual(calls.at(-1)!.args, { p_slot: SLOT, p_object: "u/c/t.mp4", p_upload_url: "https://up", p_public_url: "https://pub", p_user: "user-1", p_order: "order-1" });
    await deps.status(SLOT, { status: "published", externalId: "ext", url: "https://x.com/p/1" });
    assert.deepEqual(calls.at(-1), { name: "publish_status", args: { p_slot: SLOT, p_status: "published", p_external_id: "ext", p_url: "https://x.com/p/1", p_error: null } });
    await deps.status(SLOT, { status: "intent" });
    assert.deepEqual(calls.at(-1)!.args, { p_slot: SLOT, p_status: "intent", p_external_id: null, p_url: null, p_error: null });
  }

  console.log("publish_post checks passed");
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
