import "server-only";

/**
 * Dữ liệu mẫu của màn AI CMO — CHỈ dev/preview (`OPENCMO_CMO_DEMO=1`, không bao
 * giờ trên production; luật sản phẩm 1). Dùng để nhìn thấy goal của UI trước khi
 * backend của W1–W7 xong. Mọi nút trong demo không gửi gì ra ngoài.
 */

import type { CalendarItem, ChatMessage, InboxCard, LinkRow, LogEntry, Metrics, SeoMetrics } from "./workspace";

export function demoAllowed(): boolean {
  return process.env.OPENCMO_CMO_DEMO === "1" && process.env.VERCEL_ENV !== "production";
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const daysFromNow = (d: number, hour = 9) => {
  const at = new Date();
  at.setDate(at.getDate() + d);
  at.setHours(hour, 0, 0, 0);
  return at.toISOString();
};

export function demoInbox(product: string): InboxCard[] {
  return [
    {
      id: "demo-post-1",
      priority: "medium",
      department: "post",
      platform: "x",
      title: "New X post ready",
      text: `Most freelancers don't have a pricing problem. They have a follow-up problem.\n\nWe watched people send an invoice, then wait 3 weeks before asking again.\n\n${product} now sends the reminder for you: polite, on day 3, 7 and 14. You just get paid.`,
      alternates: [
        `The invoice isn't late. The reminder is.\n\n${product} sends polite follow-ups on day 3, 7 and 14 so you don't have to.`,
        `Shipped this week in ${product}: automatic payment reminders. One less awkward email for you to write.`,
      ],
      rationale: "From your changelog (reminders shipped) and the pain “chasing late payments” in your strategy.",
      scheduledFor: daysFromNow(1),
      createdAt: hoursAgo(2),
      state: "review",
      finalText: null,
    },
    {
      id: "demo-sales-1",
      priority: "high",
      department: "sales",
      platform: "reddit",
      title: "Conversation worth joining",
      thread: {
        title: "How do you deal with clients who pay 60+ days late?",
        community: "r/freelance",
        url: "https://www.reddit.com/r/freelance/",
        author: "u/designer_mo",
        postedAt: hoursAgo(5),
        snippet: "Third client this year paying two months late. I hate sending the ‘just checking in’ email. Is there a better system?",
        comments: 23,
      },
      score: 84,
      parts: [
        { label: "Pain", score: 23, max: 25, evidence: "“I hate sending the ‘just checking in’ email”" },
        { label: "Fit", score: 22, max: 25, evidence: "Freelancer invoicing clients — your ICP" },
        { label: "Timing", score: 18, max: 20, evidence: "Posted 5 hours ago, still active" },
        { label: "Reach", score: 9, max: 15, evidence: "23 comments" },
        { label: "Evidence", score: 12, max: 15, evidence: "Asks for a system, not a rant" },
      ],
      reply:
        "What fixed it for me was taking the awkwardness out of it: put the due date and late fee on the invoice itself, then send the same short reminder on day 3, 7 and 14 so it feels like a process, not a personal chase. Most clients pay after the second one. If you want it automatic, tools like ours can send those for you, but even a calendar reminder works.",
      createdAt: hoursAgo(1),
    },
    {
      id: "demo-video-1",
      priority: "medium",
      department: "video",
      title: "5 clips ready",
      source: "Founder interview — how we priced v1.mp4",
      clips: [
        { id: "c1", title: "Why we killed the free plan", seconds: 41, hook: "We had 2,000 free users and no revenue." },
        { id: "c2", title: "The one question to ask before pricing", seconds: 37, hook: "Ask what they pay today." },
        { id: "c3", title: "Annual vs monthly", seconds: 52, hook: "Annual saved us, but not for the reason you think." },
        { id: "c4", title: "Our first 10 customers", seconds: 46, hook: "All ten came from one Reddit thread." },
        { id: "c5", title: "What I'd do differently", seconds: 33, hook: "Charge from day one." },
      ],
      platforms: ["TikTok", "Reels", "Shorts"],
      projectId: null,
      createdAt: hoursAgo(3),
    },
    {
      id: "demo-sales-2",
      priority: "low",
      department: "sales",
      platform: "reddit",
      title: "Conversation worth joining",
      thread: {
        title: "Invoicing tool for a one-person agency?",
        community: "r/smallbusiness",
        url: "https://www.reddit.com/r/smallbusiness/",
        author: "u/solo_studio",
        postedAt: hoursAgo(20),
        snippet: "Spreadsheets are killing me. Need something simple that handles recurring invoices. Not a full accounting suite.",
        comments: 11,
      },
      score: 76,
      parts: [
        { label: "Pain", score: 18, max: 25, evidence: "“Spreadsheets are killing me”" },
        { label: "Fit", score: 24, max: 25, evidence: "Recurring invoices, one-person business" },
        { label: "Timing", score: 14, max: 20, evidence: "Posted yesterday" },
        { label: "Reach", score: 7, max: 15, evidence: "11 comments" },
        { label: "Evidence", score: 13, max: 15, evidence: "Lists exact requirements" },
      ],
      reply:
        "If you only need invoices (not accounting), look for three things: recurring schedules, automatic reminders, and a pay-by-card link on the invoice. That covers most one-person agencies. Happy to share what we built for exactly this if it helps.",
      createdAt: hoursAgo(4),
    },
  ];
}

export function demoCalendar(): CalendarItem[] {
  return [
    { id: "k1", day: daysFromNow(0), department: "post", platform: "X", idea: "Reminders shipped: why follow-ups matter more than pricing", reason: "Pain #1 in your strategy", editable: false },
    { id: "k2", day: daysFromNow(1), department: "video", platform: "Shorts", idea: "Clip: why we killed the free plan", reason: "Strongest hook from Tuesday's interview", editable: false },
    { id: "k3", day: daysFromNow(2), department: "post", platform: "X", idea: "Thread: the 3-7-14 reminder rule", reason: "Hook pattern that is working for competitors this week", editable: false },
    { id: "k4", day: daysFromNow(3), department: "sales", platform: "Reddit", idea: "Join r/freelance threads on late payments", reason: "Most replies last week came from here", editable: false },
    { id: "k5", day: daysFromNow(4), department: "post", platform: "X", idea: "Build in public: this week's numbers", reason: "Founders reply most to concrete numbers", editable: false },
  ];
}

export function demoMetrics(): Metrics {
  return {
    windowDays: 7,
    tiles: [
      { label: "Posts published", value: 6, change: 2, hint: "On X this week" },
      { label: "Views", value: 18420, change: 31, hint: "Across X and short videos" },
      { label: "Replies", value: 47, change: 12, hint: "On your posts" },
      { label: "Clips scheduled", value: 5, change: null, hint: "TikTok, Reels, Shorts" },
    ],
    views: [1200, 980, 1640, 2100, 1830, 2950, 3400, 2280, 2610, 3120, 2890, 3760, 4210, 3980],
    top: { title: "The invoice isn't late. The reminder is.", platform: "X", views: 6230 },
  };
}

export function demoLog(): LogEntry[] {
  return [
    {
      id: "l1", job: "W4", title: "Scan Reddit", status: "done", startedAt: hoursAgo(1), detail: "2 conversations worth joining",
      steps: [
        { tool: "make_queries", label: "10 searches from your pains", status: "done" },
        { tool: "reddit_search", label: "38 threads found", status: "done" },
        { tool: "score_thread", label: "Scored 31 new threads", status: "done" },
        { tool: "draft_reply", label: "Drafted 2 replies", status: "done" },
        { tool: "create_card", label: "2 cards in your inbox", status: "done" },
      ],
    },
    {
      id: "l2", job: "W2", title: "Draft X post", status: "done", startedAt: hoursAgo(2), detail: "1 post ready",
      steps: [
        { tool: "next_due_item", label: "Today: reminders shipped", status: "done" },
        { tool: "draft_post", label: "3 versions", status: "done" },
        { tool: "check_post", label: "Passed the X playbook", status: "done" },
        { tool: "create_card", label: "1 card in your inbox", status: "done" },
      ],
    },
    {
      id: "l3", job: "W5", title: "Video pack", status: "done", startedAt: hoursAgo(3), detail: "5 clips from your interview",
      steps: [
        { tool: "create_clip_job", label: "5 clips cut", status: "done" },
        { tool: "render_document", label: "Brand applied and rendered", status: "done" },
        { tool: "write_captions", label: "Captions for 3 platforms", status: "done" },
        { tool: "create_card", label: "1 card in your inbox", status: "done" },
      ],
    },
    {
      id: "l4", job: "W1", title: "Plan the week", status: "done", startedAt: hoursAgo(30), detail: "5 items in your calendar",
      steps: [
        { tool: "read_doc", label: "Read your strategy", status: "done" },
        { tool: "get_results", label: "Last week: 6 posts, 47 replies", status: "done" },
        { tool: "plan_items", label: "5 items planned", status: "done" },
      ],
    },
  ];
}

export function demoSeo(): SeoMetrics {
  return {
    pagespeed: {
      mobile: { performance: 73, accessibility: 97, bestPractices: 100, seo: 100 },
      desktop: { performance: 99, accessibility: 97, bestPractices: 100, seo: 100 },
    },
    vitals: {
      desktop: [
        { label: "LCP", value: "0.7s", pass: true },
        { label: "FCP", value: "0.5s", pass: true },
        { label: "TBT", value: "3ms", pass: true },
        { label: "CLS", value: "0.000", pass: true },
      ],
      mobile: [
        { label: "LCP", value: "3.1s", pass: false },
        { label: "FCP", value: "1.6s", pass: true },
        { label: "TBT", value: "180ms", pass: true },
        { label: "CLS", value: "0.020", pass: true },
      ],
    },
    auditedAt: hoursAgo(26),
    google: { analytics: false, searchConsole: false },
  };
}

export function demoLinks(site: string): LinkRow[] {
  const host = site.replace(/^https?:\/\//, "").replace(/\/$/, "") || "acme.com";
  return [
    { url: `https://${host}/`, kind: "page", title: "Home", note: "Most visited page" },
    { url: `https://${host}/pricing`, kind: "page", title: "Pricing", note: "No meta description" },
    { url: `https://${host}/blog`, kind: "page", title: "Blog", note: "3 posts" },
    { url: "https://www.producthunt.com/", kind: "backlink", title: "Product Hunt listing", note: "Found by the Competitor research" },
    { url: "https://www.indiehackers.com/", kind: "backlink", title: "Indie Hackers post", note: "Mentions you by name" },
  ];
}

export const DEMO_CHAT_TITLE = "30 day marketing plan";

export function demoChat(product: string): ChatMessage[] {
  return [
    { id: "m1", role: "user", text: `Make me a 30 day marketing plan for ${product}.` },
    {
      id: "m2",
      role: "cmo",
      text: `Here is a plan built from your documents. No paid spend, about 5–8 hours a week.

**Week 1 — Foundations** (impact: high)
- Rewrite your X bio around the one-liner
- Post the reminders launch with a real before/after
- Answer 3 Reddit threads about late payments

**Week 2 — Show the work** (impact: medium)
- Two build-in-public posts with this week's numbers
- One clip from your pricing interview
- Ask 3 happy users for a one-line quote

**Week 3 — Social proof** (impact: high)
- Case study post of a real customer
- Post in r/freelance with an educational angle

**Week 4 — Review** (impact: high)
- Review 30-day numbers: best channel, best post type
- Publish an honest build-in-public recap

Want me to start on Week 1 now, for example draft the X bio update?`,
    },
  ];
}
