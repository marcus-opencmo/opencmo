/**
 * Hacker News as a source for Sales and Research (P6 R4; `research-sales.md` §9).
 *
 * Algolia's public HN search (`hn.algolia.com/api/v1`): no key, a generous per-IP limit, so we still
 * count our own calls (`HnBudget`) to stay well inside it and to stop loops. Everything it returns is
 * outside text: cleaned of smuggled Unicode here and wrapped as data by the caller.
 *
 * Not `server-only` so checks can run it.
 */

import { isProduction } from "@/lib/production";

import { cleanUntrusted } from "../untrusted";

/** One HN story, shaped like `RedditThread` so Sales can score both the same way. */
export type HnThread = {
  /** Always the discussion page `https://news.ycombinator.com/item?id=<id>`, never the linked site. */
  url: string;
  objectId: string;
  /** Shown where a subreddit would be. */
  community: "Hacker News";
  title: string;
  author: string;
  /** The story text (Ask HN / Show HN), or empty for a link post. */
  text: string;
  points: number;
  comments: number;
  postedAt: string | null;
};

export class HnReadError extends Error {}

/** Calls per request (a chat turn or a scan). Algolia allows far more; this is our own brake. */
export class HnBudget {
  used = 0;
  constructor(readonly limit: number) {}
  take(): void {
    if (this.used + 1 > this.limit) {
      throw new HnReadError(`Hacker News limit reached for this request (${this.limit} searches). Summarize what you found.`);
    }
    this.used += 1;
  }
}

/** The seam Sales and Research call; tests and evals pass recorded responses through it. */
export type HnSource = {
  search(query: string, budget: HnBudget): Promise<HnThread[]>;
};

// ----------------------------------------------------------------- search

export const HN_BASE = "https://hn.algolia.com/api/v1";
const TIMEOUT_MS = 20_000;
/** Enough to score; the scan reads at most this many per query. */
export const HN_HITS = 20;
const ITEM = /^https:\/\/news\.ycombinator\.com\/item\?id=\d{1,12}$/;

export const hnFakeAllowed = (): boolean => process.env.OPENCMO_AGENT_FAKE === "1" && !isProduction();

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HN story text is HTML (`<p>`, `<a>`, entities): plain text before anything reads it, then cleaned. */
export function hnPlain(html: string, max: number): string {
  let text = html
    .replace(/<p>/gi, "\n")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d: string) => safeChar(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
  // Tags are stripped after the entities are decoded, until none is left: an encoded `&lt;script&gt;` or a split
  // `<scr<b>ipt>` must not come out as a tag.
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(/<[^>]*>/g, "");
  }
  return cleanUntrusted(text).replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim().slice(0, max);
}

const safeChar = (code: number): string => (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "");

/** Algolia's JSON → stories with a discussion URL and a title; anything else is dropped. */
export function parseHnSearch(json: unknown): HnThread[] {
  const hits = isObj(json) && Array.isArray(json.hits) ? json.hits.filter(isObj) : [];
  const out: HnThread[] = [];
  for (const hit of hits) {
    const objectId = str(hit.objectID);
    if (!/^\d{1,12}$/.test(objectId)) continue;
    const url = `https://news.ycombinator.com/item?id=${objectId}`;
    const title = hnPlain(str(hit.title), 300);
    if (!ITEM.test(url) || !title) continue;
    const created = str(hit.created_at);
    const time = created ? new Date(created) : null;
    out.push({
      url,
      objectId,
      community: "Hacker News",
      title,
      author: hnPlain(str(hit.author), 60),
      text: hnPlain(str(hit.story_text), 4000),
      points: int(hit.points),
      comments: int(hit.num_comments),
      postedAt: time && !Number.isNaN(time.getTime()) ? time.toISOString() : null,
    });
  }
  return out;
}

const FAKE: HnThread[] = [
  {
    url: "https://news.ycombinator.com/item?id=1",
    objectId: "1",
    community: "Hacker News",
    title: "Ask HN: How do you handle clients who pay late?",
    author: "fake_founder",
    text: "I freelance for a few startups and one invoice is a month overdue. Polite reminders feel awkward.",
    points: 12,
    comments: 9,
    postedAt: null,
  },
];

/**
 * Stories matching `query`. `recentDays` asks for the newest first within that window (Sales: a thread worth
 * a reply is fresh); without it, Algolia's relevance order (Research).
 */
export async function searchHn(query: string, budget: HnBudget, opts: { recentDays?: number; fetch?: typeof fetch } = {}): Promise<HnThread[]> {
  const q = cleanUntrusted(query).trim().slice(0, 200);
  if (!q) return [];
  budget.take();
  if (hnFakeAllowed() && !opts.fetch) return FAKE.map((t) => ({ ...t, postedAt: new Date().toISOString() }));
  const params = new URLSearchParams({ query: q, tags: "story", hitsPerPage: String(HN_HITS) });
  let path = "search";
  if (opts.recentDays) {
    path = "search_by_date";
    params.set("numericFilters", `created_at_i>${Math.floor(Date.now() / 1000) - opts.recentDays * 86_400}`);
  }
  const call = opts.fetch ?? fetch;
  let response: Response;
  try {
    response = await call(`${HN_BASE}/${path}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
  } catch {
    throw new HnReadError("Hacker News did not answer in time. Try again in a minute.");
  }
  if (response.status === 429) throw new HnReadError("Hacker News search is busy right now. Try again in a few minutes.");
  if (!response.ok) throw new HnReadError("Hacker News search failed. Try again later.");
  return parseHnSearch(await response.json().catch(() => null));
}

/** The default source: Algolia search. Tests and evals pass their own. */
export const algoliaHn: HnSource = { search: (query, budget) => searchHn(query, budget) };

// ----------------------------------------------------------------- one discussion (P6 R3)

/** A comment in a discussion, flattened: its own id, plain text and how many direct replies it has. */
export type HnComment = { id: string; author: string; text: string; replies: number };

/** Algolia's item tree → every comment in it (depth-first, at most `max`). HN shows no points for comments. */
export function parseHnItem(json: unknown, max = 500): HnComment[] {
  const out: HnComment[] = [];
  const walk = (node: unknown) => {
    if (!isObj(node) || out.length >= max) return;
    const children = Array.isArray(node.children) ? node.children : [];
    if (str(node.type) === "comment" && /^\d{1,12}$/.test(String(node.id ?? ""))) {
      out.push({ id: String(node.id), author: hnPlain(str(node.author), 60), text: hnPlain(str(node.text), 4000), replies: children.filter(isObj).length });
    }
    for (const child of children) walk(child);
  };
  walk(json);
  return out;
}

/** The comments of one HN item (a story or a comment), or null when HN no longer has it. */
export async function hnItem(url: string, budget: HnBudget, opts: { fetch?: typeof fetch } = {}): Promise<HnComment[] | null> {
  const id = /^https:\/\/news\.ycombinator\.com\/item\?id=(\d{1,12})$/.exec(url)?.[1];
  if (!id) throw new HnReadError("Use a news.ycombinator.com item link.");
  budget.take();
  if (hnFakeAllowed() && !opts.fetch) {
    return [{ id: "2", author: "fake_founder", text: "Thanks, I will try the reminder rule.", replies: 0 }];
  }
  const call = opts.fetch ?? fetch;
  let response: Response;
  try {
    response = await call(`${HN_BASE}/items/${id}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
  } catch {
    throw new HnReadError("Hacker News did not answer in time. Try again in a minute.");
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new HnReadError("Hacker News could not be read. Try again later.");
  const json = await response.json().catch(() => null);
  if (!isObj(json)) return null;
  // Reading a comment's own link: count it too, so the founder's pasted reply is in the list.
  return str(json.type) === "comment" ? parseHnItem({ type: "story", children: [json] }) : parseHnItem(json);
}
