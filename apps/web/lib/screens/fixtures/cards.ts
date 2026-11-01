/**
 * One sample card of each kind, from `Cards.dc.html`, plus the state examples. The Dashboard fixture's queue
 * is the first five of `Main.dc.html`; the rest are here for the card sheet and `/app/inbox/[id]`.
 */

import type { ApprovalCard, StudioSnapshot } from "../approval-card";
import { at } from "./shared";

const base = {
  status: "waiting",
  priceCredits: null,
  postAt: null,
  account: null,
  raisedAt: at("2026-10-29", "07:00"),
  expiresAt: null,
  decidedAt: null,
  decidedVia: null,
  problem: null,
  contentHash: "0".repeat(64),
} as const;

export const POST_CARD: ApprovalCard = {
  ...base,
  id: "card-post",
  kind: "post",
  department: "writer",
  title: "Most AI video tools stop at the first draft.",
  summary: "We built the editor first: cut by words, then ask for the B-roll on the line you mean.",
  meta: "Checks passed · no links · Thu 09:10 · @opencmo",
  postAt: at("2026-10-29", "09:10"),
  account: { platform: "x", handle: "@opencmo" },
  body: {
    kind: "post",
    platforms: [
      {
        platform: "x",
        versions: [
          "Most AI video tools stop at the first draft. We built the editor first: cut by words, then ask for the B-roll on the line you mean.",
          "The first draft is where most AI video tools stop. Ours starts there: cut by words, then ask for B-roll on the line you mean.",
          "We built the editor before anything else. Cut by deleting words, then ask for B-roll on the exact line.",
        ],
        limit: 280,
        visibleBeforeMore: null,
      },
    ],
    checks: ["no links", "checker ok"],
    why: "Tuesday's insight, editor-first launches",
  },
};

/** Threads and LinkedIn (P3 C0): one card per platform, drafted from the same idea; posted by copy and open until P4. */
export const THREADS_POST_CARD: ApprovalCard = {
  ...base,
  id: "card-post-threads",
  kind: "post",
  department: "writer",
  title: "I spent more time cutting my demo than building the feature.",
  summary: "So the editor came first: delete a word in the transcript and the cut follows.",
  meta: "2 versions · Threads · you post it on your account",
  body: {
    kind: "post",
    platforms: [
      {
        platform: "threads",
        versions: [
          "I spent more time cutting my demo than building the feature. So the editor came first: delete a word in the transcript and the cut follows. Then ask for B-roll on the line you mean.",
          "Cutting a demo used to take me longer than building the feature. Now I delete words in the transcript and the video follows.",
        ],
        limit: 500,
        visibleBeforeMore: null,
      },
    ],
    checks: ["no links", "no hashtags", "checker ok"],
    why: "Tuesday's insight, editor-first launches",
  },
};

export const LINKEDIN_POST_CARD: ApprovalCard = {
  ...base,
  id: "card-post-linkedin",
  kind: "post",
  department: "writer",
  title: "Why we built the editor before anything else.",
  summary: "Every launch video I made took longer to cut than the feature took to build.",
  meta: "1 version · LinkedIn · you post it on your account",
  body: {
    kind: "post",
    platforms: [
      {
        platform: "linkedin",
        versions: [
          "Why we built the editor before anything else.\n\nEvery launch video I made took longer to cut than the feature took to build. Scrubbing a timeline for one bad sentence is not a good use of a founder's evening.\n\nSo the first thing OpenCMO does is let you cut by deleting words. The transcript is the timeline. Ask for B-roll on the line you mean and it lands there.\n\nThe marketing team of one needs fewer tools, not more.",
        ],
        limit: 3000,
        visibleBeforeMore: 140,
      },
    ],
    checks: ["no links", "no hashtags", "checker ok"],
    why: "Your content strategy: one founder story a week on LinkedIn",
  },
};

export const PRICE_CARD: ApprovalCard = {
  ...base,
  id: "card-price",
  kind: "price",
  department: "studio",
  title: "Long video “How the CMO plans a week” · 60 s",
  summary: "12 shots between keyframes you approved. Ready in about 25 minutes.",
  meta: "Credits held until the video is done",
  priceCredits: 24,
  expiresAt: at("2026-10-29", "11:42"),
  body: {
    kind: "price",
    stepId: "step-sample-2",
    what: "Long video “How the CMO plans a week”",
    keyframes: [
      { index: 0, label: "You recorded the demo.", thumbUrl: null, garbled: false, credits: 1 },
      { index: 1, label: "Now cut it by words.", thumbUrl: null, garbled: true, credits: 1 },
      { index: 2, label: "Ask for B-roll.", thumbUrl: null, garbled: false, credits: 1 },
    ],
    shots: 12,
    seconds: 60,
    readyInMinutes: 25,
  },
};

export const SHORTS_CARD: ApprovalCard = {
  ...base,
  id: "card-shorts",
  kind: "shorts_batch",
  department: "studio",
  title: "3 shorts from “Editor launch”",
  summary: "Hooks: cut by words · B-roll on the line · edit by asking. Captions and hashtags written.",
  meta: "Cut from a finished edit · no generation credits",
  body: {
    kind: "shorts_batch",
    batchId: "batch-sample",
    parentClipId: "clip-sample",
    source: "Editor launch",
    shorts: [
      {
        shortClipId: "short-sample-1",
        start: 0,
        end: 22,
        hook: "Cut by words",
        reason: "Opens on the pain every founder knows",
        previewUrl: null,
        captions: [
          { id: "caption-1-tiktok", profile: "tiktok_caption", text: "Cut your demo by deleting words. #editing #buildinpublic", title: null },
          { id: "caption-1-instagram", profile: "instagram_caption", text: "Your transcript is the timeline: delete a word and the cut follows. #videoediting #saas #founders", title: null },
        ],
      },
      {
        shortClipId: "short-sample-2",
        start: 18,
        end: 41,
        hook: "B-roll on the line",
        reason: "Shows the slash command working",
        previewUrl: null,
        captions: [{ id: "caption-2-tiktok", profile: "tiktok_caption", text: "Ask for B-roll on the exact line you mean. #editing", title: null }],
      },
      { shortClipId: "short-sample-3", start: 38, end: 60, hook: "Edit by asking", reason: "Ends on the strongest demo moment", previewUrl: null, captions: [] },
    ],
  },
};

export const REPLY_CARD: ApprovalCard = {
  ...base,
  id: "card-reply",
  kind: "reply",
  department: "sales",
  title: "r/SaaS · “What do you use to edit product demos?”",
  summary: "“I spend more time cutting my demo than building the feature.” Reply drafted, help first.",
  meta: "Score 78 · product mention allowed · you post it yourself",
  account: { platform: "reddit", handle: "you" },
  body: {
    kind: "reply",
    community: "r/SaaS",
    threadTitle: "What do you use to edit product demos?",
    threadUrl: "https://www.reddit.com/r/SaaS/comments/sample/what_do_you_use_to_edit_product_demos/",
    score: 78,
    parts: [
      { label: "Pain", score: 22, max: 25 },
      { label: "Fit", score: 20, max: 25 },
      { label: "Timing", score: 18, max: 20 },
      { label: "Reach", score: 9, max: 15 },
    ],
    quotes: [
      { text: "I spend more time cutting my demo than building the feature.", from: "original post" },
      { text: "Timeline editors are overkill for a 40 second clip.", from: "top comment" },
    ],
    draft:
      "I had the same problem. What helped: record once, then cut by deleting words from the transcript instead of scrubbing the timeline. Ums and retakes go in a minute.",
    rules: "product mention allowed · you post it yourself",
  },
};

export const SCHEDULE_CARD: ApprovalCard = {
  ...base,
  id: "card-time",
  kind: "schedule",
  department: "schedule",
  title: "Short 1 to TikTok @opencmo, today 18:00",
  summary: "Your time zone: Asia/Ho_Chi_Minh. Changing the time or account asks you again.",
  meta: "Why 18:00: your last shorts did best after work",
  postAt: at("2026-10-29", "18:00"),
  account: { platform: "tiktok", handle: "@opencmo" },
  expiresAt: at("2026-10-29", "18:00"),
  body: {
    kind: "schedule",
    slotId: "sl-8",
    what: "Short 1 “Edit by asking”",
    where: { platform: "tiktok", handle: "@opencmo" },
    accountId: "acc-tiktok",
    avatarUrl: null,
    mode: "publish",
    at: at("2026-10-29", "18:00"),
    timezone: "Asia/Ho_Chi_Minh",
    why: "your last 4 shorts did best after work",
    preview: { text: "Edit a video by asking for it. No timeline.", title: null, videoUrl: null },
    options: { privacy: "PUBLIC_TO_EVERYONE", allow_comment: true, allow_duet: false, allow_stitch: false, ai_label: false },
    tiktok: { privacyLevels: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"], commentDisabled: false, duetDisabled: false, stitchDisabled: true },
    lastError: null,
    state: "waiting",
    publishedUrl: null,
  },
};

type ScheduleBodyFixture = Extract<ApprovalCard["body"], { kind: "schedule" }>;
const scheduleBody = (patch: Partial<ScheduleBodyFixture>): ScheduleBodyFixture => ({ ...(SCHEDULE_CARD.body as ScheduleBodyFixture), ...patch });

/** The schedule card's states (P4 C0/C3), each a card of its own for `/app/inbox/[id]` and the e2e. */
export const SCHEDULE_STATE_CARDS: ApprovalCard[] = [
  {
    ...SCHEDULE_CARD,
    id: "card-time-failed",
    summary: "It did not go out: TikTok refused the post.",
    body: scheduleBody({ state: "failed", lastError: "TikTok refused the post: the account needs reconnecting." }),
  },
  {
    ...SCHEDULE_CARD,
    id: "card-time-missed",
    body: scheduleBody({ state: "missed", lastError: "It could not go out within its time window." }),
  },
  {
    ...SCHEDULE_CARD,
    id: "card-time-intent",
    title: "Most AI video tools stop at the first draft · LinkedIn",
    account: { platform: "linkedin", handle: "" },
    expiresAt: null,
    body: scheduleBody({
      what: "Most AI video tools stop at the first draft",
      where: { platform: "linkedin", handle: "" },
      accountId: null,
      mode: "intent",
      state: "no_account",
      lastError: "No connected LinkedIn account: copy it and post it yourself, or connect the account and retry.",
      preview: { text: "Most AI video tools stop at the first draft. Ours starts there: you edit by asking.", title: null, videoUrl: null },
      options: {},
      tiktok: null,
    }),
  },
  {
    ...SCHEDULE_CARD,
    id: "card-time-unconfirmed",
    expiresAt: null,
    body: scheduleBody({ state: "unconfirmed", lastError: "We could not confirm it went out. Check your account before posting it again." }),
  },
  {
    ...SCHEDULE_CARD,
    id: "card-time-choose",
    body: scheduleBody({ options: { allow_comment: false, allow_duet: false, allow_stitch: false, brand_organic: false, brand_content: false } }),
  },
];

export const GOAL_CARD: ApprovalCard = {
  ...base,
  id: "card-goal",
  kind: "goal",
  department: "brain",
  title: "Launch the editor",
  summary: "5 posts, 1 long video + 3 shorts, 1 slideshow, 2 Reddit replies.",
  meta: "Target: 2 sign-ups from posts",
  priceCredits: 80,
  body: {
    kind: "goal",
    goalId: "goal-sample",
    week: "2026-10-26",
    goal: "Launch the editor",
    metric: "posts",
    target: 5,
    plan: [
      { what: "5 posts · X, Threads, LinkedIn", department: "writer" },
      { what: "1 long video + 3 shorts", department: "studio" },
      { what: "1 slideshow", department: "studio" },
      { what: "2 Reddit replies", department: "sales" },
    ],
    budgetCredits: 80,
  },
};

export const SCRIPT_CARD: ApprovalCard = {
  ...base,
  id: "card-script",
  kind: "script",
  department: "studio",
  title: "Script for “How the CMO plans a week” · 6 beats",
  summary: "Approve the words and pictures; keyframes are priced next.",
  meta: "Nothing spent yet",
  body: {
    kind: "script",
    stepId: "step-sample-1",
    seconds: 60,
    aspect: "9:16",
    beats: [
      { words: "You recorded the demo.", picture: "Desk, laptop, morning light.", motion: "Slow push in on the screen." },
      { words: "Now cut it by words.", picture: "Transcript lines fade out.", motion: "Lines lift away one by one." },
      { words: "Ask for B-roll.", picture: "Slash command, shot drops in.", motion: null },
    ],
    nextPriceCredits: 6,
  },
};

export const FINISHED_CARD: ApprovalCard = {
  ...base,
  id: "card-finished",
  kind: "finished_video",
  department: "studio",
  title: "“Editor launch” is rendered · 1:00",
  summary: "Approving marks it finished: Shorts can be cut from it.",
  meta: "Open in the editor to tweak first",
  body: {
    kind: "finished_video",
    clipId: "clip-sample",
    documentHash: "1".repeat(64),
    seconds: 60,
    previewUrl: null,
    frameAt: 2,
    captions: [
      {
        id: "caption-youtube",
        profile: "youtube",
        title: "Cut a product demo by deleting words",
        text: "A one-minute look at the OpenCMO editor: cut by words, B-roll on the line you mean, and edits by asking. #videoediting #saas",
      },
    ],
  },
};

export const SLIDESHOW_CARD: ApprovalCard = {
  ...base,
  id: "card-slideshow",
  kind: "slideshow",
  department: "studio",
  title: "3 ways to cut a demo · 6 slides",
  summary: "MP4 and a PNG set, ready for Threads and LinkedIn.",
  meta: "MP4 + PNG",
  body: {
    kind: "slideshow",
    stepId: "step-slideshow",
    clipId: "clip-slideshow",
    documentHash: "b".repeat(64),
    aspect: "9:16",
    slides: [
      { text: "3 ways to cut a demo", stillUrl: null, seconds: 3 },
      { text: "1. Cut by words", stillUrl: null, seconds: 3 },
      { text: "2. Ask for B-roll", stillUrl: null, seconds: 3 },
    ],
    previewUrl: "https://example.com/slideshow.mp4",
    pngSetUrl: "https://example.com/slideshow.zip",
  },
};

export const CORRECTION_CARD: ApprovalCard = {
  ...base,
  id: "card-correction",
  kind: "correction",
  department: "brain",
  title: "“Don't open posts with a question.”",
  summary: "Learned from 3 of your edits this week.",
  meta: "Keep it and every draft follows it",
  body: {
    kind: "correction",
    correctionId: "correction-sample",
    rule: "Don't open posts with a question.",
    editMode: "HOOK_REWRITTEN",
    times: 3,
    examples: [
      { before: "Tired of editing demos?", after: "Editing a demo shouldn't take longer than building it." },
      { before: "What if you could cut by words?", after: "Cut a video by deleting words." },
    ],
  },
};

/** P6: an X thread (W4) and a video whose look check still found a problem (S4). */
export const P6_CARDS: ApprovalCard[] = [
  {
    ...POST_CARD,
    id: "card-thread",
    title: "How we cut a product demo in ten minutes.",
    meta: "1 thread · X · you approve when it posts",
    body: {
      kind: "post",
      platforms: [
        {
          platform: "x",
          versions: ["How we cut a product demo in ten minutes, without a timeline. Here is the whole path."],
          limit: 280,
          visibleBeforeMore: null,
          thread: [
            "How we cut a product demo in ten minutes, without a timeline. Here is the whole path.",
            "First, record the demo in one take. Mistakes included: they are easy to cut later.",
            "Then open the transcript and delete the words you do not want. The video follows the words.",
            "Ask for B-roll on the line you mean. It lands on those words, not at the end.",
            "Captions come from the same words, so they stay in sync after every cut.",
            "Export once you like it. The whole edit took about ten minutes.",
          ],
        },
      ],
      checks: ["no links", "every post under 280"],
      why: "You asked for a thread about the editor",
    },
  },
  {
    ...FINISHED_CARD,
    id: "card-finished-look",
    body: { ...(FINISHED_CARD.body as Extract<ApprovalCard["body"], { kind: "finished_video" }>), lookNote: "Look check: captions run past the frame's right edge at 0:12." },
  },
];

/** The four states every card has, on copies of real kinds. */
export const STATE_CARDS: ApprovalCard[] = [
  { ...SCHEDULE_CARD, id: "card-expired", status: "expired", problem: { kind: "expired", text: "The slot passed. Pick a new time." } },
  {
    ...POST_CARD,
    id: "card-decided",
    status: "approved",
    decidedAt: at("2026-10-29", "08:42"),
    decidedVia: "push",
    problem: { kind: "decided_elsewhere", text: "You approved this on your phone at 08:42." },
  },
  { ...PRICE_CARD, id: "card-credits", problem: { kind: "needs_credits", text: "Needs 24 credits; you have 12. Top up or cancel." } },
  { ...POST_CARD, id: "card-failed", problem: { kind: "failed", text: "Threads rejected the post: reconnect the account." } },
];

/** Every kind once, in `Cards.dc.html` order. */
export const ALL_KINDS: ApprovalCard[] = [
  POST_CARD,
  REPLY_CARD,
  GOAL_CARD,
  SCRIPT_CARD,
  PRICE_CARD,
  FINISHED_CARD,
  SHORTS_CARD,
  SLIDESHOW_CARD,
  SCHEDULE_CARD,
  CORRECTION_CARD,
];

/** Every sample card `/app/inbox/[id]` can open outside production: each kind, the P3 platforms, the states. */
export const SAMPLE_CARDS: ApprovalCard[] = [...ALL_KINDS, THREADS_POST_CARD, LINKEDIN_POST_CARD, ...P6_CARDS, ...STATE_CARDS, ...SCHEDULE_STATE_CARDS];

/**
 * One snapshot per Studio kind, as `approval_snapshot` writes it. The script one is the exact output asserted in
 * `supabase/tests/205_p2_studio.test.sql`, so the SQL and the TypeScript shape cannot drift apart unnoticed.
 */
export const STUDIO_SNAPSHOTS: StudioSnapshot[] = [
  {
    kind: "script",
    step_id: "e2053000-0000-4000-8000-00000000000a",
    clip_id: "e2052000-0000-4000-8000-00000000000a",
    tool: "create_video",
    title: "How the CMO plans a week",
    seconds: 60,
    aspect: "9:16",
    beats: [{ words: "You recorded the demo.", picture: "Desk, laptop.", motion: "Slow push in." }],
    price_credits: 6,
  },
  {
    kind: "price",
    step_id: "step-sample-2",
    clip_id: "clip-sample",
    tool: "animate_video",
    title: "How the CMO plans a week",
    what: "12 shots, voice-over, music",
    seconds: 60,
    wait_minutes: 25,
    keyframes: [{ index: 0, words: "You recorded the demo.", path: "user/keyframes/00.png", garbled: false, credits: 1 }],
    shots: 12,
    price_credits: 24,
  },
  {
    kind: "finished_video",
    clip_id: "clip-sample",
    title: "Editor launch",
    document_hash: "1".repeat(64),
    render_task_id: "task-sample",
    render_path: "user/clip-sample/task-sample.mp4",
    seconds: 60,
  },
  {
    kind: "shorts_batch",
    batch_id: "batch-sample",
    parent_clip_id: "clip-sample",
    title: "Editor launch",
    parent_hash: "1".repeat(64),
    shorts: [
      { short_id: "s1", short_clip_id: "short-sample-1", start: 0, end: 22, hook: "Cut by words", reason: "Opens on the pain every founder knows" },
      { short_id: "s2", short_clip_id: null, start: 18, end: 41, hook: "B-roll on the line", reason: "Shows the slash command working" },
    ],
  },
  // As `approval_snapshot('studio_step', …)` writes a slideshow step (P5 A0; pgTAP 221 makes the same).
  {
    kind: "slideshow",
    step_id: "e2213000-0000-4000-8000-00000000000a",
    clip_id: "clip-slideshow",
    title: "Launch",
    aspect: "9:16",
    slides: [
      { text: "Cut by words", still_path: null, seconds: 3 },
      { text: "Ask for B-roll", still_path: "u/clip-slideshow/task-01.png", seconds: 3 },
    ],
    document_hash: "2".repeat(64),
    mp4_path: null,
    png_set_path: null,
  },
];

/** A schedule snapshot exactly as `approval_snapshot('schedule_slot', …)` writes it (P4 A0; pgTAP 215 makes the same). */
export const SCHEDULE_SNAPSHOT = {
  kind: "schedule",
  slot_id: "e2154000-0000-4000-8000-00000000000a",
  deliverable_id: "e2153000-0000-4000-8000-00000000000a",
  deliverable_kind: "short",
  platform: "tiktok",
  mode: "publish",
  account_id: "e2155000-0000-4000-8000-00000000000a",
  handle: "@opencmo",
  publish_at: "2030-01-07T09:00:00Z",
  options: { privacy: "PUBLIC_TO_EVERYONE", allow_comment: true, allow_duet: false, allow_stitch: false, ai_label: false },
  last_error: null,
  clip_id: "e2156000-0000-4000-8000-00000000000a",
  text: "Edit a video by asking for it. No timeline.",
  title: null,
  content_hash: "0".repeat(64),
} as const;
