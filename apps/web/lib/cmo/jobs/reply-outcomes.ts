/**
 * What the founder's replies got (P6 A3, R3; `research-sales.md` §6). Three days after "replied", the thread is read
 * again: Reddit through the social reader, Hacker News through Algolia (free). The founder's reply is found by its
 * text (the link they pasted narrows a Hacker News read to that comment), and its votes and replies are stored on the
 * outcome. SQL writes the memory line from our own numbers; nothing the thread says reaches memory or a prompt.
 */

import { HnBudget, HnReadError, hnItem, type HnComment } from "../social/hn";
import { redditThread } from "../social/research";
import { ScBudget, SocialReadError, socialReaderReady, type RedditComment } from "../social/scrapecreators";
import type { JobContext } from "./runner";
import type { ReplyOutcomeDue } from "./types";

/** At most this many replies checked a run: each Reddit read costs a lookup. */
export const MAX_REPLY_CHECKS = 10;
/** Enough comments to find a reply that is not near the top. */
const REDDIT_COMMENTS = 100;

const words = (s: string) => s.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w.length > 2);

/** How much of the founder's reply a comment holds (0–1): the share of the reply's words found in it. */
export function replyOverlap(reply: string, comment: string): number {
  const mine = [...new Set(words(reply))];
  if (!mine.length) return 0;
  const theirs = new Set(words(comment));
  return mine.filter((w) => theirs.has(w)).length / mine.length;
}

/** The comment that is the founder's reply: most of its words, edits allowed (the founder posts by hand). */
export function findReply<C extends { text: string }>(reply: string, comments: C[]): C | null {
  let best: { c: C; score: number } | null = null;
  for (const c of comments) {
    const score = replyOverlap(reply, c.text);
    if (score >= 0.7 && (!best || score > best.score)) best = { c, score };
  }
  return best?.c ?? null;
}

export type ReplyReaders = {
  reddit: (url: string) => Promise<{ gone: boolean; comments: RedditComment[] }>;
  hn: (url: string) => Promise<HnComment[] | null>;
};

export function defaultReaders(): ReplyReaders {
  const sc = new ScBudget(MAX_REPLY_CHECKS);
  const hn = new HnBudget(MAX_REPLY_CHECKS);
  return {
    reddit: async (url) => {
      const read = await redditThread(url, sc, REDDIT_COMMENTS);
      return { gone: !read.post, comments: read.comments };
    },
    hn: (url) => hnItem(url, hn),
  };
}

export type ReplyCheck = { status: "found" | "not_found" | "gone"; votes: number | null; replies: number | null };

/** Reads one reply's thread; a read that fails (reader down, limit hit) is null, so it is tried again tomorrow. */
export async function checkReply(due: ReplyOutcomeDue, readers: ReplyReaders): Promise<ReplyCheck | null> {
  try {
    if (due.platform === "hn") {
      // A pasted link to the reply itself is read alone; otherwise the whole discussion.
      const comments = await readers.hn(due.outcome_url ?? due.url);
      if (!comments) return { status: "gone", votes: null, replies: null };
      const mine = findReply(due.reply, comments);
      return mine ? { status: "found", votes: null, replies: mine.replies } : { status: "not_found", votes: null, replies: null };
    }
    const read = await readers.reddit(due.url);
    if (read.gone) return { status: "gone", votes: null, replies: null };
    const mine = findReply(due.reply, read.comments);
    return mine ? { status: "found", votes: mine.score, replies: mine.replies ?? null } : { status: "not_found", votes: null, replies: null };
  } catch (error) {
    if (error instanceof SocialReadError || error instanceof HnReadError) return null;
    throw error;
  }
}

/** The `pull_metrics` step: every reply due, checked once. Reddit replies wait while the reader is not set up. */
export async function checkReplies(ctx: JobContext, readers: ReplyReaders = defaultReaders()): Promise<{ checked: number; found: number }> {
  const { store, run } = ctx;
  const due = (await store.replyOutcomesDue(run.user_id, MAX_REPLY_CHECKS)).filter((d) => d.platform === "hn" || socialReaderReady());
  if (!due.length) return { checked: 0, found: 0 };
  return ctx.step(
    "check_replies",
    "Checking what your replies got",
    async () => {
      let checked = 0;
      let found = 0;
      for (const d of due) {
        const result = await checkReply(d, readers);
        if (!result) continue;
        if (await store.saveReplyOutcome(run.user_id, d.outcome_id, result)) {
          checked += 1;
          if (result.status === "found") found += 1;
        }
      }
      return { checked, found };
    },
    (r) => `${r.checked} replies checked, ${r.found} found`,
  );
}
