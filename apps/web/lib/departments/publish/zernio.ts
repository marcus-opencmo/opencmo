/**
 * The Zernio client behind the publish adapter (P4 B1). Shapes follow Zernio's OpenAPI (`zernio.com/openapi.json`,
 * v1.420): profiles, the connect link, accounts, TikTok creator info and posts. We post with `publishNow` at the
 * time the founder approved; Zernio's own scheduler and queue are never used.
 *
 * The key is `ZERNIO_API_KEY` and goes to Zernio only. Founder tokens stay with Zernio; we keep its ids.
 * Every call has a timeout. A call that is safe to repeat (a read, a delete, or a write with an
 * `Idempotency-Key`) gets one retry on a 5xx or a dropped connection; nothing else is retried here.
 */

import { createHash, randomUUID } from "node:crypto";

import { PLATFORM_LABEL } from "@/lib/screens/common";

import {
  PublishDeliverableSchema,
  PublishError,
  PublishSlotSchema,
  TIKTOK_PRIVACY,
  type ConnectedAccount,
  type CreatorInfo,
  type PublishAdapter,
  type PublishDeliverable,
  type PublishPlatform,
  type PublishResult,
  type PublishSlot,
  type TikTokPrivacy,
} from "./types";

export const ZERNIO_BASE_URL = "https://zernio.com/api/v1";
const TIMEOUT_MS = 20_000;
/** `publishNow` uploads the video to the platform before answering: give it longer. */
const PUBLISH_TIMEOUT_MS = 120_000;
/** The worker refuses anything larger (`publish_media_task.MAX_BYTES`); Zernio's own cap is 5 GB. */
const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;

/** Zernio names X `twitter`; every other platform keeps our id. */
const SLUG: Record<PublishPlatform, string> = { x: "twitter", threads: "threads", linkedin: "linkedin", tiktok: "tiktok", youtube: "youtube", instagram: "instagram" };
const FROM_SLUG = new Map(Object.entries(SLUG).map(([ours, theirs]) => [theirs, ours as PublishPlatform]));

export const zernioSlug = (p: PublishPlatform) => SLUG[p];
export const fromZernioSlug = (slug: string): PublishPlatform | null => FROM_SLUG.get(slug) ?? null;

type Fetch = typeof fetch;
export type ZernioOptions = { apiKey: string; baseUrl?: string; fetch?: Fetch; timeoutMs?: number };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** A platform's own words for a refusal, kept short and plain before they reach a card. */
export function platformReason(raw: unknown): string | null {
  const text = str(raw)?.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** Zernio's answer → a typed error with an English message the founder's card can show. */
export function zernioError(status: number, body: unknown, what: string): PublishError {
  const b = obj(body);
  const code = str(b.code) ?? "";
  if (status === 401) {
    return code === "reconnect_required"
      ? new PublishError("auth", `The account needs reconnecting before ${what}. Reconnect it in Settings.`, false)
      : new PublishError("not_configured", "Posting is not set up correctly. Nothing was sent.", false);
  }
  if (status === 402) return new PublishError("not_configured", "Posting is paused on our side. Nothing was sent.", false);
  if (status === 403) {
    if (code === "ACCOUNT_DISCONNECTED" || code === "ACCOUNT_NOT_ENABLED_FOR_POSTING") {
      return new PublishError("not_found", "This account is no longer connected. Connect it again in Settings.", false);
    }
    return new PublishError("auth", `This account cannot be used for ${what}. Reconnect it in Settings.`, false);
  }
  if (status === 404) return new PublishError("not_found", "This account is no longer connected. Connect it again in Settings.", false);
  if (status === 409 && code === "idempotency_conflict") return new PublishError("unavailable", "The same post is still being sent. Check again in a minute.", true);
  if (status === 409) return new PublishError("invalid", "The same post went out in the last 24 hours, so it was not sent again.", false);
  if (status === 429) return new PublishError("rate_limited", "The platform's posting limit was reached. Try a later time.", true);
  if (status === 400 || status === 422) {
    const reason = platformReason(b.error ?? b.message);
    return new PublishError("invalid", reason ? `The post was refused: ${reason}` : "The post was refused. Edit it and approve it again.", false);
  }
  return new PublishError("unavailable", "The posting service did not answer. Try again in a few minutes.", true);
}

/**
 * TikTok's commercial content disclosure as Zernio takes it: one type, and both flags when the founder disclosed both
 * (Zernio's TikTok platform data: `commercialContentType`, `isBrandOrganicPost`, `brandPartnerPromote`).
 */
function commercialContent(organic: boolean, branded: boolean): Json {
  if (organic && branded) return { commercialContentType: "brand_content", isBrandOrganicPost: true, brandPartnerPromote: true };
  if (branded) return { commercialContentType: "brand_content" };
  if (organic) return { commercialContentType: "brand_organic" };
  return { commercialContentType: "none" };
}

/** TikTok and YouTube take the founder's approved fields; the AI label goes where the platform has one. */
export function platformData(deliverable: PublishDeliverable, slot: PublishSlot): Json | undefined {
  const f = slot.fields;
  if (f.platform === "tiktok") {
    return {
      privacyLevel: f.privacy,
      allowComment: f.allowComment,
      ...(f.allowDuet !== null ? { allowDuet: f.allowDuet } : {}),
      ...(f.allowStitch !== null ? { allowStitch: f.allowStitch } : {}),
      videoMadeWithAi: f.aiGenerated,
      ...commercialContent(f.brandOrganic, f.brandContent),
      // The founder saw the content, the account and these settings on the schedule card and approved them.
      contentPreviewConfirmed: true,
      expressConsentGiven: true,
    };
  }
  if (f.platform === "youtube") {
    return { ...(deliverable.title ? { title: deliverable.title } : {}), containsSyntheticMedia: f.aiGenerated };
  }
  return undefined;
}

/** The body of `POST /v1/posts` for one slot. `metadata.opencmoSlotId` comes back on every webhook. */
export function postBody(deliverable: PublishDeliverable, slot: PublishSlot): Json {
  const media = deliverable.media.map((m) => ({ url: m.url, type: m.contentType.startsWith("video/") ? "video" : "image" }));
  // An X thread (P6 W4): Zernio chains `threadItems` as replies, item 0 the root; the top-level content is then only
  // for display and search, so the media goes on the root post, once.
  if (deliverable.thread && slot.platform === "x") {
    return {
      content: deliverable.text,
      platforms: [{
        platform: SLUG[slot.platform],
        accountId: slot.zernioAccountId,
        platformSpecificData: { threadItems: deliverable.thread.map((content, i) => ({ content, ...(i === 0 && media.length ? { mediaItems: media } : {}) })) },
      }],
      publishNow: true,
      metadata: { opencmoSlotId: slot.id, opencmoDeliverableId: deliverable.id },
    };
  }
  const data = platformData(deliverable, slot);
  return {
    ...(deliverable.text.trim() ? { content: deliverable.text } : {}),
    mediaItems: media,
    platforms: [{ platform: SLUG[slot.platform], accountId: slot.zernioAccountId, ...(data ? { platformSpecificData: data } : {}) }],
    publishNow: true,
    metadata: { opencmoSlotId: slot.id, opencmoDeliverableId: deliverable.id },
  };
}

/** `post.platforms[]` for our account → the adapter's result. Pending states wait for the webhook. */
export function postResult(body: unknown, slot: PublishSlot): PublishResult {
  const post = obj(obj(body).post);
  const postId = str(post._id) ?? str(post.id);
  const platforms = Array.isArray(post.platforms) ? post.platforms.map(obj) : [];
  const target = platforms.find((p) => str(p.accountId) === slot.zernioAccountId || str(obj(p.accountId)._id) === slot.zernioAccountId) ?? platforms[0] ?? {};
  const status = str(target.status) ?? str(post.status) ?? "";
  if (status === "published" && postId) {
    const url = str(target.platformPostUrl) ?? str(target.publishedUrl);
    return { status: "published", externalId: str(target.platformPostId) ?? postId, url: url && url.startsWith("https://") ? url : null, error: null };
  }
  if ((status === "failed" || status === "cancelled") || !postId) {
    const reason = platformReason(target.errorMessage ?? target.error);
    return {
      status: "failed",
      externalId: null,
      url: null,
      error: {
        code: "invalid",
        message: reason ? `${PLATFORM_LABEL[slot.platform]} refused the post: ${reason}` : `${PLATFORM_LABEL[slot.platform]} refused the post.`,
        retryable: false,
      },
    };
  }
  // pending, processing, uploading, scheduled (Zernio retries a transient error itself): the webhook confirms.
  return { status: "accepted", externalId: postId, url: null, error: null };
}

export function createZernioAdapter(options: ZernioOptions): PublishAdapter {
  const base = (options.baseUrl ?? ZERNIO_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  async function call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    what: string,
    init: { body?: Json; idempotencyKey?: string; timeoutMs?: number; okStatuses?: number[] } = {},
  ): Promise<{ status: number; body: unknown }> {
    const repeatable = method !== "POST" || Boolean(init.idempotencyKey);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            Accept: "application/json",
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
          },
          body: init.body ? JSON.stringify(init.body) : undefined,
          redirect: "error",
          signal: AbortSignal.timeout(init.timeoutMs ?? timeoutMs),
        });
      } catch {
        if (repeatable && attempt === 0) continue;
        throw new PublishError("unavailable", "The posting service did not answer. Try again in a few minutes.", true);
      }
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (res.status >= 500 && repeatable && attempt === 0) continue;
      if (res.ok || init.okStatuses?.includes(res.status)) return { status: res.status, body };
      throw zernioError(res.status, body, what);
    }
  }

  return {
    name: "zernio",

    async createProfile(userId) {
      // One profile per founder, found again by our user id: a retried connect never makes a second one.
      const externalId = `opencmo:${userId}`;
      const found = await call("GET", `/profiles?externalId=${encodeURIComponent(externalId)}`, "connecting");
      // Matched again here, not trusted to the query filter: a profile of another founder is never taken.
      const existing = (Array.isArray(obj(found.body).profiles) ? (obj(found.body).profiles as unknown[]) : [])
        .map(obj)
        .find((p) => str(p._id) && str(p.externalId) === externalId);
      if (existing) return { zernioProfileId: str(existing._id)! };
      const name = `opencmo-${createHash("sha256").update(userId).digest("hex").slice(0, 16)}`;
      const made = await call("POST", "/profiles", "connecting", { body: { name, externalId }, idempotencyKey: `profile:${userId}`, okStatuses: [409] });
      const b = obj(made.body);
      const id = made.status === 409 ? str(obj(b.details).existingProfileId) : str(obj(b.profile)._id);
      if (!id) throw new PublishError("unavailable", "Your posting profile could not be made. Try connecting again.", true);
      return { zernioProfileId: id };
    },

    async connectLink(zernioProfileId, platform, returnUrl) {
      const q = new URLSearchParams({ profileId: zernioProfileId, redirect_url: returnUrl });
      const { body } = await call("GET", `/connect/${SLUG[platform]}?${q}`, "connecting");
      const url = str(obj(body).authUrl);
      if (!url || !url.startsWith("https://")) throw new PublishError("unavailable", "The connect page could not be opened. Try again.", true);
      return { url };
    },

    async accounts(zernioProfileId) {
      const { body } = await call("GET", `/accounts?profileId=${encodeURIComponent(zernioProfileId)}`, "connecting");
      const rows = Array.isArray(obj(body).accounts) ? (obj(body).accounts as unknown[]).map(obj) : [];
      const accounts: ConnectedAccount[] = [];
      for (const a of rows) {
        const platform = fromZernioSlug(str(a.platform) ?? "");
        const id = str(a._id);
        if (!platform || !id || a.isActive !== true || str(a.profileId) !== zernioProfileId) continue;
        const avatar = str(a.profilePicture);
        accounts.push({
          zernioAccountId: id,
          platform,
          handle: (str(a.username) ?? str(a.displayName) ?? PLATFORM_LABEL[platform]).slice(0, 100),
          avatarUrl: avatar && avatar.startsWith("https://") ? avatar : null,
        });
      }
      return accounts;
    },

    async disconnect(zernioAccountId) {
      // Already gone at Zernio counts as disconnected.
      await call("DELETE", `/accounts/${encodeURIComponent(zernioAccountId)}`, "disconnecting", { okStatuses: [404] });
    },

    async creatorInfo(zernioAccountId): Promise<CreatorInfo> {
      const { body } = await call("GET", `/accounts/${encodeURIComponent(zernioAccountId)}/tiktok/creator-info?mediaType=video`, "reading TikTok's options");
      const b = obj(body);
      const creator = obj(b.creator);
      const settings = obj(obj(b.postingLimits).interactionSettings);
      const enabled = (key: string): boolean | null => {
        const s = settings[key];
        return s === null || s === undefined ? null : obj(s).enabled !== false;
      };
      const privacyLevels = (Array.isArray(b.privacyLevels) ? b.privacyLevels : [])
        .map((p) => str(obj(p).value) ?? str(p))
        .filter((v): v is TikTokPrivacy => (TIKTOK_PRIVACY as readonly (string | null)[]).includes(v));
      const avatar = str(creator.avatarUrl);
      const max = obj(b.postingLimits).maxVideoDurationSec;
      return {
        nickname: (str(creator.nickname) ?? "TikTok").slice(0, 100),
        avatarUrl: avatar && avatar.startsWith("https://") ? avatar : null,
        canPostMore: creator.canPostMore !== false,
        privacyLevels,
        maxVideoSeconds: typeof max === "number" && max > 0 ? max : null,
        commentEnabled: enabled("allow_comment") !== false,
        duetEnabled: enabled("allow_duet"),
        stitchEnabled: enabled("allow_stitch"),
      };
    },

    async presignMedia(file) {
      if (!(file.bytes > 0 && file.bytes <= MAX_UPLOAD_BYTES)) throw new PublishError("invalid", "The video is too large to post.", false);
      const filename = file.filename.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-100) || "media";
      const { body } = await call("POST", "/media/presign", "uploading the video", {
        body: { filename, contentType: file.contentType, size: file.bytes },
        // Fresh per call: Zernio replays a key for 24 h, but the upload URL dies after one. The key only lets
        // this call's own retry repeat safely.
        idempotencyKey: `presign:${randomUUID()}`,
      });
      const b = obj(body);
      const uploadUrl = str(b.uploadUrl);
      const publicUrl = str(b.publicUrl);
      if (!uploadUrl?.startsWith("https://") || !publicUrl?.startsWith("https://")) {
        throw new PublishError("unavailable", "The video upload could not start. Try again in a few minutes.", true);
      }
      const expires = typeof b.expiresIn === "number" && b.expiresIn > 0 ? b.expiresIn : 3600;
      return { uploadUrl, publicUrl, expiresInSeconds: expires };
    },

    async publish(deliverable, slot) {
      // A post the platform cannot take (no text, a title too long) is a refusal on the card, not a crash that
      // leaves the slot posting until it reads "unconfirmed".
      const parsed = { d: PublishDeliverableSchema.safeParse(deliverable), s: PublishSlotSchema.safeParse(slot) };
      if (!parsed.d.success || !parsed.s.success) {
        return { status: "failed", externalId: null, url: null, error: { code: "invalid", message: NOT_POSTABLE, retryable: false } };
      }
      const [d, s] = [parsed.d.data, parsed.s.data];
      try {
        // 207 = saved but not fully published: `post.status` says which.
        const { body } = await call("POST", "/posts", "posting", { body: postBody(d, s), idempotencyKey: s.idempotencyKey, timeoutMs: PUBLISH_TIMEOUT_MS, okStatuses: [207] });
        return postResult(body, s);
      } catch (error) {
        if (error instanceof PublishError) return { status: "failed", externalId: null, url: null, error: error.info() };
        throw error;
      }
    },
  };
}

const NOT_POSTABLE = "This post is missing what the platform needs (its text or title). Edit it and approve it again.";
