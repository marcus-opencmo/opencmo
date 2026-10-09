/**
 * Các phép đọc của bộ tool research (H2) trên client ScrapeCreators. Mỗi hàm = một endpoint
 * (đường dẫn theo skill `scrapecreators-api`), trả dữ liệu đã chuẩn hoá và ĐÃ RÚT GỌN — tool chat
 * không được đổ nguyên response vài trăm KB vào context. Bản giả (CI/E2E) dựng từ đầu vào, ổn định.
 *
 * Endpoint đắt (vd. `/v1/tiktok/user/audience` 26 credit) cố ý không có ở đây.
 */

import {
  itemsOf,
  num,
  redditPost,
  type RedditComment,
  type ScBudget,
  scFakeAllowed,
  scGet,
  type SocialPost,
  SocialReadError,
  str,
  threadsPost,
  tiktokPost,
  xPost,
  youtubePost,
} from "./scrapecreators";

export type RedditPost = NonNullable<ReturnType<typeof redditPost>>;
const handleOf = (h: string) => h.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//, "").split(/[/?#]/)[0]!.slice(0, 60);
const keep = <T>(items: (T | null)[], max: number): T[] => items.filter((x): x is T => x !== null).slice(0, max);

// ----------------------------------------------------------------- bản giả

const hour = 3_600_000;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "post";

function fakePosts(platform: SocialPost["platform"], seed: string, author: string): SocialPost[] {
  const base = {
    x: (i: number) => `https://x.com/${author.replace(/^@/, "")}/status/1${slug(seed).length}${i}`,
    tiktok: (i: number) => `https://www.tiktok.com/${author}/video/7${slug(seed).length}${i}`,
    youtube: (i: number) => `https://www.youtube.com/watch?v=fake${slug(seed).length}${i}`,
    threads: (i: number) => `https://www.threads.net/${author}/post/F${slug(seed).length}${i}`,
    reddit: (i: number) => `https://www.reddit.com/r/test/comments/f${i}/${slug(seed)}`,
    instagram: (i: number) => `https://www.instagram.com/p/F${i}`,
  }[platform];
  // 12 bài: 1 bài nổi 6x, 1 bài 2.5x, còn lại quanh baseline — đủ cho outlier ra nhãn.
  const perf = [600, 250, 110, 100, 100, 95, 90, 105, 100, 98, 102, 80];
  return perf.map((p, i) => ({
    platform,
    url: base(i),
    author,
    text: i === 0 ? `Stop doing ${seed} the hard way. Here's the 3-step version I wish I had.` : i === 1 ? `I tried 5 ways to handle ${seed}. Only one stuck.` : `Notes on ${seed}, part ${i}.`,
    postedAt: new Date(Date.now() - (i + 1) * 20 * hour).toISOString(),
    views: platform === "tiktok" || platform === "youtube" ? p * 100 : 0,
    likes: platform === "tiktok" || platform === "youtube" ? p * 5 : Math.round(p * 0.8),
    replies: Math.round(p * 0.15),
    reposts: Math.round(p * 0.05),
  }));
}

// ----------------------------------------------------------------- Reddit

export async function redditSearch(query: string, budget?: ScBudget, opts: { sort?: string; timeframe?: string } = {}): Promise<RedditPost[]> {
  if (scFakeAllowed()) {
    return fakePosts("reddit", query, "u/founder_q").slice(0, 5).map((p, i) => ({ ...p, community: i % 2 ? "r/smallbusiness" : "r/freelance", title: `How do you deal with ${query}?` }));
  }
  const params: Record<string, string> = { query };
  if (opts.sort) params.sort = opts.sort;
  if (opts.timeframe) params.timeframe = opts.timeframe;
  const json = await scGet("/v1/reddit/search", params, budget);
  return keep(itemsOf(json, ["posts", "results", "data", "items"]).map(redditPost), 25);
}

/** Bài mới/nổi của một subreddit. Tên subreddit PHÂN BIỆT hoa thường ("SaaS", không phải "saas"). */
export async function subredditPosts(subreddit: string, budget?: ScBudget, sort = "hot"): Promise<RedditPost[]> {
  const name = subreddit.trim().replace(/^\/?r\//, "").slice(0, 60);
  if (!/^[A-Za-z0-9_]{2,60}$/.test(name)) throw new SocialReadError("Use a subreddit name like SaaS or Entrepreneur.");
  if (scFakeAllowed()) return fakePosts("reddit", name, "u/member").slice(0, 8).map((p) => ({ ...p, community: `r/${name}`, title: `What tool do you use for ${name}?` }));
  const json = await scGet("/v1/reddit/subreddit", { subreddit: name, sort }, budget);
  return keep(itemsOf(json, ["posts", "data", "results"]).map(redditPost), 25);
}

/** Bài + comment (đọc CẢ comment: nhu cầu thật hay nằm ở đó — comment-mining). */
export async function redditThread(url: string, budget?: ScBudget): Promise<{ post: RedditPost | null; comments: RedditComment[] }> {
  if (!/^https:\/\/(www\.|old\.)?reddit\.com\/r\/[^/]+\/comments\//.test(url)) throw new SocialReadError("Use a full reddit.com thread link.");
  if (scFakeAllowed()) {
    const [post] = await redditSearch("invoices", budget);
    return {
      post: post ? { ...post, url } : null,
      comments: [
        { author: "u/ops_lena", text: "Same here, I gave up on spreadsheets. Would pay for something that just chases late clients.", score: 14 },
        { author: "u/devnull", text: "Just use a calendar reminder?", score: 2 },
      ],
    };
  }
  const json = await scGet("/v1/reddit/post/comments", { url }, budget);
  const root = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const postItem = itemsOf(root, ["post"])[0] ?? (root.post && typeof root.post === "object" ? (root.post as Record<string, unknown>) : null);
  const comments = itemsOf(root, ["comments", "data.comments"])
    .map((c) => ({ author: str(c.author), text: str(c.body ?? c.text).replace(/\s+/g, " ").trim().slice(0, 600), score: num(c.score ?? c.ups) }))
    .filter((c) => c.text)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  return { post: postItem ? redditPost(postItem) : null, comments };
}

// ----------------------------------------------------------------- X

export type XProfile = { handle: string; name: string; bio: string; followers: number; following: number; posts: number };

export async function xProfile(handle: string, budget?: ScBudget): Promise<XProfile> {
  const h = handleOf(handle);
  if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) throw new SocialReadError("Use an X handle like @levelsio.");
  if (scFakeAllowed()) return { handle: `@${h}`, name: h, bio: `Building in public. Founder of ${h}.app`, followers: 12_400, following: 310, posts: 4_200 };
  const json = (await scGet("/v1/twitter/profile", { handle: h }, budget)) as Record<string, unknown> | null;
  const l = (json?.legacy ?? json?.data ?? json ?? {}) as Record<string, unknown>;
  return {
    handle: `@${h}`,
    name: str(l.name).slice(0, 100),
    bio: str(l.description ?? l.bio).replace(/\s+/g, " ").slice(0, 400),
    followers: num(l.followers_count ?? l.followers),
    following: num(l.friends_count ?? l.following),
    posts: num(l.statuses_count ?? l.tweets),
  };
}

/** ~100 bài NỔI NHẤT của tài khoản (không phải mới nhất) — giới hạn của ScrapeCreators. */
export async function xTopPosts(handle: string, budget?: ScBudget): Promise<SocialPost[]> {
  const h = handleOf(handle);
  if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) throw new SocialReadError("Use an X handle like @levelsio.");
  if (scFakeAllowed()) return fakePosts("x", h, `@${h}`);
  const json = await scGet("/v1/twitter/user-tweets", { handle: h }, budget);
  return keep(itemsOf(json, ["tweets", "data", "results"]).map((t) => xPost(t, h)), 100);
}

/** Một bài X theo link (số liệu bài người dùng đã tự đăng — W6-lite). */
export async function xTweet(url: string, budget?: ScBudget): Promise<SocialPost | null> {
  const m = /^https:\/\/(www\.)?(x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/.exec(url);
  if (!m) throw new SocialReadError("Use a full x.com post link.");
  if (scFakeAllowed()) return { platform: "x", url: `https://x.com/${m[3]}/status/${m[4]}`, author: `@${m[3]}`, text: "", postedAt: null, views: 1840, likes: 37, replies: 6, reposts: 4 };
  const json = (await scGet("/v1/twitter/tweet", { url }, budget)) as Record<string, unknown> | null;
  const item = (json?.tweet ?? json?.data ?? json) as Record<string, unknown> | null;
  return item ? xPost({ ...item, rest_id: (item.rest_id as string) ?? m[4] }, m[3]) : null;
}

// ----------------------------------------------------------------- video + Threads

export async function tiktokSearch(query: string, budget?: ScBudget): Promise<SocialPost[]> {
  if (scFakeAllowed()) return fakePosts("tiktok", query, "@creator");
  const json = await scGet("/v1/tiktok/search/keyword", { query }, budget);
  return keep(itemsOf(json, ["search_item_list", "aweme_list", "videos", "data"]).map(tiktokPost), 25);
}

export async function youtubeSearch(query: string, budget?: ScBudget): Promise<SocialPost[]> {
  if (scFakeAllowed()) return fakePosts("youtube", query, "Channel");
  const json = await scGet("/v1/youtube/search", { query }, budget);
  return keep(itemsOf(json, ["videos", "shorts", "results", "data"]).map(youtubePost), 25);
}

export async function threadsSearch(query: string, budget?: ScBudget): Promise<SocialPost[]> {
  if (scFakeAllowed()) return fakePosts("threads", query, "@maker");
  const json = await scGet("/v1/threads/search", { query }, budget);
  return keep(itemsOf(json, ["posts", "threads", "data", "results"]).map(threadsPost), 25);
}

/** Transcript video công khai (< 2 phút với TikTok/IG/X). Cắt 6 000 ký tự. */
export async function transcript(url: string, budget?: ScBudget): Promise<{ url: string; text: string }> {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\.|^m\./, "");
  } catch {
    throw new SocialReadError("Use a full video link.");
  }
  const path =
    host === "youtube.com" || host === "youtu.be" ? "/v1/youtube/video/transcript"
    : host === "tiktok.com" ? "/v1/tiktok/video/transcript"
    : host === "instagram.com" ? "/v2/instagram/media/transcript"
    : host === "x.com" || host === "twitter.com" ? "/v1/twitter/tweet/transcript"
    : null;
  if (!path) throw new SocialReadError("Transcripts work for YouTube, TikTok, Instagram and X videos.");
  if (scFakeAllowed()) return { url, text: "Most founders get this wrong. They post once and wait. Here is what worked for us: one problem, one fix, every day for thirty days." };
  const json = await scGet(path, { url }, budget);
  const root = (json ?? {}) as Record<string, unknown>;
  const raw = root.transcript_only_text ?? root.transcript ?? root.text;
  const text = Array.isArray(raw) ? raw.map((seg) => str((seg as Record<string, unknown>)?.text ?? seg)).join(" ") : str(raw);
  if (!text.trim()) throw new SocialReadError("This video has no transcript.");
  return { url, text: text.replace(/\s+/g, " ").trim().slice(0, 6000) };
}

export async function creditBalance(): Promise<number> {
  if (scFakeAllowed()) return 9_999;
  const json = (await scGet("/v1/credit/balance", {})) as Record<string, unknown> | null;
  return num(json?.creditCount ?? json?.credits ?? json?.balance);
}
