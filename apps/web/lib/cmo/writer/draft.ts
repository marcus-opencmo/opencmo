/**
 * Writer's `draft()` (`writer.md` §4): write → code checks → an optional review (the checker, on the other
 * provider) → one fix round with what both found → code checks again. A post keeps the versions that pass
 * the code; any other kind must pass or the run fails with the reasons, so nothing broken reaches a card.
 *
 * The model call is the job's `think` (OpenCMO's brain, the founder's Claude through the inbox, or the
 * fake in CI), so a writer kind runs the same way in every job that orders it.
 */

import type { z } from "zod";

import type { AgentId } from "../agents/registry";
import { checkRules, normalizeNumber } from "../jobs/context";
import { promptVersion } from "../jobs/edit-taxonomy";
import { LlmError } from "../jobs/llm-error";
import type { ThinkOptions } from "../jobs/think";
import type { CheckRules } from "../jobs/check-post";
import { captionText, checkCaption, checkPostFor, checkSlides, checkVideoBrief, checkYoutube, cleanHashtags } from "./checks";
import { writerData } from "./context";
import { CAPTION_SYSTEM, SLIDES_SYSTEM, VIDEO_BRIEF_SYSTEM, YOUTUBE_SYSTEM } from "./prompts";
import {
  CaptionDraftSchema,
  PostDraftSchema,
  SlidesDraftSchema,
  VideoBriefDraftSchema,
  VideoBriefSchema,
  YoutubeDraftSchema,
  type PostDraft,
  type ProfileFor,
  type VideoSource,
  type Writer,
  type WriterBrief,
  type WriterContext,
  type WriterKind,
  type WriterOutput,
  type WriterProfile,
} from "./types";

export type WriterThink = <S extends z.ZodType>(opts: ThinkOptions<S>) => Promise<z.infer<S>>;

export type WriterDeps = {
  think: WriterThink;
  /** The registry agent that writes this kind for this profile. */
  agentFor: (kind: WriterKind, profile: WriterProfile | null) => AgentId;
  /** The system prompt of a post profile; other kinds have theirs in `prompts.ts`. */
  postSystem?: string;
  /**
   * False when a fix round must not run: the founder's Claude answers from the inbox, and the fake writes
   * fixed text. A failed check then fails the run with its reasons.
   */
  canFix: boolean;
  /** The checker's problems, one list per version (posts) or one list (other kinds); advice, never a gate. */
  review?: (kind: WriterKind, output: unknown, data: string) => Promise<string[][]>;
  onUsage?: ThinkOptions<z.ZodType>["onUsage"];
  /** Added to every call's label, so one run writing for several edits keeps each call apart (inbox answers). */
  labelSuffix?: string;
};

const FAILURE = "We could not write this. Try again in a minute.";

/** The prompt version per kind, recorded with what it wrote (`gen.prompt_version`). */
export function writerPromptVersion(kind: WriterKind, postSystem = ""): string {
  const system = { post: postSystem, caption: CAPTION_SYSTEM, youtube: YOUTUBE_SYSTEM, video_brief: VIDEO_BRIEF_SYSTEM, slides: SLIDES_SYSTEM }[kind];
  return promptVersion(system);
}

/** Numbers the founder's documents hold, plus those said in the video a caption is written for. */
export function rulesFor(context: WriterContext, video?: VideoSource): CheckRules {
  const rules = checkRules(context.documents);
  for (const raw of video?.transcript.match(/\d[\d,.]*/g) ?? []) rules.known.add(normalizeNumber(raw));
  return rules;
}

function videoBlock(video: VideoSource): string {
  const hook = video.hook ? `\nfirst line said: ${video.hook}` : "";
  return `<video kind="${video.kind}" seconds="${Math.round(video.seconds)}">\ntitle: ${video.title}${hook}\ntranscript: ${video.transcript || "(no speech)"}\n</video>`;
}

const reasonOf = (brief: { reason?: string }) => (brief.reason ? ` (why: ${brief.reason})` : "");

function briefBlock(kind: WriterKind, brief: WriterBrief): string {
  switch (kind) {
    case "post": {
      const b = brief as WriterBrief<"post">;
      return `Today's idea: "${b.idea}"${reasonOf(b)}\n\nWrite three versions with different hooks for this platform. Do not repeat the recent texts.`;
    }
    case "caption":
      return `${videoBlock((brief as WriterBrief<"caption">).video)}\n\nWrite the caption for this platform.`;
    case "youtube":
      return `${videoBlock((brief as WriterBrief<"youtube">).video)}\n\nWrite the title and description.`;
    case "video_brief": {
      const b = brief as WriterBrief<"video_brief">;
      const asks = [b.seconds ? `${b.seconds} seconds` : "", b.aspect ? `${b.aspect} frame` : ""].filter(Boolean).join(", ");
      return `The week plan's video: "${b.idea}"${reasonOf(b)}${asks ? `\nPlanned: ${asks}.` : ""}\n\nWrite the brief.`;
    }
    case "slides": {
      const b = brief as WriterBrief<"slides">;
      return `The slideshow's idea: "${b.idea}"${reasonOf(b)}${b.count ? `\nUse ${b.count} slides.` : ""}\n\nWrite the slides.`;
    }
  }
}

/** The CI stand-in for a post: three plain versions of the idea, with no stock pattern, link or hashtag. */
export function fakePost(idea: string, product: string): PostDraft {
  const base = idea.replace(/\.$/, "") || "What we are building this week";
  return {
    versions: [
      { text: `${base}.\n\nWe learned it building ${product} this week.`, angle: "lesson" },
      { text: `We tried the usual advice first and it did not work for us. ${base}.`, angle: "contrarian" },
      { text: `We changed one small thing in ${product} this week. ${base}.`, angle: "build in public" },
    ],
    rationale: "From today's item in your calendar.",
  };
}

/** CI stand-ins: plain text with no stock pattern, link or hashtag in a post, from the brief alone. */
function fakeOutput(kind: WriterKind, profile: WriterProfile | null, brief: WriterBrief, product: string, context: WriterContext): unknown {
  switch (kind) {
    case "post":
      return fakePost((brief as WriterBrief<"post">).idea, product);
    case "caption": {
      const video = (brief as WriterBrief<"caption">).video;
      const tags = ["buildinpublic", "founder", "saas", "startup", "indiehacker"].slice(0, profile?.hashtags ?? 0);
      return { text: `${video.hook || video.title}\n\nWatch to the end to see how ${product} does it.`, hashtags: tags, rationale: "Leads with the video's own first line." };
    }
    case "youtube": {
      const video = (brief as WriterBrief<"youtube">).video;
      return {
        title: video.title.slice(0, 90),
        description: `${video.hook || video.title}\nA walk through ${product}, recorded by the founder.\n\nThis video shows ${video.title.toLowerCase()}.`,
        hashtags: ["buildinpublic"].slice(0, profile?.hashtags ?? 0),
        rationale: "Says what the video shows in the words people search with.",
      };
    }
    case "video_brief": {
      const b = brief as WriterBrief<"video_brief">;
      return {
        objective: b.idea.length >= 3 ? b.idea : "Show what the product does in one short video",
        angle: "Show it working, from the founder's own screen",
        hooks: [`${b.idea.replace(/\.$/, "")}.`, `Here is ${product} doing it in one take.`, `We built ${product} for this.`].map((hook) => hook.slice(0, 160)),
        keyPoints: [`${product} is the founder's own product`],
        cta: `Try ${product}`,
        seconds: b.seconds ?? 30,
        aspect: b.aspect ?? "9:16",
        rationale: "From this week's video item.",
        learnedFrom: (context.nicheUrls ?? []).slice(0, 2),
      };
    }
    case "slides": {
      const b = brief as WriterBrief<"slides">;
      const count = Math.min(10, Math.max(5, b.count ?? 5));
      const middle = Array.from({ length: count - 2 }, (_, index) => ({ heading: `Step ${index + 1}`, body: `One part of ${b.idea.replace(/\.$/, "").toLowerCase()}.` }));
      return { slides: [{ heading: b.idea.replace(/\.$/, ""), body: "" }, ...middle, { heading: `Try ${product}`, body: "" }], rationale: "From this week's slideshow item." };
    }
  }
}

type Spec = { schema: z.ZodType; system: string; label: string; title: string };

function spec(kind: WriterKind, profile: WriterProfile | null, postSystem: string | undefined): Spec {
  switch (kind) {
    case "post":
      if (!postSystem) throw new Error("A post writer needs its profile's system prompt.");
      return { schema: PostDraftSchema, system: postSystem, label: `write_post_${profile?.id}`, title: `Write three versions of a ${profile?.id} post` };
    case "caption":
      return { schema: CaptionDraftSchema, system: CAPTION_SYSTEM, label: `write_caption_${profile?.id}`, title: `Write the ${profile?.id} caption for a video` };
    case "youtube":
      return { schema: YoutubeDraftSchema, system: YOUTUBE_SYSTEM, label: "write_youtube", title: "Write the YouTube title and description for a video" };
    case "video_brief":
      return { schema: VideoBriefDraftSchema, system: VIDEO_BRIEF_SYSTEM, label: "write_video_brief", title: "Write the brief for this week's video" };
    case "slides":
      return { schema: SlidesDraftSchema, system: SLIDES_SYSTEM, label: "write_slides", title: "Write the slides for this week's slideshow" };
  }
}

/** The model's brief as Studio takes it: three hooks at most, six key points, a length Studio can make. */
function toBrief(raw: z.infer<typeof VideoBriefDraftSchema>) {
  return VideoBriefSchema.safeParse({
    objective: raw.objective,
    angle: raw.angle.slice(0, 300),
    hooks: raw.hooks.map((hook) => hook.trim()).filter(Boolean),
    keyPoints: raw.keyPoints.map((point) => point.trim()).filter(Boolean).slice(0, 6),
    cta: raw.cta.trim().slice(0, 160),
    seconds: Math.min(90, Math.max(5, Math.round(raw.seconds))),
    aspect: raw.aspect,
  });
}

/** Code problems of one output, one list per version for posts and one list otherwise. */
function problemsOf(kind: WriterKind, profile: WriterProfile | null, output: unknown, rules: CheckRules): string[][] {
  switch (kind) {
    case "post":
      return (output as PostDraft).versions.map((version) => checkPostFor(version.text.trim(), profile!, rules));
    case "caption":
      return [checkCaption(output as z.infer<typeof CaptionDraftSchema>, profile!, rules)];
    case "youtube":
      return [checkYoutube(output as z.infer<typeof YoutubeDraftSchema>, profile!, rules)];
    case "video_brief": {
      const raw = output as z.infer<typeof VideoBriefDraftSchema>;
      if (raw.hooks.filter((hook) => hook.trim()).length !== 3) return [[`It has ${raw.hooks.length} hooks; a brief has 3.`]];
      const parsed = toBrief(raw);
      return [parsed.success ? checkVideoBrief(parsed.data, rules) : parsed.error.issues.map((issue) => `${issue.path.join(".") || "brief"}: ${issue.message}`)];
    }
    case "slides":
      return [checkSlides((output as z.infer<typeof SlidesDraftSchema>).slides, rules)];
  }
}

function fixPrompt(kind: WriterKind, output: unknown, problems: string[][]): string {
  if (kind === "post") {
    const versions = (output as PostDraft).versions;
    return `These versions had problems. Rewrite all three, fixing each problem and keeping what worked.\n\n${versions
      .map((version, index) => `<draft index="${index}">${version.text}</draft>\n<problems>${problems[index]?.join(" ") || "none"}</problems>`)
      .join("\n")}`;
  }
  return `This draft had problems. Write it again, fixing each problem and keeping what worked.\n\n<draft>${JSON.stringify(output)}</draft>\n<problems>${problems.flat().join(" ")}</problems>`;
}

function finish<K extends WriterKind>(kind: K, profile: WriterProfile | null, output: unknown, rules: CheckRules): WriterOutput<K> {
  const problems = problemsOf(kind, profile, output, rules);
  if (kind === "post") {
    const draft = output as PostDraft;
    const passing = draft.versions.map((version) => ({ ...version, text: version.text.trim() })).filter((_, index) => !problems[index]?.length);
    if (!passing.length) throw new LlmError(`Every version failed our checks. ${problems.map((p, i) => `Version ${i + 1}: ${p.join(" ")}`).join(" ")}`.slice(0, 480));
    return { versions: passing, rationale: draft.rationale } as WriterOutput<K>;
  }
  const found = problems.flat();
  if (found.length) throw new LlmError(`The draft failed our checks. ${found.join(" ")}`.slice(0, 480));
  switch (kind) {
    case "caption": {
      const caption = output as z.infer<typeof CaptionDraftSchema>;
      return { text: caption.text.trim(), hashtags: cleanHashtags(caption.hashtags), rationale: caption.rationale } as WriterOutput<K>;
    }
    case "youtube": {
      const youtube = output as z.infer<typeof YoutubeDraftSchema>;
      return { title: youtube.title.trim(), description: youtube.description.trim(), hashtags: cleanHashtags(youtube.hashtags), rationale: youtube.rationale } as WriterOutput<K>;
    }
    case "video_brief": {
      const raw = output as z.infer<typeof VideoBriefDraftSchema>;
      return { brief: toBrief(raw).data!, rationale: raw.rationale, learnedFrom: raw.learnedFrom ?? [] } as WriterOutput<K>;
    }
    default: {
      const slides = output as z.infer<typeof SlidesDraftSchema>;
      return { slides: slides.slides.map((slide) => ({ heading: slide.heading.trim(), body: slide.body.trim() })), rationale: slides.rationale } as WriterOutput<K>;
    }
  }
}

/** A caption as published (text + hashtags), for cards that show one string. */
export { captionText };

export function createWriter(deps: WriterDeps): Writer {
  return {
    async draft<K extends WriterKind>(kind: K, profile: ProfileFor<K>, brief: WriterBrief<K>, context: WriterContext): Promise<WriterOutput<K>> {
      const wanted = kind === "video_brief" || kind === "slides" ? null : kind;
      if (wanted && profile?.kind !== wanted) throw new Error(`A ${kind} needs a ${wanted} profile, got ${profile ? profile.kind : "none"}.`);
      const p = profile as WriterProfile | null;
      const video = kind === "caption" || kind === "youtube" ? (brief as WriterBrief<"caption">).video : undefined;
      const rules = rulesFor(context, video);
      const product = typeof context.documents.product?.name === "string" && context.documents.product.name ? context.documents.product.name : "our product";
      const { schema, system, label, title } = spec(kind, p, deps.postSystem);
      const data = writerData(context, p, briefBlock(kind, brief));
      const agent = deps.agentFor(kind, p);
      const ask = (prompt: string, round: string) =>
        deps.think({ agent, system, prompt, schema, label: `${label}${deps.labelSuffix ?? ""}${round}`, title, failure: FAILURE, fake: () => fakeOutput(kind, p, brief, product, context), ...(deps.onUsage ? { onUsage: deps.onUsage } : {}) });

      let output: unknown = await ask(data, "");
      const problems = problemsOf(kind, p, output, rules);
      if (deps.review) {
        const reviewed = await deps.review(kind, output, data);
        reviewed.forEach((list, index) => problems[index]?.push(...list));
      }
      if (deps.canFix && problems.some((list) => list.length)) output = await ask(`${data}\n\n${fixPrompt(kind, output, problems)}`, "_fix");
      return finish(kind, p, output, rules);
    },
  };
}
