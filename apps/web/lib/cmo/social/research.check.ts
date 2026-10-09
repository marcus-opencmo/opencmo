/**
 * Kiểm client ScrapeCreators + bộ research (H2): parser phòng thủ trên các hình dạng ứng viên
 * (chưa có response thật — xem đầu `scrapecreators.ts`), URL chỉ đúng host, outlier theo median,
 * ngân sách lời gọi, lỗi HTTP ra câu tiếng Anh. Không mạng: `fetch` thay bằng bản ghi sẵn.
 */

import assert from "node:assert/strict";

import { redditSearch, transcript, xTopPosts } from "./research";
import { itemsOf, outliers, ScBudget, safeUrl, scGet, SocialReadError, threadsPost, tiktokPost, xPost, youtubePost, type SocialPost } from "./scrapecreators";

async function main() {
  // X: dạng GraphQL (`legacy`) và dạng phẳng; không id/handle thì bỏ.
  const graph = xPost({ rest_id: "123", legacy: { full_text: "Ship it", favorite_count: 40, reply_count: 5, retweet_count: 3, quote_count: 2, created_at: "Mon Oct 05 10:00:00 +0000 2026" }, views: { count: "1200" }, core: { user_results: { result: { legacy: { screen_name: "maker" } } } } }, "maker");
  assert.deepEqual([graph?.url, graph?.likes, graph?.replies, graph?.reposts, graph?.views, graph?.author], ["https://x.com/maker/status/123", 40, 5, 5, 1200, "@maker"]);
  assert.equal(xPost({ text: "flat", id: "9", like_count: 3 }, "who")?.url, "https://x.com/who/status/9");
  assert.equal(xPost({ text: "no id" }), null);

  // TikTok / YouTube / Threads.
  const tk = tiktokPost({ aweme_info: { aweme_id: "77", desc: "Hook", author: { unique_id: "chef" }, statistics: { play_count: 5000, digg_count: 300, comment_count: 12, share_count: 4 }, create_time: 1_790_000_000 } });
  assert.deepEqual([tk?.url, tk?.views, tk?.likes], ["https://www.tiktok.com/@chef/video/77", 5000, 300]);
  assert.equal(youtubePost({ id: "abc", title: "How we grew", viewCountInt: 9000 })?.url, "https://www.youtube.com/watch?v=abc", "giữ ?v= của YouTube");
  assert.equal(threadsPost({ post: { code: "C1", user: { username: "ana" }, caption: { text: "Hi" }, like_count: 2 } })?.url, "https://www.threads.net/@ana/post/C1");

  // Chỉ https và đúng host; bỏ query/hash.
  assert.equal(safeUrl("https://x.com/a/status/1?s=20#top", /^(www\.)?x\.com$/), "https://x.com/a/status/1");
  assert.equal(safeUrl("http://x.com/a", /^(www\.)?x\.com$/), null);
  assert.equal(safeUrl("https://evil.com/x.com", /^(www\.)?x\.com$/), null);

  // itemsOf: mảng trực tiếp, khoá ứng viên, kiểu Reddit `data.children[].data`.
  assert.equal(itemsOf([{ a: 1 }], []).length, 1);
  assert.equal(itemsOf({ tweets: [{ a: 1 }, null] }, ["tweets"]).length, 1);
  assert.equal(itemsOf({ data: { children: [{ kind: "t3", data: { title: "x" } }] } }, ["data"])[0]!.title, "x");

  // Outlier: median (một bài viral không kéo lệch), nhãn theo lift, < 10 bài = low.
  const mk = (likes: number, i: number): SocialPost => ({ platform: "x", url: `https://x.com/a/status/${i}`, author: "@a", text: "", postedAt: null, views: 0, likes, replies: 0, reposts: 0 });
  const set = [1000, 250, 160, 100, 100, 100, 100, 100, 100, 100, 90, 80].map(mk);
  const result = outliers(set);
  assert.equal(result.baseline, 100);
  assert.equal(result.confidence, "ok");
  assert.deepEqual(result.items.slice(0, 3).map((p) => [p.lift, p.label]), [[10, "huge"], [2.5, "strong"], [1.6, "mild"]]);
  assert.equal(outliers(set.slice(0, 5)).confidence, "low");
  // Video đo bằng view.
  const vids = outliers([{ ...mk(1, 1), platform: "tiktok", views: 100 }, { ...mk(1, 2), platform: "tiktok", views: 600 }, { ...mk(1, 3), platform: "tiktok", views: 100 }]);
  assert.equal(vids.items[0]!.lift, 6);

  // Ngân sách: lời gọi thứ N+1 bị chặn với câu bảo model tóm tắt.
  const budget = new ScBudget(2);
  budget.take();
  budget.take();
  assert.throws(() => budget.take(), (e: unknown) => e instanceof SocialReadError && /Summarize/.test(e.message));

  // HTTP thật (fetch giả): header x-api-key, trim=true, mã lỗi → câu tiếng Anh.
  const realFetch = globalThis.fetch;
  const calls: { url: string; key: string | null }[] = [];
  let status = 200;
  let body: unknown = {};
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), key: new Headers(init?.headers).get("x-api-key") });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  process.env.SCRAPECREATORS_API_KEY = "sc-test";
  delete process.env.OPENCMO_AGENT_FAKE;
  try {
    body = { tweets: [{ rest_id: "1", legacy: { full_text: "a", favorite_count: 9 } }, { rest_id: "2", legacy: { full_text: "b", favorite_count: 1 } }] };
    const posts = await xTopPosts("@Maker_1", new ScBudget(5));
    assert.equal(posts.length, 2);
    assert.match(calls[0]!.url, /\/v1\/twitter\/user-tweets\?handle=Maker_1&trim=true$/);
    assert.equal(calls[0]!.key, "sc-test");

    body = { posts: [{ title: "Late invoices", permalink: "/r/freelance/comments/x1/late/", num_comments: 7 }] };
    assert.equal((await redditSearch("late invoices"))[0]!.replies, 7);

    body = { transcript: [{ text: "Hello" }, { text: "world" }] };
    assert.equal((await transcript("https://www.youtube.com/watch?v=abc")).text, "Hello world");
    await assert.rejects(transcript("https://vimeo.com/1"), SocialReadError);

    for (const [code, pattern] of [[401, /not set up/], [402, /paused/], [404, /not found/], [429, /Too many/], [500, /did not answer/]] as const) {
      status = code;
      await assert.rejects(scGet("/v1/x", {}), (e: unknown) => e instanceof SocialReadError && pattern.test(e.message));
    }
    status = 200;
    await assert.rejects(xTopPosts("not a handle!"), SocialReadError, "handle sai không gọi mạng");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SCRAPECREATORS_API_KEY;
  }

  // Bản giả (CI/E2E): có outlier để màn hình và eval có cái để nói.
  process.env.OPENCMO_AGENT_FAKE = "1";
  const fake = outliers(await xTopPosts("founder"));
  assert.equal(fake.items[0]!.label, "huge");
  delete process.env.OPENCMO_AGENT_FAKE;

  console.log("research.check — ScrapeCreators: parser, URL, outlier, ngân sách, lỗi HTTP đều đúng.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
