/**
 * Writer's contract (P3 B0, `docs/architecture/writer.md` §4 and §8): one interface for every word that
 * goes out. `draft(kind, profile, brief, context)` writes a post, a caption, a YouTube title and
 * description, the video brief Studio starts from, or slide text.
 *
 * The prompt stays stable for the prompt cache: the platform profile, the founder's documents, voice notes
 * and corrections reach the model as data after the cached prefix, never inside it. No AI Slop is advice
 * in that prefix, never a code rule: code checks only facts and product rules (length, words to avoid,
 * numbers in the documents, no links and no hashtags in posts).
 */

import { z } from "zod";

import type { Documents } from "../jobs/types";
import type { PlatformProfile } from "../platforms";

export const WRITER_KINDS = ["post", "caption", "youtube", "video_brief", "slides"] as const;
export type WriterKind = (typeof WRITER_KINDS)[number];

/** A platform profile (`packages/contracts/platforms.json`, A0): limit, title limit, "more" cut, tone, hashtags, links. */
export type WriterProfile = PlatformProfile;

/** Which profile kind each writer kind drafts for. Video briefs and slides go to Studio, not a platform. */
export const PROFILE_KIND: Record<WriterKind, WriterProfile["kind"] | null> = {
  post: "post",
  caption: "caption",
  youtube: "youtube",
  video_brief: null,
  slides: null,
};

/** Frames a video can have, the same list as `editor-core`'s `VIDEO_ASPECTS`. */
export const BRIEF_ASPECTS = ["9:16", "16:9", "1:1"] as const;

/**
 * The video brief: what Writer hands Studio before a video (`write_video_brief`) and what Studio's
 * `buildVideo` takes. One type for both sides; the Director writes the script from it and invents no facts.
 */
export const VideoBriefSchema = z.object({
  /** What the video should achieve: "show founders how a slash command makes a demo video". */
  objective: z.string().trim().min(3).max(300),
  /** The strategy angle it takes. */
  angle: z.string().trim().max(300).default(""),
  /** Opening lines to choose from; the first is preferred. */
  hooks: z.array(z.string().trim().min(1).max(160)).max(3).default([]),
  /** Facts the script may use; the Director invents none. */
  keyPoints: z.array(z.string().trim().min(1).max(200)).max(6).default([]),
  /** What the viewer should do at the end; empty leaves it to the Director. */
  cta: z.string().trim().max(160).default(""),
  seconds: z.number().int().min(5).max(90).default(30),
  aspect: z.enum(BRIEF_ASPECTS).default("9:16"),
  /** A premade voice name; absent → the strategy voice, else the model's default. */
  voice: z.string().trim().max(40).optional(),
});
export type VideoBrief = z.infer<typeof VideoBriefSchema>;

/** The finished edit a caption or YouTube text is written for: its words, never its frames. */
export type VideoSource = {
  /** The edit the caption is for (`content_items.clip_id`); its deliverable does not exist until the card is approved. */
  clipId: string;
  kind: "video" | "short";
  title: string;
  /** The first spoken line, when the edit has one. */
  hook?: string;
  /** What is said in the video (transcript text), cut to what fits the prompt. */
  transcript: string;
  seconds: number;
};

/** The work order per kind. Every text in it is the founder's plan or their own video, never outside text. */
export type WriterBriefs = {
  post: { idea: string; reason?: string; itemId?: string };
  caption: { video: VideoSource };
  youtube: { video: VideoSource };
  video_brief: { idea: string; reason?: string; seconds?: number; aspect?: VideoBrief["aspect"] };
  slides: { idea: string; reason?: string; count?: number };
};
export type WriterBrief<K extends WriterKind = WriterKind> = WriterBriefs[K];

/** A voice note learned from the founder's approvals and edits (`cmo_memories`, topic `post`). */
export type VoiceNote = {
  /** The founder's own words from one decision (approved text, an edit, a skip reason), written by SQL. */
  body: string;
  /** The profile id the decision was on; null when unknown. */
  platform: string | null;
  /** 0–1, newer notes weigh more (the read RPC weighs by age). */
  weight: number;
  createdAt: string;
};

/**
 * Everything the writer reads besides the brief. Corrections are memory tier 0 (rules the founder approved)
 * and come first; voice notes come next and beat the No AI Slop guidance when they disagree.
 */
export type WriterContext = {
  documents: Documents;
  /** Tier 0: rules the founder approved from their own repeated edits. */
  corrections: string[];
  /** Top voice notes, newest and heaviest first. */
  voiceNotes: VoiceNote[];
  /** Other notes and lessons for the topic (skip reasons, weekly lessons), as recalled today. */
  memories?: string;
  /** Recent approved or published texts on the same profile, so a draft does not repeat them. */
  recent: string[];
  /** Competitor research (`insightBlock`): outside text, data only. */
  insight?: string;
  /** Niche video research (`nicheBlock`, P5 R2), for the video brief: outside text, data only. */
  niche?: string;
  /** The URLs `niche` cites: the only ones a brief may say it learned from. */
  nicheUrls?: string[];
};

const angle = z.string().describe("The hook in a few words");

export const PostVersionSchema = z.object({ text: z.string().describe("The full post, ready to publish as is"), angle });
export type PostVersion = z.infer<typeof PostVersionSchema>;

/** A post: three versions with different hooks for one profile, and why this post now. */
export const PostDraftSchema = z.object({
  versions: z.array(PostVersionSchema).describe("Exactly three different versions"),
  rationale: z.string().describe("One sentence: why this post now, citing the strategy or calendar item"),
});
export type PostDraft = z.infer<typeof PostDraftSchema>;

/**
 * An X thread (P6 W4, `writer.md` §8): a hook post that makes a promise, one step per post, no recap at
 * the end. 5–8 posts, each within X's 280 (counted by code point, as `checkPost` counts). Stored on
 * `content_items.body.thread` with `text` = the first post, so single-post readers still see the hook.
 */
export const THREAD_MIN_POSTS = 5;
export const THREAD_MAX_POSTS = 8;
export const THREAD_POST_LIMIT = 280;

export const ThreadDraftSchema = z.object({
  posts: z
    .array(z.string().describe("One post of the thread, ready to publish as is"))
    .describe(`${THREAD_MIN_POSTS} to ${THREAD_MAX_POSTS} posts: the first is the hook with the promise, then one step each, no recap post at the end`),
  angle,
  rationale: z.string().describe("One sentence: why this thread now, citing the strategy or calendar item"),
});
export type ThreadDraft = z.infer<typeof ThreadDraftSchema>;

/** The stored body of a thread draft (what `cmo_save_draft` keeps once A's request 3 lands). */
export type ThreadBody = { text: string; thread: string[]; rationale: string; gen?: unknown };

/** A caption for one platform; hashtags are kept apart from the text so code can count them per profile. */
export const CaptionDraftSchema = z.object({
  text: z.string().describe("The caption without hashtags, hook in the first line"),
  hashtags: z.array(z.string()).describe("Hashtags without the # sign, at most the profile allows"),
  rationale: z.string().describe("One sentence: what the caption leads with and why"),
});
export type CaptionDraft = z.infer<typeof CaptionDraftSchema>;

export const YoutubeDraftSchema = z.object({
  title: z.string().describe("A searchable title, within the profile's title limit"),
  description: z.string().describe("The description: what the video shows, from the transcript only"),
  hashtags: z.array(z.string()).describe("Hashtags without the # sign, at most the profile allows"),
  rationale: z.string().describe("One sentence: who searches for this and why the title fits"),
});
export type YoutubeDraft = z.infer<typeof YoutubeDraftSchema>;

/** The model's video brief: exactly three hooks, the rest as `VideoBriefSchema`. */
export const VideoBriefDraftSchema = z.object({
  objective: z.string().describe("What the video should achieve, one sentence"),
  angle: z.string().describe("The strategy angle it takes"),
  hooks: z.array(z.string()).describe("Exactly three opening lines, the strongest first"),
  keyPoints: z.array(z.string()).describe("Up to six facts from the documents the script may use"),
  cta: z.string().describe("What the viewer should do at the end"),
  seconds: z.number().int().describe("Length in seconds, 5 to 90"),
  aspect: z.enum(BRIEF_ASPECTS),
  rationale: z.string().describe("One sentence: why this video now"),
  learnedFrom: z.array(z.string()).describe("URLs of the niche videos whose hooks or format this brief adapts, copied exactly; empty when none"),
});
export type VideoBriefDraft = z.infer<typeof VideoBriefDraftSchema>;

export const SlideSchema = z.object({
  heading: z.string().describe("A few words, one idea"),
  body: z.string().describe("One or two short lines; empty when the heading says it all"),
});
export type Slide = z.infer<typeof SlideSchema>;

/** Slide text for a slideshow: 5–10 slides, the hook first, one idea each, the call to action last. */
export const SlidesDraftSchema = z.object({
  slides: z.array(SlideSchema).describe("5 to 10 slides: the hook first, one idea each, the call to action last"),
  rationale: z.string().describe("One sentence: why this slideshow now"),
});
export type SlidesDraft = z.infer<typeof SlidesDraftSchema>;

export type WriterOutputs = {
  post: PostDraft;
  caption: CaptionDraft;
  youtube: YoutubeDraft;
  /** The brief as Studio takes it (parsed), plus why. */
  video_brief: { brief: VideoBrief; rationale: string; learnedFrom: string[] };
  slides: SlidesDraft;
};
export type WriterOutput<K extends WriterKind = WriterKind> = WriterOutputs[K];

/** The profile a kind is written for: a platform profile for posts, captions and YouTube; none for Studio's kinds. */
export type ProfileFor<K extends WriterKind> = K extends "video_brief" | "slides" ? null : WriterProfile;

/**
 * One writer for every kind. `draft` writes and checks with code; a version a code check refuses never
 * reaches a card, and a draft that keeps none fails the run (with its credit refunded by the runner).
 */
export interface Writer {
  draft<K extends WriterKind>(kind: K, profile: ProfileFor<K>, brief: WriterBrief<K>, context: WriterContext): Promise<WriterOutput<K>>;
}
