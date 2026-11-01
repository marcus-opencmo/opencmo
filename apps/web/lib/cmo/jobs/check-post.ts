/**
 * Code checks on a post BEFORE a model check costs money: length, words to avoid, made-up numbers, and
 * the product rules for posts (owner, 2026-10-26, `writer.md` §7): no links and no hashtags in a post;
 * hashtags belong only on video captions. A number of 10 or more, or a percentage, must appear in the
 * founder's documents (no invented numbers).
 *
 * Only facts and product rules live here. Writing style (No AI Slop) is advice the writer and the checker
 * read in a skill, never a check that drops a draft.
 */

import { countHashtags } from "../platforms";

import { numberTokens } from "./context";

export const X_LIMIT = 280;

/** `names`: the founder's own product name(s), which may look like a domain ("Cal.com") and are not links. */
export type CheckRules = { avoid: string[]; known: Set<string>; names?: string[] };

/** Always a link: a URL, a `www.` address, or a domain with a path ("opencmo.io/pricing"). SQL's `caption_check` holds the same. */
const URL_LIKE = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+|\b[a-z0-9][a-z0-9-]*\.[a-z]{2,}\/\S/i;
/** A bare domain on a TLD people link to ("acme.io"); not "Next.js". */
const BARE_DOMAIN = /\b[a-z0-9][a-z0-9-]*\.(?:com|io|ai|co|app|dev|net|org|so|xyz|me|ly|gg|sh|to|tv|link|site|online|store|tech|page|info|biz|us|uk)\b(?!\.\w)/gi;

/** A link, except a bare domain that is the founder's own product name (`names`, from the product document). */
export function hasLink(text: string, names: readonly string[] = []): boolean {
  if (URL_LIKE.test(text)) return true;
  const own = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  return [...text.matchAll(BARE_DOMAIN)].some((m) => !own.has(m[0].toLowerCase()));
}
/** Hashtags the way the platforms count them ("#buildinpublic", not "#1" or "C#"), the same count the cards show. */
export const hashtagCount = countHashtags;

/** Words the strategy says to avoid, and numbers the documents do not hold: the fact checks every kind shares. */
export function factIssues(text: string, rules: CheckRules): string[] {
  const issues: string[] = [];
  const lower = text.toLowerCase();
  for (const word of rules.avoid) {
    const w = word.toLowerCase();
    if (w.length >= 3 && lower.includes(w)) issues.push(`It uses "${word}", which your strategy says to avoid.`);
  }
  // "2,000 users" is not the year 2000, and "5k users" is not 5: both are counts the documents must hold.
  for (const { raw, n, percent, plain } of numberTokens(text)) {
    if (!percent && Number(n) < 10) continue;
    if (plain && /^(19|20)\d\d$/.test(n)) continue;
    if (!rules.known.has(n)) issues.push(`It says ${raw}, a number that is not in your documents.`);
  }
  return issues;
}

/** `limit` and `platform` come from the post's profile; X when not given. */
export function checkPost(text: string, rules: CheckRules, profile: { limit: number; platform: string } = { limit: X_LIMIT, platform: "X" }): string[] {
  const t = text.trim();
  if (!t) return ["The post is empty."];
  const issues: string[] = [];
  const length = [...t].length;
  if (length > profile.limit) issues.push(`It is ${length} characters; ${profile.platform} allows ${profile.limit}.`);
  issues.push(...factIssues(t, rules));
  if (hasLink(t, rules.names)) issues.push("It has a link. Posts carry no links.");
  if (hashtagCount(t)) issues.push("It has a hashtag. Posts carry no hashtags; they go only on video captions.");
  return issues;
}
