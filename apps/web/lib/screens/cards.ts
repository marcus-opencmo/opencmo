/**
 * An `approvals` row → the `ApprovalCard` contract. Built from the row's snapshot only: the card shows exactly
 * what the founder approves (the snapshot the hash covers), never a newer version of the source row.
 *
 * Pure (no server-only): `screens.check.ts` runs it on sample rows.
 */

import { profileIdOf, profileOf } from "../cmo/platforms";

import {
  FinishedVideoSnapshotSchema,
  PriceSnapshotSchema,
  ScheduleSnapshotSchema,
  ScriptSnapshotSchema,
  ShortsBatchSnapshotSchema,
  SlideshowSnapshotSchema,
  type ApprovalCard,
  type Caption,
  type CardKind,
} from "./approval-card";
import type { Department, ScorePart } from "./common";

/** The columns of `approvals` the app reads (RLS: the founder's own). */
export const APPROVAL_COLUMNS =
  "id, kind, department, ref_kind, ref_id, status, snapshot, content_hash, price_credits, post_at, account, expires_at, created_at, decided_at, decided_via";

export type ApprovalRow = {
  id: string;
  kind: CardKind;
  department: Department;
  ref_kind: "content_item" | "opportunity" | "goal" | "correction" | "studio_step" | "editor_project" | "short_batch" | "schedule_slot";
  ref_id: string;
  status: ApprovalCard["status"];
  snapshot: Record<string, unknown>;
  content_hash: string;
  price_credits: number | null;
  post_at: string | null;
  account: string | null;
  expires_at: string | null;
  created_at: string;
  decided_at: string | null;
  decided_via: ApprovalCard["decidedVia"];
};

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Supabase returns `timestamptz` as `2026-10-29T03:42:00.123+00:00`; the contract wants a valid ISO offset. */
const ts = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);

function firstSentence(text: string): { head: string; rest: string } {
  const m = /^(.+?[.!?])(\s+|$)/.exec(text);
  if (!m || m[1]!.length > 200) return { head: clip(text, 200), rest: "" };
  return { head: m[1]!, rest: text.slice(m[0].length).trim() };
}

type Built = Pick<ApprovalCard, "title" | "summary" | "meta" | "body">;

const PLATFORM_NAME = { x: "X", threads: "Threads", linkedin: "LinkedIn", tiktok: "TikTok", youtube: "YouTube", instagram: "Instagram" } as const;

type CaptionRow = { caption_id: string; clip_id: string; profile: string; text: string; title: string | null };

/** The captions of one edit, in `platforms.json` order (the snapshot orders them the same way). */
function captionsOf(rows: CaptionRow[] | undefined, clipId: string | null): Caption[] {
  if (!rows || !clipId) return [];
  return rows.filter((c) => c.clip_id === clipId).map((c) => ({ id: c.caption_id, profile: c.profile, text: c.text, title: c.title }));
}

function build(row: ApprovalRow): Built | null {
  const s = row.snapshot;
  switch (row.kind) {
    case "post": {
      // The calendar writes labels ("X", "LinkedIn"); a label without a post profile was planned for X, as SQL's
      // `cmo_decide_post` decides it (every post before P3 was for X).
      const named = profileOf(profileIdOf(str(s.platform)) ?? "x");
      const profile = named && named.kind === "post" ? named : profileOf("x");
      if (!profile) return null;
      const text = str(s.text);
      const versions = [text, ...strings(s.alternates)].filter(Boolean).slice(0, 3);
      // An X thread (P6 W4): SQL emits it only when it is valid (5 to 8 posts, the first being `text`).
      const thread = strings(s.thread);
      const { head, rest } = firstSentence(text);
      return {
        title: head || clip(str(s.idea), 200),
        summary: clip(rest || str(s.rationale) || text, 400),
        meta: `${versions.length} ${versions.length === 1 ? "version" : "versions"} · ${profile.label} · you post it on your account`,
        body: {
          kind: "post",
          platforms: [
            {
              platform: profile.platform,
              versions: versions.length ? versions : [str(s.idea)],
              limit: profile.limit,
              visibleBeforeMore: profile.visibleBeforeMore,
              ...(thread.length >= 5 && thread.length <= 8 && thread[0] === text ? { thread } : {}),
            },
          ],
          checks: [],
          why: str(s.rationale) || null,
        },
      };
    }
    case "reply": {
      const parts = (Array.isArray(s.score_parts) ? s.score_parts : []) as Partial<ScorePart & { evidence: string }>[];
      const valid = parts.filter((p) => typeof p.label === "string" && typeof p.score === "number" && typeof p.max === "number" && p.max > 0);
      const quotes = valid.filter((p) => typeof p.evidence === "string" && p.evidence).map((p) => ({ text: clip(p.evidence!, 400), from: p.label!.toLowerCase() }));
      const hn = s.platform === "hn";
      const community = str(s.community) || (hn ? "Hacker News" : "Reddit");
      const score = typeof s.score === "number" ? Math.round(s.score) : 0;
      return {
        title: clip(`${community} · “${str(s.title)}”`, 300),
        summary: clip(quotes[0] ? `“${quotes[0].text}” Reply drafted, help first.` : "Reply drafted, help first.", 400),
        meta: `Score ${score} · you post it yourself`,
        body: {
          kind: "reply",
          community,
          threadTitle: clip(str(s.title), 300),
          threadUrl: str(s.url),
          score,
          parts: valid.map((p) => ({ label: p.label!, score: p.score!, max: p.max! })),
          quotes,
          draft: str(s.reply),
          rules: "you post it yourself",
          ...(hn ? { platform: "hn" as const } : {}),
          ...(s.rule === "mention_ok" || s.rule === "help_only"
            ? { rule: { kind: s.rule === "mention_ok" ? ("mention_allowed" as const) : ("help_only" as const), text: clip(str(s.rule_why), 200) } }
            : {}),
        },
      };
    }
    case "goal": {
      const metric = str(s.metric);
      if (metric !== "posts" && metric !== "replies" && metric !== "views") return null;
      const target = typeof s.target === "number" ? s.target : 1;
      return {
        title: clip(str(s.goal), 300),
        summary: `This week's goal: ${target} ${metric}. Approving it lets the plan aim at it.`,
        meta: `Week of ${str(s.week)}`,
        body: { kind: "goal", goalId: row.ref_id, week: str(s.week), goal: clip(str(s.goal), 200), metric, target, plan: [], budgetCredits: null },
      };
    }
    case "correction": {
      const edits = (Array.isArray(s.source_edits) ? s.source_edits : []) as { before?: unknown; after?: unknown }[];
      const examples = edits
        .filter((e) => typeof e.before === "string" && typeof e.after === "string")
        .map((e) => ({ before: clip(e.before as string, 300), after: clip(e.after as string, 300) }));
      const times = typeof s.times === "number" && Number.isInteger(s.times) && s.times >= 0 ? s.times : examples.length;
      return {
        title: clip(`“${str(s.rule)}”`, 300),
        summary: times ? `Learned from ${times} of your edits.` : "Learned from your edits and skip reasons.",
        meta: "Keep it and every draft follows it",
        // The card shows two examples; the rule itself says what repeats.
        body: { kind: "correction", correctionId: row.ref_id, rule: str(s.rule), editMode: str(s.edit_mode) || null, times, examples: examples.slice(0, 2) },
      };
    }
    // Studio (P2): the snapshot holds paths, never URLs; the screen loader signs them (`signStudioCard`), so a card built
    // here shows no pictures yet. A snapshot that does not parse is not shown rather than shown wrong.
    case "script": {
      const parsed = ScriptSnapshotSchema.safeParse(s);
      if (!parsed.success || parsed.data.beats.length === 0) return null;
      const v = parsed.data;
      return {
        title: clip(`Script for “${v.title}” · ${v.beats.length} ${v.beats.length === 1 ? "beat" : "beats"}`, 300),
        summary: "Approve the words and pictures; the keyframes are made next at the price below.",
        meta: "Nothing spent until you approve",
        body: { kind: "script", stepId: v.step_id, seconds: v.seconds, aspect: v.aspect, beats: v.beats, nextPriceCredits: v.price_credits },
      };
    }
    case "price": {
      const parsed = PriceSnapshotSchema.safeParse(s);
      if (!parsed.success || parsed.data.seconds === null) return null;
      const v = parsed.data;
      const shots = v.shots === 1 ? "1 shot" : `${v.shots} shots`;
      return {
        title: clip(`${v.title} · ${Math.round(v.seconds!)} s`, 300),
        summary: clip(`${v.what || shots}.${v.wait_minutes ? ` Ready in about ${v.wait_minutes} minutes.` : ""}`, 400),
        meta: v.keyframes.length ? "Redo any keyframe before you approve · credits held until the video is done" : "Credits held until the video is done",
        body: {
          kind: "price",
          stepId: v.step_id,
          what: v.what,
          keyframes: v.keyframes.map((k) => ({ index: k.index, label: k.words, thumbUrl: null, garbled: k.garbled, credits: k.credits })),
          shots: v.shots,
          seconds: v.seconds!,
          readyInMinutes: v.wait_minutes,
        },
      };
    }
    case "finished_video": {
      const parsed = FinishedVideoSnapshotSchema.safeParse(s);
      if (!parsed.success || parsed.data.seconds === null) return null;
      const v = parsed.data;
      return {
        title: clip(`“${v.title || "Your video"}” is rendered · ${Math.floor(v.seconds! / 60)}:${String(Math.round(v.seconds!) % 60).padStart(2, "0")}`, 300),
        summary: "Approving marks it finished: shorts can be cut from it.",
        meta: "Open it in the editor to tweak first",
        body: {
          kind: "finished_video",
          clipId: v.clip_id,
          documentHash: v.document_hash,
          seconds: v.seconds!,
          previewUrl: null,
          frameAt: Math.min(2, v.seconds! / 2),
          captions: captionsOf(v.captions, v.clip_id),
          ...(v.look?.note ? { lookNote: v.look.note } : {}),
        },
      };
    }
    case "shorts_batch": {
      const parsed = ShortsBatchSnapshotSchema.safeParse(s);
      if (!parsed.success || parsed.data.shorts.length === 0) return null;
      const v = parsed.data;
      return {
        title: clip(`${v.shorts.length} ${v.shorts.length === 1 ? "short" : "shorts"} from “${v.title || "your video"}”`, 300),
        summary: clip(`Hooks: ${v.shorts.map((x) => x.hook).join(" · ")}.`, 400),
        meta: "Cut from a finished edit · no generation credits",
        body: {
          kind: "shorts_batch",
          batchId: v.batch_id,
          parentClipId: v.parent_clip_id,
          source: v.title,
          shorts: v.shorts.map((x) => ({
            shortClipId: x.short_clip_id,
            start: x.start,
            end: x.end,
            hook: x.hook,
            reason: x.reason,
            previewUrl: null,
            captions: captionsOf(v.captions, x.short_clip_id),
          })),
          ...(v.look?.note ? { lookNote: v.look.note } : {}),
        },
      };
    }
    case "slideshow": {
      const parsed = SlideshowSnapshotSchema.safeParse(s);
      if (!parsed.success) return null;
      const v = parsed.data;
      const n = v.slides.length;
      return {
        title: clip(`${v.title || v.slides[0].text} · ${n} ${n === 1 ? "slide" : "slides"}`, 300),
        summary: "An MP4 and a PNG set from one document. Edit a slide's text here or open it in Slides.",
        meta: "No generation credits",
        body: {
          kind: "slideshow",
          stepId: v.step_id,
          clipId: v.clip_id,
          documentHash: v.document_hash,
          aspect: v.aspect,
          slides: v.slides.map((x) => ({ text: x.text, stillUrl: null, seconds: x.seconds })),
          previewUrl: null,
          pngSetUrl: null,
          captions: captionsOf(v.captions, v.clip_id),
          ...(v.look?.note ? { lookNote: v.look.note } : {}),
        },
      };
    }
    case "schedule": {
      const parsed = ScheduleSnapshotSchema.safeParse(s);
      if (!parsed.success) return null;
      const v = parsed.data;
      const where = PLATFORM_NAME[v.platform];
      const what = v.deliverable_kind === "post" ? firstSentence(v.text ?? "").head || "Your post" : v.title || firstSentence(v.text ?? "").head || "Your short";
      return {
        title: clip(`${what} · ${where}${v.handle ? ` ${v.handle}` : ""}`, 300),
        summary: v.last_error
          ? `It did not go out: ${v.last_error}`
          : v.mode === "publish"
            ? "You approve when it posts: at this time, on your account. Changing the time or account asks you again."
            : `No ${where} account connected: at this time you copy it and post it yourself.`,
        meta: v.mode === "publish" ? `Posts from ${v.handle ?? where}` : "Copy and open",
        body: {
          kind: "schedule",
          slotId: v.slot_id,
          what: clip(what, 200),
          where: { platform: v.platform, handle: v.handle ?? "" },
          accountId: v.account_id,
          avatarUrl: null,
          mode: v.mode,
          at: new Date(v.publish_at).toISOString(),
          // The founder's timezone, the avatar, the video and TikTok's creator info are added on the server
          // (`schedule-enrich.ts`): none of them is part of what the card approves.
          timezone: "UTC",
          why: null,
          preview: { text: v.text, title: v.title, videoUrl: null },
          options: v.options,
          tiktok: null,
          lastError: v.last_error,
          // Read from the slot on the server (`schedule-enrich.ts`): a missed card and a failed one share a snapshot
          // shape, so nothing is guessed here. Every route and loader that builds cards enriches them.
          state: "waiting",
          publishedUrl: null,
        },
      };
    }
    default:
      // Slideshow cards arrive with their phase; until then a row of that kind is not shown.
      return null;
  }
}

export function approvalToCard(row: ApprovalRow, now = new Date()): ApprovalCard | null {
  const built = build(row);
  if (!built) return null;
  const expired = row.status === "expired" || (row.status === "waiting" && row.expires_at !== null && new Date(row.expires_at) <= now);
  const elsewhere = row.status !== "waiting" && !expired && row.decided_via !== null && row.decided_via !== "app";
  return {
    id: row.id,
    kind: row.kind,
    department: row.department,
    status: row.status,
    ...built,
    priceCredits: row.price_credits,
    postAt: ts(row.post_at),
    account: built.body.kind === "schedule" ? built.body.where : null,
    raisedAt: ts(row.created_at)!,
    expiresAt: ts(row.expires_at),
    decidedAt: ts(row.decided_at),
    decidedVia: row.decided_via,
    contentHash: row.content_hash,
    problem: expired
      ? { kind: "expired", text: "This card expired. A new one will ask again." }
      : elsewhere
        ? { kind: "decided_elsewhere", text: row.decided_via === "mcp" ? "You decided this through your Claude." : "You decided this on another device." }
        : null,
  };
}
