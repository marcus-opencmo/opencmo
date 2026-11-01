import "server-only";

/**
 * Tool research của CMO chat (H2): đọc dữ liệu công khai qua ScrapeCreators để CMO nghiên cứu
 * TRƯỚC khi giao việc. Chỉ đọc. Mỗi lượt có ngân sách lời gọi (`ScBudget`) — model gọi lặp là bị
 * chặn và được bảo tóm tắt. Kết quả rút gọn (top N, trường cần cho trích dẫn + đo lường) và luôn
 * nằm trong `untrusted_data`: nội dung người lạ viết là dữ liệu, không phải lệnh.
 */

import { z } from "zod";

import {
  creditBalance,
  redditSearch,
  redditThread,
  subredditPosts,
  threadsSearch,
  tiktokSearch,
  transcript,
  xProfile,
  xTopPosts,
  youtubeSearch,
} from "@/lib/cmo/social/research";
import { HnBudget, HnReadError, searchHn } from "@/lib/cmo/social/hn";
import { outliers, type ScBudget, SocialReadError, type SocialPost } from "@/lib/cmo/social/scrapecreators";

import type { ToolOutcome, ToolSpec } from "./tools";

/** Lời gọi ScrapeCreators tối đa trong MỘT yêu cầu chat. */
export const RESEARCH_CALLS_PER_TURN = 15;

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const query = { type: "string", description: "Search words, 2-6 words work best." };

export const RESEARCH_TOOL_SPECS: ToolSpec[] = [
  {
    name: "search_reddit",
    description: "Search public Reddit posts. Use it to find people describing a problem, asking for a tool, or comparing alternatives. Returns up to 10 posts with community, title, snippet, score, comment count and URL.",
    schema: obj({ query, sort: { type: "string", enum: ["relevance", "new", "top"] }, timeframe: { type: "string", enum: ["day", "week", "month", "year", "all"] } }, ["query"]),
    strict: false,
  },
  {
    name: "search_hackernews",
    description: "Search Hacker News stories (Ask HN, Show HN, links). Use it to find developers and founders describing a problem or comparing tools. Returns up to 10 stories with title, text, points, comment count and the discussion URL.",
    schema: obj({ query, recent: { type: "boolean", description: "true: newest first, from the last 30 days. Default: most relevant." } }, ["query"]),
    strict: false,
  },
  {
    name: "subreddit_posts",
    description: "Hot or new posts of one subreddit. Subreddit names are case-sensitive (\"SaaS\", not \"saas\"). Use it to learn what a community talks about before planning replies.",
    schema: obj({ subreddit: { type: "string" }, sort: { type: "string", enum: ["hot", "new", "top"] } }, ["subreddit"]),
    strict: false,
  },
  {
    name: "reddit_thread",
    description: "Read one Reddit thread with its top comments. Read the comments: real needs and objections are usually there, not in the title.",
    schema: obj({ url: { type: "string", description: "Full reddit.com/r/.../comments/... link." } }, ["url"]),
    strict: true,
  },
  {
    name: "x_profile",
    description: "Public profile of an X account: name, bio, followers, posts.",
    schema: obj({ handle: { type: "string", description: "X handle, with or without @." } }, ["handle"]),
    strict: true,
  },
  {
    name: "find_outliers",
    description:
      "Find the posts of one account that beat its own baseline. For X it reads about 100 of the account's MOST POPULAR posts (not the latest). Lift = post performance / the account's median (X counts likes + replies + reposts). Labels: huge 5x+, strong 2-5x, mild 1.5-2x. Fewer than 10 posts means low confidence. Use it on competitors and on the founder's own account to learn which hooks and formats work.",
    schema: obj({ platform: { type: "string", enum: ["x"] }, handle: { type: "string" } }, ["platform", "handle"]),
    strict: true,
  },
  {
    name: "search_videos",
    description: "Search public short videos on TikTok or YouTube (YouTube results include long videos). Returns up to 10 with views, likes, author and URL, ranked by lift against the median of the results.",
    schema: obj({ platform: { type: "string", enum: ["tiktok", "youtube"] }, query }, ["platform", "query"]),
    strict: true,
  },
  {
    name: "search_threads",
    description: "Search public Threads posts. Returns up to 10 with likes, replies, author and URL.",
    schema: obj({ query }, ["query"]),
    strict: true,
  },
  {
    name: "get_transcript",
    description: "Transcript of a public YouTube, TikTok, Instagram or X video (TikTok, Instagram and X videos must be under 2 minutes). Use it to study a hook word for word.",
    schema: obj({ url: { type: "string" } }, ["url"]),
    strict: true,
  },
  {
    name: "research_credits",
    description: "Whether social research is available right now. Check before a large research task.",
    schema: obj({}, []),
    strict: true,
  },
];
export const RESEARCH_TOOLS = new Set(RESEARCH_TOOL_SPECS.map((tool) => tool.name));

const inputs = {
  search_reddit: z.object({ query: z.string().trim().min(2).max(120), sort: z.enum(["relevance", "new", "top"]).optional(), timeframe: z.enum(["day", "week", "month", "year", "all"]).optional() }),
  search_hackernews: z.object({ query: z.string().trim().min(2).max(120), recent: z.boolean().optional() }),
  subreddit_posts: z.object({ subreddit: z.string().trim().min(2).max(60), sort: z.enum(["hot", "new", "top"]).optional() }),
  reddit_thread: z.object({ url: z.string().trim().url().max(500) }),
  x_profile: z.object({ handle: z.string().trim().min(1).max(80) }),
  find_outliers: z.object({ platform: z.literal("x"), handle: z.string().trim().min(1).max(80) }),
  search_videos: z.object({ platform: z.enum(["tiktok", "youtube"]), query: z.string().trim().min(2).max(120) }),
  search_threads: z.object({ query: z.string().trim().min(2).max(120) }),
  get_transcript: z.object({ url: z.string().trim().url().max(500) }),
  research_credits: z.object({}).passthrough(),
} satisfies Record<string, z.ZodType>;

const data = (value: unknown) => JSON.stringify({ untrusted_data: value });
const brief = (p: SocialPost) => ({ url: p.url, author: p.author, text: p.text.slice(0, 280), posted_at: p.postedAt, views: p.views, likes: p.likes, replies: p.replies, reposts: p.reposts });

export async function runResearchTool(name: string, raw: unknown, budget: ScBudget): Promise<ToolOutcome> {
  const schema = inputs[name as keyof typeof inputs];
  if (!schema) return { ok: false, content: JSON.stringify({ error: `Unknown tool ${name}.` }), summary: "Unknown tool" };
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues[0]?.message }), summary: "Invalid request" };
  const input = parsed.data as Record<string, string>;
  try {
    switch (name) {
      case "search_reddit": {
        const posts = (await redditSearch(input.query!, budget, { sort: input.sort, timeframe: input.timeframe })).slice(0, 10);
        return { ok: true, content: data(posts.map((p) => ({ url: p.url, community: p.community, title: p.title, snippet: p.text.slice(0, 300), score: p.likes, comments: p.replies, posted_at: p.postedAt }))), summary: `Searched Reddit for “${input.query}” (${posts.length})` };
      }
      case "search_hackernews": {
        // Free and keyless, but it still counts toward the turn's lookups so the model cannot loop on it.
        budget.take();
        const recent = (parsed.data as { recent?: boolean }).recent === true;
        const stories = (await searchHn(input.query!, new HnBudget(1), recent ? { recentDays: 30 } : {})).slice(0, 10);
        return { ok: true, content: data(stories.map((t) => ({ url: t.url, title: t.title, snippet: t.text.slice(0, 300), points: t.points, comments: t.comments, posted_at: t.postedAt }))), summary: `Searched Hacker News for “${input.query}” (${stories.length})` };
      }
      case "subreddit_posts": {
        const posts = (await subredditPosts(input.subreddit!, budget, input.sort ?? "hot")).slice(0, 10);
        return { ok: true, content: data(posts.map((p) => ({ url: p.url, title: p.title, snippet: p.text.slice(0, 200), score: p.likes, comments: p.replies }))), summary: `Read r/${input.subreddit!.replace(/^r\//, "")} (${posts.length})` };
      }
      case "reddit_thread": {
        const thread = await redditThread(input.url!, budget);
        return { ok: true, content: data({ post: thread.post && { title: thread.post.title, text: thread.post.text, community: thread.post.community, comments: thread.post.replies }, top_comments: thread.comments.slice(0, 12) }), summary: "Read a Reddit thread" };
      }
      case "x_profile": {
        const profile = await xProfile(input.handle!, budget);
        return { ok: true, content: data(profile), summary: `Read ${profile.handle} on X` };
      }
      case "find_outliers": {
        const posts = await xTopPosts(input.handle!, budget);
        const result = outliers(posts);
        const top = result.items.filter((p) => p.label !== "normal").slice(0, 8);
        return {
          ok: true,
          content: data({ handle: input.handle, posts_read: posts.length, baseline_engagement: result.baseline, confidence: result.confidence, outliers: top.map((p) => ({ ...brief(p), lift: p.lift, label: p.label })) }),
          summary: `Found ${top.length} outlier posts of ${input.handle!.startsWith("@") ? input.handle : `@${input.handle}`}`,
        };
      }
      case "search_videos": {
        const posts = input.platform === "tiktok" ? await tiktokSearch(input.query!, budget) : await youtubeSearch(input.query!, budget);
        const ranked = outliers(posts).items.slice(0, 10);
        return { ok: true, content: data(ranked.map((p) => ({ ...brief(p), lift: p.lift }))), summary: `Searched ${input.platform === "tiktok" ? "TikTok" : "YouTube"} for “${input.query}” (${ranked.length})` };
      }
      case "search_threads": {
        const posts = (await threadsSearch(input.query!, budget)).slice(0, 10);
        return { ok: true, content: data(posts.map(brief)), summary: `Searched Threads for “${input.query}” (${posts.length})` };
      }
      case "get_transcript": {
        const out = await transcript(input.url!, budget);
        return { ok: true, content: data(out), summary: "Read a video transcript" };
      }
      default: {
        // Only whether research works: the balance is OpenCMO's own ScrapeCreators account, not the
        // founder's, and over MCP it would hand any caller our spend (security fixes plan, fix 5).
        const available = (await creditBalance()) > 0;
        return { ok: true, content: JSON.stringify({ available }), summary: available ? "Research available" : "Research unavailable" };
      }
    }
  } catch (error) {
    const known = error instanceof SocialReadError || error instanceof HnReadError;
    const message = known ? error.message : "Social research failed. Try again in a minute.";
    if (!known) console.error(`[cmo] tool ${name}:`, error);
    return { ok: false, content: JSON.stringify({ error: message }), summary: message };
  }
}
