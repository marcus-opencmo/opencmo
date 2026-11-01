/**
 * The publish adapter's contract (P4 B0, `docs/architecture/schedule-publish.md` §6): one way to post an
 * approved deliverable on the founder's own connected account. The `publish_post` handler, the connect
 * routes and the webhook call it; nothing else knows which adapter ran (Zernio, or the fake in tests).
 *
 * Tokens of the founder's platforms stay with Zernio: every id here is Zernio's profile or account id,
 * never a platform token. The adapter posts only the founder's own posts: no likes, follows, comments,
 * replies or DMs, one account per platform.
 */

import { z } from "zod";

import type { Platform } from "@/lib/screens/common";

/** The platforms posted through Zernio (F1's connect buttons). Reddit is never posted: Sales has no post button. */
export const PUBLISH_PLATFORMS = ["x", "threads", "linkedin", "tiktok", "youtube", "instagram"] as const satisfies readonly Platform[];
export const PublishPlatformSchema = z.enum(PUBLISH_PLATFORMS);
export type PublishPlatform = z.infer<typeof PublishPlatformSchema>;

export const isPublishPlatform = (p: string): p is PublishPlatform => (PUBLISH_PLATFORMS as readonly string[]).includes(p);

/** TikTok's privacy levels, as its creator info lists them; the card offers only the ones the account allows. */
export const TIKTOK_PRIVACY = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"] as const;
export const TikTokPrivacySchema = z.enum(TIKTOK_PRIVACY);
export type TikTokPrivacy = z.infer<typeof TikTokPrivacySchema>;

/**
 * The platform fields the founder approved on the schedule card (`schedule-publish.md` §7). TikTok's are
 * required by its rules: no default is applied for a field the founder did not see. The AI-generated label
 * is the founder's toggle, off by default (owner, 2026-10-26).
 */
export const PlatformFieldsSchema = z.discriminatedUnion("platform", [
  z
    .object({
      platform: z.literal("tiktok"),
      privacy: TikTokPrivacySchema,
      allowComment: z.boolean(),
      /** Null for a photo post: TikTok applies duet and stitch to videos only. */
      allowDuet: z.boolean().nullable(),
      allowStitch: z.boolean().nullable(),
      /** Commercial content disclosure: the founder's own business, and/or a paid partnership. */
      brandOrganic: z.boolean(),
      brandContent: z.boolean(),
      aiGenerated: z.boolean(),
    })
    .strict(),
  z.object({ platform: z.enum(["x", "threads", "linkedin", "youtube", "instagram"]), aiGenerated: z.boolean() }).strict(),
]);
export type PlatformFields = z.infer<typeof PlatformFieldsSchema>;

/** A file already uploaded by `publish_media` (Zernio's `publicUrl`): the adapter never moves bytes itself. */
export const PublishMediaSchema = z
  .object({
    url: z.url(),
    contentType: z.enum(["video/mp4", "video/quicktime", "image/jpeg", "image/png", "image/webp"]),
  })
  .strict();
export type PublishMedia = z.infer<typeof PublishMediaSchema>;

/**
 * What goes out, as approved: the handler builds it from the deliverable and checks the card's snapshot
 * hash before calling `publish`. Kinds match the schedule snapshot's `deliverable_kind`; a video, short or
 * slideshow carries its media, a `post` may not.
 */
export const PublishDeliverableSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(["post", "video", "short", "slideshow"]),
    text: z.string().max(10000),
    /** YouTube's title; null elsewhere. */
    title: z.string().min(1).max(100).nullable(),
    media: z.array(PublishMediaSchema).max(35),
    /** P6 W4: an X thread, 5–8 posts of at most 280 code points; `text` is its first post. Posted as one. */
    thread: z
      .array(z.string().min(1).refine((t) => [...t].length <= 280, "A thread post is at most 280 characters."))
      .min(5)
      .max(8)
      .optional(),
  })
  .strict()
  .refine((d) => d.kind === "post" || d.media.length > 0, { message: "A video, short or slideshow needs its media." })
  .refine((d) => !d.thread || (d.kind === "post" && d.thread[0] === d.text), { message: "A thread is a post whose first post is its text." })
  .refine((d) => d.text.trim().length > 0 || d.media.length > 0, { message: "Nothing to post." });
export type PublishDeliverable = z.infer<typeof PublishDeliverableSchema>;

/** The slot as fired (`schedule_slots`, A0): who posts where, with the key that makes a retry post once. */
export const PublishSlotSchema = z
  .object({
    id: z.uuid(),
    platform: PublishPlatformSchema,
    /** `social_accounts.zernio_account_id` of the approved account. */
    zernioAccountId: z.string().min(1).max(200),
    /** `schedule_slots.idempotency_key`: the same key never posts twice at Zernio or in the fake. */
    idempotencyKey: z.string().min(8).max(200),
    publishAt: z.iso.datetime({ offset: true }),
    fields: PlatformFieldsSchema,
  })
  .strict()
  .refine((s) => s.fields.platform === s.platform, { message: "The platform fields are for another platform." });
export type PublishSlot = z.infer<typeof PublishSlotSchema>;

/**
 * `published`: live, with its link. `accepted`: Zernio took it and the signed webhook confirms it later
 * (the slot stays `publishing`). `failed`: nothing went out; `error` says why in words for the card.
 */
export type PublishResult =
  | { status: "published"; externalId: string; url: string | null; error: null }
  | { status: "accepted"; externalId: string; url: null; error: null }
  | { status: "failed"; externalId: null; url: null; error: PublishErrorInfo };

export const PUBLISH_ERROR_CODES = [
  /** Zernio refused our key, or the founder's account needs reconnecting. */
  "auth",
  /** The account is gone or disconnected at Zernio. */
  "not_found",
  /** The post breaks a platform rule (length, media, a field). Retrying the same post fails again. */
  "invalid",
  /** Too many requests, or the platform's daily limit (TikTok's 429). */
  "rate_limited",
  /** Zernio or the platform is down, or timed out. The fallback card offers copy + open. */
  "unavailable",
  /** Posting through Zernio is not set up (no key), or the owner gates are not done. */
  "not_configured",
] as const;
export type PublishErrorCode = (typeof PUBLISH_ERROR_CODES)[number];

/** `message` is English and reaches the founder's card verbatim. */
export type PublishErrorInfo = { code: PublishErrorCode; message: string; retryable: boolean };

export class PublishError extends Error {
  readonly code: PublishErrorCode;
  readonly retryable: boolean;
  constructor(code: PublishErrorCode, message: string, retryable = code === "rate_limited" || code === "unavailable") {
    super(message);
    this.name = "PublishError";
    this.code = code;
    this.retryable = retryable;
  }
  info(): PublishErrorInfo {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

/** A connected account as Zernio reports it: what `social_accounts` stores (never a token). */
export type ConnectedAccount = {
  zernioAccountId: string;
  platform: PublishPlatform;
  handle: string;
  avatarUrl: string | null;
};

/** TikTok's creator info (`GET /v1/accounts/{id}/tiktok/creator-info`): what the schedule card may offer. */
export type CreatorInfo = {
  nickname: string;
  avatarUrl: string | null;
  /** False when TikTok's daily posting limit is reached: the card says so instead of offering a time. */
  canPostMore: boolean;
  privacyLevels: TikTokPrivacy[];
  maxVideoSeconds: number | null;
  /** False when the creator turned it off in the TikTok app: the card shows the toggle off and disabled. */
  commentEnabled: boolean;
  duetEnabled: boolean | null;
  stitchEnabled: boolean | null;
};

export type PresignedMedia = { uploadUrl: string; publicUrl: string; expiresInSeconds: number };

export interface PublishAdapter {
  /** `"zernio"` or `"fake"`: logged with each attempt, never shown as a feature. */
  readonly name: "zernio" | "fake";
  /** The founder's Zernio profile, made once (B2 stores the id through A's RPC). */
  createProfile(userId: string): Promise<{ zernioProfileId: string }>;
  /** Zernio's OAuth link for one platform; the founder returns to `returnUrl` with the new account. */
  connectLink(zernioProfileId: string, platform: PublishPlatform, returnUrl: string): Promise<{ url: string }>;
  /** The accounts connected under a profile (the callback picks the one for its platform). */
  accounts(zernioProfileId: string): Promise<ConnectedAccount[]>;
  /** Disconnects at Zernio; an account already gone counts as disconnected. */
  disconnect(zernioAccountId: string): Promise<void>;
  /** TikTok only. */
  creatorInfo(zernioAccountId: string): Promise<CreatorInfo>;
  /**
   * A one-hour upload URL for `publish_media` (the worker PUTs the bytes, never Next.js) and the public URL the
   * post then names. Uploads older than 7 days cannot be posted, so this runs at fire time.
   */
  presignMedia(file: { filename: string; contentType: PublishMedia["contentType"]; bytes: number }): Promise<PresignedMedia>;
  /**
   * Posts now (we fire at the approved time; Zernio's own scheduler is never used). Never throws for a
   * refusal: a failed post comes back as `failed` with the reason; only a bug in our input throws.
   */
  publish(deliverable: PublishDeliverable, slot: PublishSlot): Promise<PublishResult>;
}
