/**
 * Nội dung landing (thiết kế "OpenCMO Landing v3"). Không có "use client": trang server
 * đọc cùng mảng này để dựng JSON-LD FAQPage, nên chữ trong schema và chữ trên trang
 * không bao giờ lệch nhau.
 */
import { DEPT_ICON, LUCIDE, type SocialKey } from "./icons";

export type DeptId = "video" | "post" | "sales";

export type Dept = {
  id: DeptId;
  numeral: string;
  short: string;
  name: string;
  goal: string;
  steps: string[];
  result: string;
  channels: SocialKey[];
};

export const DEPTS: Dept[] = [
  {
    id: "video",
    numeral: "I",
    short: "Video",
    name: "Video Department",
    goal: "An AI video editor you edit by asking.",
    steps: [
      "Cuts clips from recordings you own, framed on the speaker",
      "Ask the agent to change the edit, the animation or a 3D scene",
      "Adds captions and a voice-over, then schedules after you approve",
    ],
    result: "Short videos from the recordings you already have.",
    channels: ["tiktok", "instagram", "youtubeshorts", "facebook", "threads"],
  },
  {
    id: "post",
    numeral: "II",
    short: "Post",
    name: "Post Department",
    goal: "An AI post writer that knows your business.",
    steps: [
      "Reads your strategy and what you shipped this week",
      "Drafts a post in your voice for each platform",
      "You approve; it publishes to your accounts",
    ],
    result: "Posts for every platform, in your voice, every day.",
    channels: ["x", "linkedin", "threads", "facebook", "reddit"],
  },
  {
    id: "sales",
    numeral: "III",
    short: "Sales",
    name: "Sales Department",
    goal: "Find the conversations where people need what you built.",
    steps: [
      "Searches public conversations across nine platforms",
      "Shows why each one matters, with the link",
      "Drafts a helpful reply you post yourself",
    ],
    result: "Conversations worth joining, with a reply drafted.",
    channels: ["reddit", "x", "linkedin", "facebook", "threads", "ycombinator", "indiehackers", "youtube", "quora"],
  },
];

/** Ba đoạn chữ I · II · III đổi theo thanh cuộn trong hero. */
export const BEATS = [
  { num: "I.", title: "It starts with your website.", body: "The AI CMO reads your site and competitors, and turns them into one strategy and one goal." },
  { num: "II.", title: "The plan takes shape.", body: "Your goal becomes a weekly calendar, mapped across the channels where your customers already are." },
  { num: "III.", title: "Three departments carry it.", body: "Video, Post and Sales each own one result, and leave their drafts for you to approve." },
];

export const PROMISES = [
  { title: "Nothing is published without your approval", body: "Every post, clip and reply waits in your inbox until you say yes." },
  { title: "Only your accounts", body: "OpenCMO publishes to accounts you connect, never to accounts it creates." },
  { title: "No automated likes, follows, DMs or replies", body: "It drafts. You decide what to say and where." },
  { title: "Only content you own", body: "Video tools work on recordings you own or have the rights to use." },
];

export type InboxCard = { id: string; dept: "Post" | "Video" | "Sales"; when: string; title: string; body: string; thumbs?: number };

export const INBOX_CARDS: InboxCard[] = [
  { id: "c1", dept: "Post", when: "X · for today 9:30", title: "Shipped this week: bulk export", body: "We shipped bulk export this week.\nIt started with one support email asking to get data out without a CSV per project." },
  { id: "c2", dept: "Video", when: "2 clips · from Tuesday's podcast", title: "Two moments that tell your founder story", body: "Framed on the speaker, captions on, a caption written for each platform.", thumbs: 2 },
  { id: "c3", dept: "Sales", when: "r/SaaS · 2h old", title: "Someone is asking for exactly what you built", body: "\"Data out without a CSV per project?\" A reply is drafted. You post it yourself." },
];

export const DEMOS: Record<DeptId, { src: string; label: string; alt: string; caption: string }> = {
  video: {
    src: "/demos/video.mp4",
    label: "Video department · 5s",
    alt: "The Video editor: the founder asks the agent to punch up the hook and add a 3D chart; captions and a voice-over are added",
    caption: "Ask the editor to make the hook punchier and add a 3D chart. The agent edits the clip, restyles the captions and records the voice-over.",
  },
  post: {
    src: "/demos/post.mp4",
    label: "Post department · 5s",
    alt: "The Post department turns this week's update into five platform drafts and schedules them after approval",
    caption: "One update from your week becomes a post for each platform, written in your voice, waiting for your approval.",
  },
  sales: {
    src: "/demos/sales.mp4",
    label: "Sales department · 5s",
    alt: "The Sales department scans nine platforms and surfaces three conversations with a drafted reply",
    caption: "Sales searches public conversations on nine platforms and brings back the ones where people need what you built.",
  },
};

/** Giá chạy trên trang: đọc từ PLANS ở server rồi truyền xuống (pricing.ts là server-only). */
export type Prices = { monthly: number; annual: number; annualBilled: number };

export function savePercent(p: Prices): number {
  return Math.round((1 - p.annual / p.monthly) * 100);
}

/** Cách làm thường: ước tính, trang có ghi chú ngay dưới bảng. */
export const USUAL_STACK = [
  { who: "Freelance video editor", what: "4 short clips a week, with captions", price: 480 },
  { who: "Voice-over and caption tools", what: "Two subscriptions", price: 45 },
  { who: "Social media manager", what: "Posts for X, LinkedIn, Threads, Facebook and Reddit", price: 350 },
  { who: "Scheduling tool", what: "Queue and publish", price: 35 },
  { who: "Social listening tool", what: "Alerts when people mention your problem", price: 150 },
];

export const INCLUDED = [
  { icon: DEPT_ICON.cmo, title: "AI CMO", body: "Reads your site and plans your week around one goal" },
  { icon: DEPT_ICON.video, title: "Video department", body: "Edits clips and 3D scenes when you ask, with captions and voice-over" },
  { icon: DEPT_ICON.post, title: "Post department", body: "Drafts for X, LinkedIn, Threads, Facebook and Reddit" },
  { icon: DEPT_ICON.sales, title: "Sales department", body: "Finds the conversations where people need what you sell, on 9 platforms" },
];

export function faqs(p: Prices): { q: string; a: string }[] {
  return [
    { q: "What is an AI marketing team?", a: "OpenCMO gives you three AI departments led by an AI CMO. Video edits your recordings into short videos, Post writes posts for X, LinkedIn, Threads, Facebook and Reddit, and Sales finds conversations where people need what you built. You approve everything." },
    { q: "Does OpenCMO post anything without me?", a: "No. Every post, clip and reply waits in your inbox until you approve it. You can also edit or skip it." },
    { q: "Can I edit videos by asking?", a: "Yes. In the editor you ask the AI agent to change the edit, the animation or a 3D scene. It also writes captions and records a voice-over." },
    { q: "Which platforms does Sales search?", a: "Public conversations on Reddit, X, LinkedIn, Facebook groups, Threads, Hacker News, Indie Hackers, YouTube comments and Quora. It drafts a reply; you post it yourself." },
    { q: "Will it like, follow or DM people for me?", a: "No. There are no automated likes, follows, DMs or replies. OpenCMO drafts; you decide what to say and where." },
    { q: "What does the plan include?", a: `Everything: the AI CMO, all three departments, and the editor with captions, voice-over and 3D. $${p.annual} a month billed annually, or $${p.monthly} month to month.` },
    { q: "Can I cancel?", a: "Yes, anytime. Annual plans are refunded for the unused months." },
  ];
}

export type MenuItem = { title: string; sub: string; href: string; social?: SocialKey; icon?: string };
export type Menu = { id: string; label: string; width: number; cols: 1 | 2; items?: MenuItem[]; href?: string };

const mi = (title: string, sub: string, href: string, o: { social?: SocialKey; icon?: string }): MenuItem => ({ title, sub, href, ...o });

export const MENUS: Menu[] = [
  {
    id: "product", label: "Product", width: 380, cols: 1,
    items: [
      mi("AI CMO", "Turns one goal into a weekly plan", "/ai-cmo", { icon: DEPT_ICON.cmo }),
      mi("AI video editor", "Edit clips, captions and 3D by asking", "/ai-video-editor", { icon: DEPT_ICON.video }),
      mi("AI post writer", "Posts for X, LinkedIn, Threads and more", "/ai-post-writer", { icon: DEPT_ICON.post }),
      mi("Customer conversations", "Find people asking for what you built", "/find-customers", { icon: DEPT_ICON.sales }),
      mi("Brand kit", "Your colors, fonts and captions", "/brand-kit", { icon: LUCIDE.palette }),
    ],
  },
  {
    id: "solutions", label: "Solutions", width: 360, cols: 1,
    items: [
      mi("Solo founders", "Marketing without hiring", "/for/solo-founders", { icon: LUCIDE.user }),
      mi("Indie hackers", "Launch and grow in public", "/for/indie-hackers", { icon: LUCIDE.rocket }),
      mi("SaaS startups", "Content from what you ship", "/for/saas", { icon: LUCIDE.layers }),
      mi("Agencies", "One team for every client", "/for/agencies", { icon: LUCIDE.briefcase }),
      mi("Creators & coaches", "Clips from every recording", "/for/creators", { icon: LUCIDE.mic }),
    ],
  },
  {
    id: "channels", label: "Channels", width: 560, cols: 2,
    items: ([
      ["tiktok", "TikTok videos", "/channels/tiktok"],
      ["youtubeshorts", "YouTube Shorts", "/channels/youtube-shorts"],
      ["instagram", "Instagram Reels", "/channels/instagram-reels"],
      ["x", "X posts", "/channels/x"],
      ["linkedin", "LinkedIn posts", "/channels/linkedin"],
      ["threads", "Threads posts", "/channels/threads"],
      ["facebook", "Facebook pages & groups", "/channels/facebook"],
      ["reddit", "Reddit marketing", "/channels/reddit"],
    ] as const).map(([k, t, href]) => mi(t, "", href, { social: k })),
  },
  {
    id: "resources", label: "Resources", width: 380, cols: 1,
    items: [
      mi("Blog", "Founder-led marketing, week by week", "/blog", { icon: LUCIDE.book }),
      mi("Guides", "Playbooks for each channel", "/guides", { icon: LUCIDE.compass }),
      mi("Free tools", "Hook, caption and post generators", "/tools", { icon: LUCIDE.wand }),
      mi("Compare", "OpenCMO vs Buffer, Opus Clip, Hootsuite", "/compare", { icon: LUCIDE.scale }),
      mi("Changelog", "What shipped this month", "/changelog", { icon: LUCIDE.history }),
    ],
  },
  { id: "pricing", label: "Pricing", width: 0, cols: 1, href: "#pricing" },
  { id: "faq", label: "FAQ", width: 0, cols: 1, href: "#faq" },
];

export type FootLink = { t: string; href: string; social?: SocialKey };

const fl = (t: string, href: string, social?: SocialKey): FootLink => ({ t, href, social });

export const FOOTER_COLUMNS: { title: string; links: FootLink[] }[] = [
  { title: "Product", links: [fl("AI CMO", "/ai-cmo"), fl("AI video editor", "/ai-video-editor"), fl("AI post writer", "/ai-post-writer"), fl("Customer conversations", "/find-customers"), fl("Brand kit", "/brand-kit"), fl("Pricing", "#pricing")] },
  { title: "Solutions", links: [fl("Solo founders", "/for/solo-founders"), fl("Indie hackers", "/for/indie-hackers"), fl("SaaS startups", "/for/saas"), fl("Agencies", "/for/agencies"), fl("Creators & coaches", "/for/creators")] },
  { title: "Channels", links: [fl("TikTok videos", "/channels/tiktok"), fl("YouTube Shorts", "/channels/youtube-shorts"), fl("Instagram Reels", "/channels/instagram-reels"), fl("LinkedIn posts", "/channels/linkedin"), fl("Reddit marketing", "/channels/reddit"), fl("X posts", "/channels/x")] },
  { title: "Free tools", links: [fl("Video hook generator", "/tools/hook-generator"), fl("Caption generator", "/tools/caption-generator"), fl("LinkedIn post generator", "/tools/linkedin-post-generator"), fl("X thread writer", "/tools/x-thread-writer"), fl("Reddit thread finder", "/tools/reddit-thread-finder")] },
  { title: "Resources", links: [fl("Blog", "/blog"), fl("Guides", "/guides"), fl("OpenCMO vs Buffer", "/compare/buffer"), fl("OpenCMO vs Opus Clip", "/compare/opus-clip"), fl("OpenCMO vs Hootsuite", "/compare/hootsuite"), fl("Changelog", "/changelog")] },
  { title: "Connect", links: [fl("X", "#", "x"), fl("LinkedIn", "#", "linkedin"), fl("YouTube", "#", "youtube"), fl("TikTok", "#", "tiktok"), fl("Reddit", "#", "reddit")] },
];
