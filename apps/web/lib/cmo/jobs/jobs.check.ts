/**
 * Kiểm hàng đợi việc CMO không cần Supabase: store trong bộ nhớ + LLM giả.
 * Chạy: `NODE_OPTIONS=--conditions=react-server tsx lib/cmo/jobs/jobs.check.ts` (trong check:contracts).
 */

import assert from "node:assert/strict";

process.env.OPENCMO_AGENT_FAKE = "1";

import { checkPost } from "./check-post";
import { mondayOf } from "./summarize-memory";
import { knownNumbers, recall } from "./context";
import { pickDueItem } from "./draft-post";
import { toPlanItems } from "./plan-week";
import { drainCmoQueue } from "./runner";
import { PASS_SCORE, quoteIn, reachScore, scoreThread, timingScore } from "./sales-scan";
import { parseRedditSearch } from "../social/reddit";
import { checkCaptions } from "./video-pack";
import { memoryStore } from "./memory-store";
import { isoDay, type ClipJob, type Documents, type ItemRow, type MemoryEvent, type PlatformCaptions } from "./types";

async function main() {
  const docs: Documents = {
    product: { name: "Paylane", one_liner: "Invoicing that chases late payments.", pricing: "$12/month" },
    strategy: { icp: "Freelancers who invoice 3–15 clients a month", avoid: ["revolutionary", "game-changer"] },
    content_strategy: { pillars: [{ name: "Getting paid", ideas: ["The 3-7-14 reminder rule", "Why invoices go unpaid"] }] },
  };

  // checkPost: độ dài, từ cấm, số bịa (số ≥ 10 hoặc % phải có trong document).
  const known = knownNumbers(docs);
  assert.deepEqual(checkPost("Reminders on day 3, 7 and 14.", { avoid: [], known }), [], "số nhỏ và số có trong document được phép");
  assert.ok(checkPost("x".repeat(281), { avoid: [], known })[0].includes("281 characters"), "quá 280 ký tự");
  assert.ok(checkPost("A revolutionary way to invoice", { avoid: ["revolutionary"], known }).some((m) => m.includes("revolutionary")), "từ cấm");
  assert.ok(checkPost("We grew 340% last month", { avoid: [], known }).some((m) => m.includes("340%")), "phần trăm bịa");
  assert.ok(checkPost("Used by 5,000 freelancers", { avoid: [], known }).some((m) => m.includes("5,000")), "số lớn bịa");
  assert.deepEqual(checkPost("Plans start at $12/month.", { avoid: [], known }), [], "giá có trong document");
  assert.deepEqual(checkPost("Since 2024 we invoice.", { avoid: [], known }), [], "năm không tính là số bịa");

  // toPlanItems: kẹp ngày 0–6, ép nền tảng theo department.
  const today = new Date(Date.UTC(2026, 9, 5));
  const plan = toPlanItems({ items: [
    { day_offset: 9, department: "post", platform: "LinkedIn", idea: " Launch ", reason: "r" },
    { day_offset: -2, department: "video", platform: "YouTube", idea: "Clip", reason: "r" },
    { day_offset: 1, department: "sales", platform: "x", idea: "Thread", reason: "r" },
  ] }, today);
  assert.deepEqual(plan.map((p) => [p.day, p.platform, p.idea]), [["2026-10-11", "X", "Launch"], ["2026-10-05", "Shorts", "Clip"], ["2026-10-06", "Reddit", "Thread"]]);

  // pickDueItem: mục X planned cũ nhất có ngày ≤ hôm nay.
  const mk = (day: string, status: ItemRow["status"], department: ItemRow["department"] = "post") =>
    ({ id: day + status + department, day, status, department }) as ItemRow;
  assert.equal(pickDueItem([mk("2026-10-07", "planned"), mk("2026-10-04", "planned"), mk("2026-10-03", "planned", "sales")], "2026-10-05")?.day, "2026-10-04");
  assert.equal(pickDueItem([mk("2026-10-07", "planned")], "2026-10-05"), null, "chưa tới hạn");

  // W1 rồi W2 chạy hết hàng đợi với LLM giả.
  const mem = memoryStore(docs);
  const w1 = mem.enqueue("plan_week");
  const w2 = mem.enqueue("post_draft");
  assert.equal(await drainCmoQueue(mem.store), 2, "chạy hai lượt");
  assert.equal(w1.status, "done", `W1 xong (${w1.error})`);
  assert.ok(w1.steps.every((s) => s.status === "done"), "mọi bước W1 xong");
  assert.deepEqual(w1.steps.map((s) => s.tool), ["read_doc", "get_results", "plan_items", "write_calendar"]);
  assert.ok(mem.items.filter((i) => i.status === "planned").length >= 5, "lịch có ít nhất 5 mục");

  assert.equal(w2.status, "done", `W2 xong (${w2.error})`);
  assert.deepEqual(w2.steps.map((s) => s.tool), ["next_due_item", "read_doc", "draft_post", "check_post", "create_card"]);
  const card = mem.items.find((i) => i.status === "in_review");
  assert.ok(card, "có thẻ chờ duyệt");
  assert.ok(typeof card!.body.text === "string" && (card!.body.text as string).length <= 280, "bài ≤ 280 ký tự");
  assert.equal(card!.day, isoDay(), "lấy mục tới hạn hôm nay");
  assert.equal((card!.body.alternates as string[]).length, 2, "kèm 2 phiên bản khác");

  // Lượt mất lease giữa chừng: dừng im lặng, không ghi kết quả.
  const mem2 = memoryStore(docs);
  const lost = mem2.enqueue("plan_week");
  const realStep = mem2.store.step;
  mem2.store.step = async (run, steps) => (steps.length > 1 ? false : realStep(run, steps));
  await drainCmoQueue(mem2.store);
  assert.equal(lost.status, "running", "mất lease thì không tự đánh dấu xong/hỏng");

  // W4: parse ScrapeCreators phòng thủ — ba hình dạng, bỏ link không phải reddit.com.
  const now = Date.UTC(2026, 9, 5, 12);
  const shapes = [
    { posts: [{ title: "Clients pay late", permalink: "/r/freelance/comments/a1/late/", subreddit: "freelance", author: "mo", selftext: "I hate chasing", num_comments: 12, created_utc: now / 1000 - 3600 }] },
    { data: { children: [{ data: { title: "Invoice tool?", url: "https://old.reddit.com/r/smallbusiness/comments/b2/tool?utm=x", subreddit_name_prefixed: "r/smallbusiness", num_comments: "4" } }] } },
    { results: [{ title: "Spam", url: "https://evil.example/r/x" }, { title: "", permalink: "/r/x/comments/c3/" }, { title: "Ok", link: "https://www.reddit.com/r/x/comments/d4/ok", created_at: "2026-10-01T00:00:00Z" }] },
  ];
  const parsed = shapes.map(parseRedditSearch);
  assert.deepEqual(parsed.map((p) => p.length), [1, 1, 1], "mỗi hình dạng ra đúng số thread hợp lệ");
  assert.equal(parsed[0][0].url, "https://www.reddit.com/r/freelance/comments/a1/late/");
  assert.equal(parsed[0][0].community, "r/freelance");
  assert.equal(parsed[0][0].author, "u/mo");
  assert.equal(parsed[1][0].url, "https://www.reddit.com/r/smallbusiness/comments/b2/tool", "chuẩn hoá host, bỏ query");
  assert.equal(parsed[1][0].comments, 4);
  assert.equal(parsed[2][0].postedAt, "2026-10-01T00:00:00.000Z");
  assert.deepEqual(parseRedditSearch(null), []);

  // W4: điểm đo được bằng code, và bằng chứng phải là câu trích có thật.
  assert.equal(timingScore(new Date(now - 5 * 3_600_000).toISOString(), now).score, 20);
  assert.equal(timingScore(new Date(now - 10 * 86_400_000).toISOString(), now).score, 4);
  assert.equal(timingScore(null, now).score, 8);
  assert.deepEqual([0, 3, 20, 80].map((c) => reachScore(c).score), [4, 7, 13, 15]);
  const thread = parsed[0][0];
  assert.ok(quoteIn("i HATE   chasing", thread), "trích không phân biệt hoa thường/khoảng trắng");
  assert.ok(!quoteIn("I love chasing", thread), "câu bịa không tính");
  const bogus = scoreThread(thread, { index: 0, exclude: false, pain: { score: 25, quote: "made up pain" }, fit: { score: 99, why: "fits" }, evidence: { score: 15, quote: "made up" } }, now);
  assert.equal(bogus!.parts.find((p) => p.label === "Pain")!.score, 0, "pain không trích được thì 0");
  assert.equal(bogus!.parts.find((p) => p.label === "Fit")!.score, 25, "fit bị kẹp ở 25");
  assert.equal(scoreThread(thread, { index: 0, exclude: true, pain: { score: 25, quote: "" }, fit: { score: 25, why: "" }, evidence: { score: 15, quote: "" } }, now), null, "exclude thì bỏ");

  // W4 chạy hết với Reddit + LLM giả: ≤ 5 thẻ, mỗi thẻ có trả lời và điểm ≥ 60; lượt sau không lặp thread.
  const mem3 = memoryStore({ ...docs, strategy: { ...docs.strategy, pains: ["late invoice payments", "chasing clients"] } });
  const w4 = mem3.enqueue("sales_scan");
  await drainCmoQueue(mem3.store);
  assert.equal(w4.status, "done", `W4 xong (${w4.error})`);
  assert.deepEqual(w4.steps.map((s) => s.tool), ["read_doc", "make_queries", "reddit_search", "score_thread", "draft_reply", "create_card"]);
  assert.ok(mem3.opps.length > 0 && mem3.opps.length <= 5, `1–5 thẻ (${mem3.opps.length})`);
  assert.ok(mem3.opps.every((o) => o.score >= PASS_SCORE && o.reply.length > 0 && o.score_parts.length === 5), "thẻ đủ điểm, có trả lời");
  assert.ok(mem3.opps.every((o) => new URL(o.url).hostname === "www.reddit.com"), "chỉ link reddit.com");
  assert.equal((w4.output as { refund: boolean }).refund, false);

  const again = mem3.enqueue("sales_scan");
  const before = mem3.opps.length;
  await drainCmoQueue(mem3.store);
  assert.equal(again.status, "done");
  assert.ok(mem3.opps.length >= before, "lượt sau không xoá thẻ cũ");
  assert.equal(new Set(mem3.opps.map((o) => o.url)).size, mem3.opps.length, "không thread nào hai lần");

  // Không thread mới nào: lượt vẫn xong và được hoàn credit.
  const mem4 = memoryStore(docs);
  mem4.store.seenUrls = async () => ({ has: () => true }) as unknown as Set<string>;
  const empty = mem4.enqueue("sales_scan");
  await drainCmoQueue(mem4.store);
  assert.equal(empty.status, "done", `lượt rỗng vẫn xong (${empty.error})`);
  assert.deepEqual(empty.output, { cards: 0, refund: true }, "lượt rỗng hoàn credit");
  assert.equal(empty.steps.at(-1)!.label, "No conversations worth joining today");

  // W5: chờ job clip (hoãn, không tính lần thử) → xong thì viết caption năm nền tảng và ghi thẻ.
  const mem5 = memoryStore(docs);
  const started = new Date().toISOString();
  mem5.jobs.set("job1", { status: "running", error: null, createdAt: started, title: "Talk", clips: [] });
  const w5 = mem5.enqueue("video_pack", { job_id: "job1" });
  await drainCmoQueue(mem5.store);
  assert.equal(w5.status, "queued", "job chưa xong: lượt về hàng đợi");
  assert.equal(w5.attempt, 0, "lần chờ không tính vào trần");
  assert.ok(w5.notBefore && w5.notBefore > Date.now(), "có mốc hoãn");
  assert.equal(w5.steps[0]?.status, "running", "bước chờ vẫn 'running', không 'failed'");
  assert.equal(await drainCmoQueue(mem5.store), 0, "chưa tới mốc thì không chạy lại");
  mem5.jobs.set("job1", {
    status: "done", error: null, createdAt: started, title: "Talk",
    clips: [1, 2, 3].map((n) => ({ id: `c${n}`, idx: n, hook: `Hook ${n}`, reason: "Strong moment", start: n * 60, end: n * 60 + 35, score: 80, text: "Clients paid on day 7." })),
  });
  w5.notBefore = 0;
  await drainCmoQueue(mem5.store);
  assert.equal(w5.status, "done", `W5 xong (${w5.error})`);
  assert.deepEqual(w5.steps.map((s) => s.tool), ["wait_clips", "read_doc", "write_captions", "create_card"]);
  assert.equal(mem5.packs.length, 1, "một thẻ gói video");
  assert.deepEqual(Object.keys(mem5.packs[0]!.captions).sort(), ["c1", "c2", "c3"]);
  for (const set of Object.values(mem5.packs[0]!.captions)) {
    assert.deepEqual(Object.keys(set).sort(), ["facebook", "reels", "shorts", "threads", "tiktok"], "đủ năm nền tảng");
  }

  // Job hỏng: lượt hỏng (credit hoàn ở complete_cmo_run), câu lỗi hiện được cho người dùng.
  const mem6 = memoryStore(docs);
  mem6.jobs.set("bad", { status: "failed", error: "The video is private.", createdAt: started, title: null, clips: [] });
  const w6 = mem6.enqueue("video_pack", { job_id: "bad" });
  await drainCmoQueue(mem6.store);
  assert.equal(w6.status, "failed");
  assert.match(String(w6.error), /The video is private/);

  // checkCaptions: độ dài theo nền tảng, từ cấm, số bịa (số có trong lời clip thì được).
  const ok: PlatformCaptions = { tiktok: "Paid on day 7.", reels: "Paid on day 7.\n#freelance", shorts: "Get paid on time", facebook: "Would this work for you?", threads: "Get paid sooner." };
  assert.deepEqual(checkCaptions(ok, { avoid: ["revolutionary"], known: new Set(), spoken: "" }), []);
  assert.ok(checkCaptions({ ...ok, shorts: "x".repeat(101) }, { avoid: [], known: new Set(), spoken: "" })[0]!.includes("shorts"));
  assert.ok(checkCaptions({ ...ok, tiktok: "A revolutionary tool" }, { avoid: ["revolutionary"], known: new Set(), spoken: "" }).length === 1);
  assert.ok(checkCaptions({ ...ok, threads: "We grew 340%" }, { avoid: [], known: new Set(), spoken: "" }).length === 1, "phần trăm bịa");
  assert.deepEqual(checkCaptions({ ...ok, threads: "Saved 45 hours" }, { avoid: [], known: new Set(), spoken: "we saved 45 hours" }), [], "số có trong lời clip");

  // CMO chat không bao giờ có tool đăng/trả lời: mọi thứ ra ngoài đi qua Approvals.
  const { CMO_TOOL_SPECS } = await import("../../agent/cmo-tools");
  const names = CMO_TOOL_SPECS.map((t) => t.name);
  assert.deepEqual(names.slice(0, 5), ["read_doc", "list_calendar", "list_approvals", "create_task", "remember"]);
  assert.ok(names.includes("search_reddit") && names.includes("find_outliers"), "có tool research");
  // Tool research chỉ ĐỌC (vd. subreddit_posts đọc bài); còn lại không tên nào là đăng/gửi.
  const { RESEARCH_TOOLS } = await import("../../agent/cmo-research");
  assert.ok(!names.some((n) => !RESEARCH_TOOLS.has(n) && /post|publish|reply|schedule|send|like|follow/.test(n)), "không có tool đăng");

  // Thư viện marketingskills (library/): chỉ CMO chat đọc, có đoạn mở đầu, chỉ mục gọn.
  const { CMO_SKILLS } = await import("../skills/index.gen");
  const { skillIndex, skillText, LIBRARY_PREAMBLE } = await import("../skills");
  const all = Object.values(CMO_SKILLS) as { name: string; kind: string; agents: readonly string[] }[];
  const lib = all.filter((s) => s.kind === "library");
  assert.equal(lib.length, 38, "38 skill thư viện");
  assert.ok(lib.every((s) => s.agents.length === 1 && s.agents[0] === "cmo"), "thư viện chỉ cho CMO chat, không lọt vào job");
  assert.ok(skillText("launch").includes(LIBRARY_PREAMBLE) && !skillText("x-writing").includes(LIBRARY_PREAMBLE));
  const index = skillIndex("cmo");
  assert.ok(index.length < 12_000, `chỉ mục CMO ${index.length} ký tự`);
  assert.ok(index.indexOf("- x-writing:") < index.indexOf("- social:"), "playbook đứng trước thư viện");
  assert.equal(skillIndex("x_writer").includes("<library>"), false);
  const readSkill = CMO_TOOL_SPECS.find((t) => t.name === "read_skill")!;
  const allowed = (readSkill.schema as { properties: { name: { enum: string[] } } }).properties.name.enum;
  for (const name of ["launch", "pricing", "seo-audit", "marketing-plan", "x-writing"]) assert.ok(allowed.includes(name), `read_skill đọc được ${name}`);
  assert.ok(names.includes("read_site"), "CMO đọc được website để nhận xét SEO");

  // W7: handle lấy từ Competitor Analysis + input, khử trùng, tối đa 4.
  const { watchedHandles, groundInsight } = await import("./competitor-research");
  assert.deepEqual(
    watchedHandles({ competitors: { competitors: [{ x_handle: "@FreshBooks" }, { x_handle: "https://x.com/wave/status/1" }, { x_handle: "not a handle!" }] } }, { handles: ["freshbooks", "zoho"] }),
    ["freshbooks", "zoho", "wave"],
  );
  // Tự kiểm: hook/ý tưởng trỏ URL không có trong bài đã đọc bị bỏ.
  const readPost = { platform: "x" as const, url: "https://x.com/a/status/1", author: "@a", text: "Stop chasing invoices.\nDo this.", postedAt: null, views: 0, likes: 50, replies: 0, reposts: 0, lift: 5, label: "huge" as const };
  const grounded = groundInsight(
    { hooks: [{ pattern: "Stop X", url: readPost.url, why: "pain" }, { pattern: "Made up", url: "https://x.com/z/status/9", why: "?" }], formats: ["list"], ideas: [{ idea: "i", inspired_by: "https://x.com/z/status/9" }] },
    [readPost],
  );
  assert.equal(grounded.hooks.length, 1);
  assert.equal(grounded.hooks[0]!.example, "Stop chasing invoices.");
  assert.equal(grounded.ideas.length, 0, "ý tưởng không có nguồn thật bị bỏ");

  // W7 chạy đủ (ScrapeCreators + model giả): insight có hook kèm URL; không handle → lỗi nói rõ cách sửa.
  const mem7 = memoryStore({ ...docs, competitors: { competitors: [{ name: "FreshBooks", website: "", difference: "", x_handle: "freshbooks" }] } });
  const w7 = mem7.enqueue("competitor_research");
  await drainCmoQueue(mem7.store);
  assert.equal(w7.status, "done", `W7 xong (${w7.error})`);
  assert.deepEqual(w7.steps.map((s) => s.tool), ["read_doc", "find_outliers", "extract_patterns", "save_insight"]);
  assert.ok(mem7.insights[0]!.hooks.every((h) => h.url.startsWith("https://x.com/freshbooks/status/")));
  const mem7b = memoryStore(docs);
  const w7b = mem7b.enqueue("competitor_research");
  await drainCmoQueue(mem7b.store);
  assert.equal(w7b.status, "failed");
  assert.match(String(w7b.error), /X handles/);

  // Insight vào prompt của Planner/X writer; quá 21 ngày thì không.
  const { insightBlock } = await import("./context");
  assert.match(insightBlock(mem7.insights[0]!), /what_works_now/);
  assert.equal(insightBlock({ ...mem7.insights[0]!, measured_at: new Date(Date.now() - 30 * 86_400_000).toISOString() }), "");

  // W6-lite: bài có link đọc theo link; chỉ ghi bài published.
  const { matchPosts } = await import("./pull-metrics");
  const published: ItemRow = { ...mem7.items[0] ?? ({} as ItemRow), id: "p1", run_id: null, department: "post", platform: "X", day: isoDay(), idea: "x", reason: "", status: "published", priority: "medium", body: { text: "The invoice isn't late. The reminder is." }, final_text: null, external_url: "https://x.com/me/status/42", decided_at: null, published_at: new Date().toISOString(), created_at: new Date().toISOString() };
  assert.equal(matchPosts([published], [{ ...readPost, url: "https://x.com/me/status/42" }]).length, 1, "khớp theo id trong link");
  assert.equal(matchPosts([{ ...published, external_url: null }], [{ ...readPost, url: "https://x.com/me/status/7", text: "The invoice isn't late. The reminder is. More text" }]).length, 1, "khớp theo đầu câu");
  const mem6b = memoryStore(docs);
  mem6b.items.push(published);
  const w6b = mem6b.enqueue("pull_metrics");
  await drainCmoQueue(mem6b.store);
  assert.equal(w6b.status, "done", `W6 xong (${w6b.error})`);
  assert.equal(mem6b.metrics.length, 1);
  assert.equal(mem6b.metrics[0]!.likes, 37);

  // Vòng lặp: thứ Hai lập tuần + soạn; Chủ nhật nghiên cứu khi có handle; số liệu khi có bài đăng; Reddit theo lịch, mang brief.
  const { dueLoops } = await import("../loops");
  const base = { weekday: 3, duePost: null, dueSales: null, competitorHandles: 0, publishedRecently: 0, socialReader: true };
  assert.deepEqual(dueLoops(base), []);
  assert.deepEqual(dueLoops({ ...base, weekday: 1 }).map((r) => r.kind), ["plan_week", "post_draft"]);
  assert.deepEqual(
    dueLoops({ ...base, weekday: 0, competitorHandles: 2, publishedRecently: 3 }).map((r) => r.kind),
    ["competitor_research", "summarize_memory", "pull_metrics"],
  );
  const sales = dueLoops({ ...base, dueSales: { idea: "People chasing late invoices" } });
  assert.deepEqual([sales[0]!.kind, sales[0]!.input.brief], ["sales_scan", "People chasing late invoices"]);
  assert.deepEqual(dueLoops({ ...base, dueSales: { idea: "x" }, socialReader: false }), [], "không khoá ScrapeCreators thì không tự tiêu credit");

  // Memory tiers: the weekly summary writes one lesson per topic; jobs then read lessons for their topic.
  assert.equal(mondayOf(new Date(Date.UTC(2026, 10, 15))), "2026-11-09", "Sunday belongs to the week that started Monday");
  assert.equal(mondayOf(new Date(Date.UTC(2026, 10, 9))), "2026-11-09", "Monday is its own week");
  const events: MemoryEvent[] = [
    { kind: "feedback", topic: "post", body: "Skipped the X post \"Launch\": too hypey", created_at: new Date().toISOString() },
    { kind: "feedback", topic: "sales", body: "Dismissed the Reddit thread \"Help\": not our buyer", created_at: new Date().toISOString() },
  ];
  const mem8 = memoryStore(docs, ["Never mention competitors by name."], events);
  const w8 = mem8.enqueue("summarize_memory");
  await drainCmoQueue(mem8.store);
  assert.equal(w8.status, "done", `weekly memory done (${w8.error})`);
  assert.deepEqual(mem8.lessons.map((l) => l.topic).sort(), ["post", "sales"]);
  const postRecall = await recall(mem8.store, "u1", 10, "post");
  assert.ok(postRecall.includes("<lessons>") && postRecall.includes("post (week of"), "post jobs read the post lesson");
  assert.ok(!postRecall.includes("sales (week of"), "and not the sales one");
  assert.ok((await recall(mem8.store, "u1", 10)).includes("sales (week of"), "the weekly plan reads every topic");
  const quiet = memoryStore(docs, [], []);
  const w8q = quiet.enqueue("summarize_memory");
  await drainCmoQueue(quiet.store);
  assert.deepEqual([w8q.status, quiet.lessons.length], ["done", 0], "a quiet week writes nothing");

  console.log("jobs.check — hàng đợi CMO: W1, W2, W4, W5, W6-lite, W7, W8 memory, vòng lặp, kiểm bài, lease, hoãn đều đúng.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
