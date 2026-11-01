/**
 * The `publish_post` order (P4 B3, `schedule-publish.md` §4 adapter mode): one fired slot goes out on the founder's
 * own account through the publish adapter, exactly as the schedule card was approved, once.
 *
 * Re-entrant like Studio's orders: the runner calls `runPublishPost` each time the order is due, and each call
 * reads the slot again and takes the next step.
 *
 *   publishing, text post                 → re-check → publish                              → published | accepted | failed
 *   publishing, video, no upload yet      → re-check → presign + queue `publish_media`      → waiting
 *   publishing, video, upload running     →                                                 → waiting
 *   publishing, video, upload done        → re-check → publish with Zernio's public URL     → published | accepted | failed
 *   no connected account (intent mode)    →                                                 → intent (copy and open card)
 *
 * The re-check runs right before every call that could post: the slot must still be the one being published,
 * its card approved, and the content, account, time and platform fields the same as the founder approved
 * (`approval.md` rule 1). Anything else refuses the slot; it never posts a version nobody approved.
 *
 * The database side (reading the slot, queuing the upload, `publish_status`) is A2's; this module takes it as
 * `PublishPostDeps` so the rules are checked without a database (`publish-post.check.ts`).
 */

import { ScheduleOptionsSchema, type ScheduleOptions, type ScheduleSnapshot } from "@/lib/screens/approval-card";
import {
  PlatformFieldsSchema,
  PublishError,
  isPublishPlatform,
  type PlatformFields,
  type PresignedMedia,
  type PublishAdapter,
  type PublishDeliverable,
  type PublishErrorInfo,
  type PublishResult,
  type PublishSlot,
} from "@/lib/departments/publish/types";

/** The slot as the runner reads it (`schedule_slots` + its account + its approval). */
export type FiredSlot = {
  id: string;
  status: string;
  platform: string;
  mode: "publish" | "intent";
  accountId: string | null;
  /** `social_accounts.zernio_account_id` and status of the slot's account, when it has one. */
  zernioAccountId: string | null;
  accountStatus: "connected" | "disconnected" | "error" | null;
  publishAt: string;
  windowEndsAt: string;
  options: ScheduleOptions;
  idempotencyKey: string;
  approvalStatus: string | null;
  /** The approved card's snapshot. */
  snapshot: ScheduleSnapshot | null;
  /** `schedule_content(deliverable, platform)` now: what would go out if posted this second. */
  current: { content_hash: string; text: string | null; title: string | null; clip_id: string | null; image?: ScheduleSnapshot["image"]; thread?: string[] } | null;
};

/** The finished export of the slot's edit at the approved document, if one is rendered. */
export type ExportFile = { object: string; bytes: number; contentType: MediaType };

/** What goes up with a post: a video export, or a post's image (one PNG still, P5). */
export type MediaType = "video/mp4" | "image/png";

/** Where the `publish_media` upload stands for this slot. */
export type MediaUpload =
  | { state: "none" }
  | { state: "running"; startedAt: string }
  | { state: "done"; publicUrl: string; contentType: MediaType }
  | { state: "failed"; error: string };

export type PublishStatusUpdate =
  | { status: "published"; externalId: string; url: string | null }
  | { status: "publishing"; externalId: string }
  | { status: "failed"; error: PublishErrorInfo }
  | { status: "intent" };

export type PublishPostDeps = {
  adapter: PublishAdapter;
  now(): Date;
  slot(slotId: string): Promise<FiredSlot | null>;
  /** The export rendered for the approved edit (`render_document` output), or null. */
  exportFor(clipId: string, contentHash: string): Promise<ExportFile | null>;
  media(slotId: string): Promise<MediaUpload>;
  /** Queues `publish_media` for this slot with the presigned URL; returns the task id. */
  startMedia(slotId: string, file: ExportFile, presigned: PresignedMedia): Promise<string>;
  /** A2's `publish_status(slot_id, status, external_id, url, error)`. */
  status(slotId: string, update: PublishStatusUpdate): Promise<void>;
};

export type PublishPostOutcome =
  | { kind: "done"; status: "published" | "accepted" | "failed" | "intent" }
  | { kind: "waiting"; text: string }
  | { kind: "skipped"; reason: string };

/** An upload stuck this long is retried with a new presigned URL (Zernio's lasts one hour). */
const UPLOAD_STALE_MS = 45 * 60 * 1000;

const fail = (code: PublishErrorInfo["code"], message: string, retryable = false): PublishStatusUpdate => ({ status: "failed", error: { code, message, retryable } });

const sameOptions = (a: ScheduleOptions, b: ScheduleOptions) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));

/** The card's fields → the adapter's. TikTok's must all be there: no default for a field the founder did not see. */
export function platformFields(platform: PublishSlot["platform"], options: ScheduleOptions): PlatformFields {
  const o = ScheduleOptionsSchema.parse(options);
  const aiGenerated = o.ai_label === true;
  if (platform === "tiktok") {
    return PlatformFieldsSchema.parse({
      platform,
      privacy: o.privacy,
      allowComment: o.allow_comment,
      allowDuet: o.allow_duet ?? null,
      allowStitch: o.allow_stitch ?? null,
      brandOrganic: o.brand_organic ?? false,
      brandContent: o.brand_content ?? false,
      aiGenerated,
    });
  }
  return { platform, aiGenerated };
}

/**
 * Why this slot may not post now, or null when it may. Compares what the founder approved (the snapshot) with
 * the slot and the content as they are this second.
 */
export function refusal(slot: FiredSlot, now: Date): PublishStatusUpdate | null {
  const s = slot.snapshot;
  if (slot.approvalStatus !== "approved" || !s) return fail("invalid", "This post was not approved for this time. Approve its schedule card again.");
  if (now.getTime() > Date.parse(slot.windowEndsAt)) return fail("invalid", "The approved time passed before it could post. Pick a new time.");
  if (!slot.current || slot.current.content_hash !== s.content_hash) {
    return fail("invalid", "The post changed after you approved it. Approve the new version.");
  }
  if (s.slot_id !== slot.id || s.platform !== slot.platform || s.account_id !== slot.accountId || wholeSeconds(s.publish_at) !== wholeSeconds(slot.publishAt)) {
    return fail("invalid", "The time or account changed after you approved it. Approve the new card.");
  }
  if (!sameOptions(s.options, slot.options)) return fail("invalid", "The post's settings changed after you approved them. Approve the new card.");
  return null;
}

/** The snapshot keeps the time to the second; the slot keeps whatever it was given. */
const wholeSeconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** The approved content → the adapter's deliverable and slot. */
export function adapterInput(slot: FiredSlot, mediaUrl: string | null, mediaType: MediaType = "video/mp4"): { deliverable: PublishDeliverable; slot: PublishSlot } {
  const s = slot.snapshot!;
  if (!isPublishPlatform(slot.platform)) throw new PublishError("invalid", "This platform cannot be posted to.", false);
  return {
    deliverable: {
      id: s.deliverable_id,
      kind: s.deliverable_kind,
      text: slot.current?.text ?? "",
      title: slot.platform === "youtube" ? (slot.current?.title ?? null) : null,
      media: mediaUrl ? [{ url: mediaUrl, contentType: mediaType }] : [],
      // P6 W4: a thread is in the approved content's hash (`schedule_content`), so it goes out as approved.
      ...(slot.platform === "x" && slot.current?.thread?.length ? { thread: slot.current.thread } : {}),
    },
    slot: {
      id: slot.id,
      platform: slot.platform,
      zernioAccountId: slot.zernioAccountId!,
      idempotencyKey: slot.idempotencyKey,
      publishAt: new Date(slot.publishAt).toISOString(),
      fields: platformFields(slot.platform, slot.options),
    },
  };
}

function resultUpdate(result: PublishResult): PublishStatusUpdate {
  if (result.status === "published") return { status: "published", externalId: result.externalId, url: result.url };
  if (result.status === "accepted") return { status: "publishing", externalId: result.externalId };
  return { status: "failed", error: result.error };
}

export async function runPublishPost(deps: PublishPostDeps, slotId: string): Promise<PublishPostOutcome> {
  const first = await deps.slot(slotId);
  // Only a slot A2's claim moved to `publishing` is ours; a cancelled, paused or already settled slot is left alone.
  if (!first || first.status !== "publishing") return { kind: "skipped", reason: first ? `slot is ${first.status}` : "slot not found" };
  let slot: FiredSlot = first;

  const settle = async (update: PublishStatusUpdate, status: Extract<PublishPostOutcome, { kind: "done" }>["status"]): Promise<PublishPostOutcome> => {
    await deps.status(slot.id, update);
    return { kind: "done", status };
  };

  const refused = refusal(slot, deps.now());
  if (refused) return settle(refused, "failed");

  if (slot.mode === "intent" || !slot.accountId || !slot.zernioAccountId) return settle({ status: "intent" }, "intent");
  if (slot.accountStatus !== "connected") {
    return settle(fail("not_found", "The account for this post is no longer connected. Connect it again in Settings, then retry."), "failed");
  }

  const clipId = slot.snapshot!.clip_id;
  // A post's image goes up the same way as a video, as the approved card's still (P5 F12).
  const image = clipId ? undefined : slot.snapshot!.image;
  const what = image ? "image" : "video";
  let mediaUrl: string | null = null;
  let mediaType: MediaType = "video/mp4";
  if (clipId || image) {
    const upload = await deps.media(slot.id);
    if (upload.state === "failed") return settle(fail("unavailable", upload.error, true), "failed");
    if (upload.state === "running" && deps.now().getTime() - Date.parse(upload.startedAt) < UPLOAD_STALE_MS) {
      return { kind: "waiting", text: `Uploading the ${what}` };
    }
    if (upload.state !== "done") {
      const file = await deps.exportFor(clipId ?? image!.clip_id, slot.snapshot!.content_hash);
      if (!file || (image && file.object !== image.object)) {
        return settle(
          fail("invalid", image ? "The approved image is not ready. Open its post card and approve it again." : "The approved video has no finished export. Export it, then retry."),
          "failed",
        );
      }
      try {
        const ext = file.contentType === "image/png" ? "png" : "mp4";
        const presigned = await deps.adapter.presignMedia({ filename: `${slot.id}.${ext}`, contentType: file.contentType, bytes: file.bytes });
        await deps.startMedia(slot.id, file, presigned);
      } catch (error) {
        if (error instanceof PublishError) return settle({ status: "failed", error: error.info() }, "failed");
        throw error;
      }
      return { kind: "waiting", text: `Uploading the ${what}` };
    }
    mediaUrl = upload.publicUrl;
    mediaType = upload.contentType;
    // The upload took a while: check again that nothing changed before the post goes out.
    const again = await deps.slot(slot.id);
    if (!again || again.status !== "publishing") return { kind: "skipped", reason: again ? `slot is ${again.status}` : "slot not found" };
    const late = refusal(again, deps.now());
    if (late) return settle(late, "failed");
    slot = again;
  }

  let input: ReturnType<typeof adapterInput>;
  try {
    input = adapterInput(slot, mediaUrl, mediaType);
  } catch {
    // A card without a field the platform requires (TikTok's privacy or comment toggle) never gets a default.
    return settle(fail("invalid", "This post is missing a setting the platform needs. Open its card and approve it again."), "failed");
  }
  let result: PublishResult;
  try {
    result = await deps.adapter.publish(input.deliverable, input.slot);
  } catch (error) {
    // The slot is `publishing`: anything that is not an answer from the platform settles it, so it never sits there
    // until it reads "unconfirmed" for a post that was never sent.
    console.error("[publish] adapter threw", error instanceof Error ? error.message : error);
    return settle(fail("unavailable", "Something went wrong before it was sent. Retry posts it again.", true), "failed");
  }
  return settle(resultUpdate(result), result.status === "published" ? "published" : result.status === "accepted" ? "accepted" : "failed");
}
