/**
 * Code checks per writer kind, run before a draft reaches a card: limits from the platform profile, the
 * strategy's words to avoid, numbers that must be in the documents, links only where the profile allows
 * them, and hashtags only on captions and YouTube text, at most the profile's count. A post goes through
 * `checkPost` (no links and no hashtags at all).
 *
 * Facts and product rules only: No AI Slop is advice in the prompt, never a check here.
 */

import { SLIDE_TEXT_MAX } from "@opencmo/editor-core";

import { checkPost, factIssues, hashtagCount, hasLink, type CheckRules } from "../jobs/check-post";
import type { CaptionDraft, Slide, VideoBrief, WriterProfile, YoutubeDraft } from "./types";

const chars = (text: string) => [...text].length;

/** "buildinpublic", "#buildinpublic" and "#build in public" are one tag; empty ones are dropped. */
export function cleanHashtags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  return tags
    .map((tag) => tag.trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter((tag) => tag && /\p{L}/u.test(tag) && !seen.has(tag.toLowerCase()) && (seen.add(tag.toLowerCase()), true));
}

/** The caption as it is published: the text, then its hashtags on their own line. */
export function captionText(draft: Pick<CaptionDraft, "text" | "hashtags">): string {
  const tags = cleanHashtags(draft.hashtags);
  return tags.length ? `${draft.text.trim()}\n\n${tags.map((tag) => `#${tag}`).join(" ")}` : draft.text.trim();
}

function tagIssues(text: string, tags: readonly string[], profile: WriterProfile): string[] {
  const count = hashtagCount(text) + cleanHashtags(tags).length;
  if (count <= profile.hashtags) return [];
  return [profile.hashtags ? `It has ${count} hashtags; the ${profile.label} takes at most ${profile.hashtags}.` : `It has a hashtag; the ${profile.label} takes none.`];
}

const linkIssues = (text: string, profile: WriterProfile, rules: CheckRules): string[] =>
  !profile.links && hasLink(text, rules.names) ? [`It has a link; the ${profile.label} takes none.`] : [];

export function checkPostFor(text: string, profile: WriterProfile, rules: CheckRules): string[] {
  return checkPost(text, rules, { limit: profile.limit, platform: profile.label });
}

/**
 * Advice for the fix round, never a reason to drop a version: on a platform that cuts a post at "more" (LinkedIn),
 * the first line should end before the cut so the hook is read.
 */
export function moreAdvice(text: string, profile: WriterProfile): string[] {
  const cut = profile.visibleBeforeMore;
  const first = text.trim().split("\n")[0] ?? "";
  if (!cut || chars(first) <= cut) return [];
  return [`The first line is ${chars(first)} characters; ${profile.label} shows about ${cut} before "more", so the hook should land sooner.`];
}

/** The published caption (text and hashtags together) must fit the profile's limit. */
export function checkCaption(draft: Pick<CaptionDraft, "text" | "hashtags">, profile: WriterProfile, rules: CheckRules): string[] {
  const text = draft.text.trim();
  if (!text) return ["The caption is empty."];
  const full = captionText(draft);
  return [
    ...(chars(full) > profile.limit ? [`It is ${chars(full)} characters; the ${profile.label} allows ${profile.limit}.`] : []),
    ...factIssues(text, rules),
    ...linkIssues(text, profile, rules),
    ...tagIssues(text, draft.hashtags, profile),
  ];
}

export function checkYoutube(draft: Pick<YoutubeDraft, "title" | "description" | "hashtags">, profile: WriterProfile, rules: CheckRules): string[] {
  const title = draft.title.trim();
  const description = draft.description.trim();
  if (!title || !description) return [title ? "The description is empty." : "The title is empty."];
  const titleLimit = profile.title ?? 100;
  const full = captionText({ text: description, hashtags: draft.hashtags });
  return [
    ...(chars(title) > titleLimit ? [`The title is ${chars(title)} characters; YouTube allows ${titleLimit}.`] : []),
    ...(chars(full) > profile.limit ? [`The description is ${chars(full)} characters; YouTube allows ${profile.limit}.`] : []),
    ...(hashtagCount(title) ? ["The title has a hashtag; hashtags go in the description."] : []),
    ...factIssues(`${title}\n${description}`, rules),
    ...linkIssues(`${title}\n${description}`, profile, rules),
    ...tagIssues(description, draft.hashtags, profile),
  ];
}

/** The brief's hooks and key points reach the Director as facts: no invented numbers, no words to avoid. */
export function checkVideoBrief(brief: VideoBrief, rules: CheckRules): string[] {
  const issues: string[] = [];
  if (brief.hooks.length !== 3) issues.push(`It has ${brief.hooks.length} hooks; a brief has 3.`);
  if (!brief.cta) issues.push("It has no call to action.");
  issues.push(...factIssues([brief.objective, brief.angle, ...brief.hooks, ...brief.keyPoints, brief.cta].join("\n"), rules));
  return issues;
}

/** 5 to 10 slides, each with a heading; facts from the documents only; no links or hashtags on a slide. */
export function checkSlides(slides: readonly Slide[], rules: CheckRules): string[] {
  const issues: string[] = [];
  if (slides.length < 5 || slides.length > 10) issues.push(`It has ${slides.length} slides; a slideshow has 5 to 10.`);
  if (slides.some((slide) => !slide.heading.trim())) issues.push("A slide has no heading.");
  if (slides.some((slide) => slide.heading.length > SLIDE_TEXT_MAX.heading)) issues.push(`A heading is over ${SLIDE_TEXT_MAX.heading} characters; it would not fit the frame.`);
  if (slides.some((slide) => slide.body.length > SLIDE_TEXT_MAX.body)) issues.push(`A body is over ${SLIDE_TEXT_MAX.body} characters; it would not fit the frame.`);
  const text = slides.map((slide) => `${slide.heading}\n${slide.body}`).join("\n");
  if (hasLink(text, rules.names)) issues.push("A slide has a link.");
  if (hashtagCount(text)) issues.push("A slide has a hashtag.");
  issues.push(...factIssues(text, rules));
  return issues;
}
