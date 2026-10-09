/**
 * Client ScrapeCreators chung (H2): đọc dữ liệu CÔNG KHAI của Reddit, X, TikTok, YouTube, Threads
 * cho CMO chat và các job (skill `scrapecreators-api` của social-media-research-skills, MIT).
 * `GET https://api.scrapecreators.com/<path>?…`, header `x-api-key`, mỗi lời gọi ~1 credit.
 *
 * Hình dạng response CHƯA thấy tận mắt: chưa có khoá, và sandbox chặn docs.scrapecreators.com.
 * Nên mọi parser đọc PHÒNG THỦ theo danh sách đường dẫn ứng viên (tên gốc của từng nền tảng:
 * `legacy.full_text` của X, `statistics.play_count` của TikTok…) và bỏ thứ không có link hợp lệ.
 * Có khoá thì gọi mỗi endpoint một lần, lưu response thật làm mẫu trong check, sửa đường dẫn.
 *
 * Không `server-only` để check chạy được; khoá chỉ đọc từ env phía server.
 */

export const SC_BASE = "https://api.scrapecreators.com";
const TIMEOUT_MS = 20_000;

export class SocialReadError extends Error {}

export function scFakeAllowed(): boolean {
  return process.env.OPENCMO_AGENT_FAKE === "1" && process.env.VERCEL_ENV !== "production";
}

/** Đọc được mạng xã hội: có khoá thật, hoặc bản giả (CI/E2E). */
export function socialReaderReady(): boolean {
  return scFakeAllowed() || Boolean(process.env.SCRAPECREATORS_API_KEY);
}

export type Platform = "reddit" | "x" | "tiktok" | "youtube" | "threads" | "instagram";

/** Một bài công khai đã chuẩn hoá — đủ để tính outlier và trích dẫn có URL. */
export type SocialPost = {
  platform: Platform;
  url: string;
  author: string;
  text: string;
  postedAt: string | null;
  views: number;
  likes: number;
  replies: number;
  reposts: number;
};

/** Đếm lời gọi trong một lượt (chat/job): ngân sách credit, chặn vòng lặp gọi mãi. */
export class ScBudget {
  used = 0;
  constructor(readonly limit: number) {}
  take(credits = 1): void {
    if (this.used + credits > this.limit) {
      throw new SocialReadError(`Research limit reached for this request (${this.limit} lookups). Summarize what you found.`);
    }
    this.used += credits;
  }
}

/** Lời gọi thô. `budget` trừ trước khi gọi — lỗi mạng vẫn tính, vì ScrapeCreators có thể đã tính. */
export async function scGet(path: string, params: Record<string, string>, budget?: ScBudget): Promise<unknown> {
  const key = process.env.SCRAPECREATORS_API_KEY;
  if (!key) throw new SocialReadError("Social research is not set up on this server yet.");
  budget?.take();
  const url = `${SC_BASE}${path}?${new URLSearchParams({ ...params, trim: "true" })}`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    throw new SocialReadError("The social network did not answer in time. Try again in a minute.");
  }
  if (response.status === 401 || response.status === 403) {
    console.error("[cmo] scrapecreators: khoá bị từ chối", path, response.status);
    throw new SocialReadError("Social research is not set up on this server yet.");
  }
  if (response.status === 402) throw new SocialReadError("Social research is paused (out of lookup credits). Try again later.");
  if (response.status === 404) throw new SocialReadError("That account or post was not found, or it is private.");
  if (response.status === 429) throw new SocialReadError("Too many lookups right now. Try again in a minute.");
  if (!response.ok) {
    console.error("[cmo] scrapecreators: lỗi", path, response.status);
    throw new SocialReadError("The social network did not answer. Try again in a minute.");
  }
  return response.json().catch(() => null);
}

// ----------------------------------------------------------------- đọc phòng thủ

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
export const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.replace(/,/g, "")) ? Number(v.replace(/,/g, "")) : 0;

/** Giá trị ở đường dẫn "a.b.c". */
function at(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const part of path.split(".")) {
    if (!isObj(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}
const first = (o: unknown, paths: string[]): unknown => {
  for (const p of paths) {
    const v = at(o, p);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

/** Mảng phần tử đầu tiên tìm thấy ở các khoá ứng viên (cả `data.children[].data` kiểu Reddit). */
export function itemsOf(json: unknown, keys: string[]): Obj[] {
  if (Array.isArray(json)) return json.filter(isObj);
  for (const key of keys) {
    const v = at(json, key);
    if (Array.isArray(v)) return v.map((x) => (isObj(x) && isObj(x.data) && "kind" in x ? x.data : x)).filter(isObj);
    if (isObj(v) && Array.isArray(v.children)) return v.children.map((c) => (isObj(c) && isObj(c.data) ? c.data : c)).filter(isObj);
  }
  return [];
}

export function isoTime(v: unknown): string | null {
  const n = num(v);
  if (n > 1e9) return new Date(n > 1e12 ? n : n * 1000).toISOString();
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Chỉ https, đúng host của nền tảng; bỏ query/hash để khử trùng và không mang token theo dõi. */
export function safeUrl(raw: string, hosts: RegExp): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || !hosts.test(u.hostname)) return null;
    u.hash = "";
    if (!/youtube\.com$/.test(u.hostname)) u.search = "";
    return u.toString().slice(0, 500);
  } catch {
    return null;
  }
}

const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

// ----------------------------------------------------------------- chuẩn hoá theo nền tảng

const HOSTS: Record<Platform, RegExp> = {
  reddit: /^(www\.|old\.)?reddit\.com$/,
  x: /^(www\.)?(x|twitter)\.com$/,
  tiktok: /^(www\.|m\.)?tiktok\.com$/,
  youtube: /^(www\.|m\.)?youtube\.com$|^youtu\.be$/,
  threads: /^(www\.)?threads\.(net|com)$/,
  instagram: /^(www\.)?instagram\.com$/,
};

export function xPost(item: Obj, handle = ""): SocialPost | null {
  const t = isObj(item.tweet) ? item.tweet : item;
  const user = str(first(t, ["core.user_results.result.legacy.screen_name", "core.user_results.result.core.screen_name", "user.screen_name", "author.screen_name", "author.username", "username"])) || handle;
  const id = str(first(t, ["rest_id", "legacy.id_str", "id_str", "id"]));
  const url = safeUrl(str(first(t, ["url", "tweet_url"])) || (id && user ? `https://x.com/${user}/status/${id}` : ""), HOSTS.x);
  const text = str(first(t, ["legacy.full_text", "full_text", "note_tweet.note_tweet_results.result.text", "text"]));
  if (!url || !text) return null;
  return {
    platform: "x",
    url,
    author: user ? `@${user.replace(/^@/, "")}` : "",
    text: clean(text, 600),
    postedAt: isoTime(first(t, ["legacy.created_at", "created_at"])),
    views: num(first(t, ["views.count", "view_count", "views"])),
    likes: num(first(t, ["legacy.favorite_count", "favorite_count", "like_count", "likes"])),
    replies: num(first(t, ["legacy.reply_count", "reply_count", "replies"])),
    reposts: num(first(t, ["legacy.retweet_count", "retweet_count", "retweets"])) + num(first(t, ["legacy.quote_count", "quote_count"])),
  };
}

export function tiktokPost(item: Obj): SocialPost | null {
  const v = isObj(item.aweme_info) ? item.aweme_info : item;
  const user = str(first(v, ["author.unique_id", "author.uniqueId", "author.username"]));
  const id = str(first(v, ["aweme_id", "id"]));
  const url = safeUrl(str(first(v, ["share_url", "url"])) || (id && user ? `https://www.tiktok.com/@${user}/video/${id}` : ""), HOSTS.tiktok);
  if (!url) return null;
  return {
    platform: "tiktok",
    url,
    author: user ? `@${user}` : "",
    text: clean(str(first(v, ["desc", "description", "title"])), 600),
    postedAt: isoTime(first(v, ["create_time", "createTime"])),
    views: num(first(v, ["statistics.play_count", "stats.playCount", "play_count"])),
    likes: num(first(v, ["statistics.digg_count", "stats.diggCount", "digg_count"])),
    replies: num(first(v, ["statistics.comment_count", "stats.commentCount", "comment_count"])),
    reposts: num(first(v, ["statistics.share_count", "stats.shareCount", "share_count"])),
  };
}

export function youtubePost(item: Obj): SocialPost | null {
  const id = str(first(item, ["id", "videoId"]));
  const url = safeUrl(str(first(item, ["url", "link"])) || (id ? `https://www.youtube.com/watch?v=${id}` : ""), HOSTS.youtube);
  const title = str(first(item, ["title", "title.runs.0.text"]));
  if (!url || !title) return null;
  return {
    platform: "youtube",
    url,
    author: str(first(item, ["channel.title", "channel.name", "channelTitle", "author"])),
    text: clean(title, 400),
    postedAt: isoTime(first(item, ["publishedTime", "publishDate", "published_at", "uploadDate"])),
    views: num(first(item, ["viewCountInt", "viewCount", "views"])),
    likes: num(first(item, ["likeCountInt", "likeCount", "likes"])),
    replies: num(first(item, ["commentCountInt", "commentCount"])),
    reposts: 0,
  };
}

export function threadsPost(item: Obj): SocialPost | null {
  const p = isObj(item.post) ? item.post : item;
  const user = str(first(p, ["user.username", "username"]));
  const code = str(first(p, ["code"]));
  const url = safeUrl(str(first(p, ["url"])) || (code && user ? `https://www.threads.net/@${user}/post/${code}` : ""), HOSTS.threads);
  const text = str(first(p, ["caption.text", "text"]));
  if (!url || !text) return null;
  return {
    platform: "threads",
    url,
    author: user ? `@${user}` : "",
    text: clean(text, 600),
    postedAt: isoTime(first(p, ["taken_at", "created_at"])),
    views: num(first(p, ["view_count", "play_count"])),
    likes: num(first(p, ["like_count"])),
    replies: num(first(p, ["text_post_app_info.direct_reply_count", "reply_count"])),
    reposts: num(first(p, ["text_post_app_info.repost_count", "repost_count"])),
  };
}

export type RedditComment = { author: string; text: string; score: number };

export function redditPost(item: Obj): (SocialPost & { community: string; title: string }) | null {
  const permalink = str(item.permalink);
  const url = safeUrl(permalink.startsWith("/") ? `https://www.reddit.com${permalink}` : permalink || str(item.url) || str(item.link), HOSTS.reddit);
  const title = str(item.title).trim();
  if (!url || !title) return null;
  const sub = str(item.subreddit_name_prefixed) || (str(item.subreddit) ? `r/${str(item.subreddit).replace(/^r\//, "")}` : "");
  const author = str(item.author);
  return {
    platform: "reddit",
    url: url.replace(/^https:\/\/(old\.)?reddit/, "https://www.reddit"),
    community: sub.slice(0, 100),
    title: clean(title, 400),
    author: author ? (author.startsWith("u/") ? author : `u/${author}`).slice(0, 100) : "",
    text: clean(str(first(item, ["selftext", "body", "text"])), 1500),
    postedAt: isoTime(first(item, ["created_utc", "created", "created_at"])),
    views: 0,
    likes: num(first(item, ["score", "ups"])),
    replies: num(first(item, ["num_comments", "comments", "comment_count"])),
    reposts: 0,
  };
}

// ----------------------------------------------------------------- outlier (outlier-post-finder)

export type Outlier = SocialPost & { lift: number; label: "huge" | "strong" | "mild" | "normal" };

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Video đo bằng view; nền tảng chữ (X, Threads, Reddit) đo bằng like + reply + repost. */
export const performance = (post: SocialPost): number =>
  post.platform === "tiktok" || post.platform === "youtube" || post.platform === "instagram" ? post.views : post.likes + post.replies + post.reposts;

/**
 * Lift = hiệu suất / MEDIAN của chính tài khoản/tập (không dùng trung bình: một bài viral kéo lệch).
 * Nhãn của outlier-post-finder: Huge ≥5x, Strong 2–5x, Mild 1.5–2x. Dưới 10 bài thì kết quả kém tin.
 */
export function outliers(posts: SocialPost[]): { baseline: number; confidence: "low" | "ok"; items: Outlier[] } {
  const scores = posts.map(performance);
  const baseline = median(scores);
  const items = posts
    .map((post, i) => {
      const lift = baseline > 0 ? scores[i]! / baseline : 0;
      const label: Outlier["label"] = lift >= 5 ? "huge" : lift >= 2 ? "strong" : lift >= 1.5 ? "mild" : "normal";
      return { ...post, lift: Math.round(lift * 10) / 10, label };
    })
    .sort((a, b) => b.lift - a.lift);
  return { baseline, confidence: posts.length < 10 ? "low" : "ok", items };
}
