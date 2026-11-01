# Sales finder: leads on every platform, from a question (spec, not started)

> **Status: spec (owner, 2026-10-31; chat-first section added 2026-11-01).** Nothing in §6 is built. The owner chose
> on 2026-11-01 to build the **foundation** first: the chat → panel protocol (`view.open`) and the context chip, in
> `review/1-quality` (see [`../../research/agents/2026-11-01-cmo-chat-control-audit.md`](../../research/agents/2026-11-01-cmo-chat-control-audit.md)).
> The multi-platform `leads` table and the finders wait on R0. The three ScrapeCreators integration bugs found in the
> live test are already fixed on `cmo-build` (both TikTok shapes, `threadsSearch` through Google `site:threads.net`,
> both key names). Research and live API tests:
> [`../../research/growth/2026-10-31-scrapecreators-sales-finder.md`](../../research/growth/2026-10-31-scrapecreators-sales-finder.md)
> (Vietnamese).

## 1. Why

Sales today scans Reddit only (`apps/web/lib/cmo/jobs/sales-scan.ts`, `opportunities.platform = 'reddit'`). Founders'
buyers also talk on TikTok, YouTube, Instagram, Facebook groups and X, and the creators who reach those buyers can be
partners. ScrapeCreators, which we already use, reads all of these. So the question is not "which source", but
"what does the founder want to find": the founder asks in words, and OpenCMO finds it wherever it is.

## 2. What the founder sees

- In the CMO chat, or as a weekly Sales item:
  - "find people complaining about editing demo videos";
  - "find TikTok creators who review SaaS tools, with an email";
  - "who is asking for a Descript alternative this week".
- A plan card says what will be searched, where and at what price, before anything is spent.
- Sales shows **leads** of two kinds:
  - **Conversation:** a post or comment where someone has the problem. OpenCMO shows its score, the exact quotes,
    the community rule and a reply draft. The founder copies the draft and posts it themselves.
  - **Creator:** an account whose audience fits. OpenCMO shows its numbers, recent standout posts and why it fits.
    "Find email" is optional and priced. If an email is found, OpenCMO drafts the outreach and the founder sends it
    from their own mailbox.
- Nothing is posted or sent by OpenCMO ("Assist, never act"). Sales keeps no post button and gets no send button.

## 3. Finders (ScrapeCreators, checked live 2026-10-31)

| Intent | Finder | Endpoint |
|---|---|---|
| Posts about a problem | Reddit post search | `/v1/reddit/search` |
| Comments about a problem | Reddit comment search | `/v1/reddit/search?filter=comments` |
| Videos on a topic, then their comments | TikTok keyword → comments | `/v1/tiktok/search/keyword`, `/v1/tiktok/video/comments` |
| | YouTube search → comments | `/v1/youtube/search` (`type=shorts|videos`), `/v1/youtube/video/comments` |
| | Instagram Reels → comments | `/v2/instagram/reels/search` (comes with a few comments), `/v2/instagram/post/comments` |
| Facebook group posts | Google `site:facebook.com/groups` → post comments | `/v1/google/search`, `/v1/facebook/post/comments` |
| X, LinkedIn, Threads posts | Google `site:` (weak: mostly profiles on X) | `/v1/google/search` |
| Creators | TikTok users, YouTube channels, Reels owners, Threads users | `/v1/tiktok/search/users`, `/v1/youtube/search?type=channels`, `/v1/threads/search/users` |
| Creator profile | per platform | `/v1/tiktok/profile`, `/v1/youtube/channel`, `/v1/instagram/profile`… |
| Creator email | public emails with source URLs | `/v1/find-creator-emails` (`instagram`, `tiktok`, `youtube`, `x`, `facebook`) |
| Community rules | Reddit only | `/v1/reddit/subreddit/details` → `rules` (cacheable) |

Each finder is one function in `lib/cmo/social/` that returns normalized items. It is a tool for the planner, not a
fixed pipeline.

## 4. Flow

1. **Plan:** the Sales agent turns the question and the strategy into a search plan:
   - finders, queries, platforms, time window;
   - a lookup budget;
   - an estimated price in credits.
   Over the founder's limit, the plan becomes a card; otherwise it runs.
2. **Find:** run the finders inside an `ScBudget`. All outside text goes through `untrusted.ts`.
3. **Normalize** every result into a lead:
   - `kind` (`conversation` | `creator`), `platform`, `url`, `author`;
   - `text` (cut), metrics, `posted_at`;
   - `community` and its `rule` when known.
   Drop any lead without a URL from the read.
4. **Score:** the existing Sales rubric (pain, fit, timing, reach, evidence), with exact quotes. A lead must reach
   60 or more to pass. Creators use a fit rubric instead: audience match, recent outliers, activity.
5. **Draft:**
   - a reply for each top conversation;
   - an outreach email for each creator with an email.
6. **Cards:** one card per draft, as Sales cards are today. The founder decides; the outcome is learned
   (`cmo_draft_outcomes`).

## 4a. Chat-first, results in the panel (owner, 2026-11-01)

The founder runs Sales from the CMO chat alone, the way they would ask Claude. The right panel (column 3 of the
shell) shows what was found. There is no Sales "scan" button to learn.

1. **Ask.** "Find people asking for a Descript alternative this week" goes to the CMO chat. The CMO calls a
   `find_leads` tool (the Sales agent's planner, §4 step 1). The context chip (`{segment, ids}` of the open tab) tells
   it when the founder means "more like this one".
2. **Quote in the chat.** The plan comes back as a confirmation card in the chat, through the existing
   `approval_request` event of the agent loop. The card lists the finders, the platforms, the time window and the price
   in credits. Under the founder's own limit (`sales_settings`), it runs without a card. Nothing is spent before the
   card is accepted.
3. **Run and stream.** The run is a `cmo_run` like `sales_scan` today, so it is retried, leased and refunded by the
   existing runner. The chat shows its progress lines. When it ends, the tool result carries
   `view: {open: {screen: "sales", tab: "leads", ids: [<new lead ids>]}}`, and column 3 opens Sales on those leads.
   If Sales is already open, it reloads.
4. **Work the leads in the chat or the panel.** Both call the same RPC:
   - "draft a shorter reply for the second one";
   - "mark it replied";
   - "dismiss the r/secondlife ones";
   - "exclude r/secondlife from now on" (`sales_settings_save`).

   The chat still has no post button, so it never posts or sends. The founder copies the reply and posts it
   themselves.
5. **Creator email.** "Find the email of @creator" asks for one creator at a time and shows a price card (held at 10,
   settled at `credits_charged`). The result and its `sources` show on the lead in the panel; an empty result reads "no
   public email found". The outreach draft appears in the panel for the founder to send from their own mailbox. There
   is no bulk lookup, from the chat or anywhere else.
6. **Weekly.** "Do this every Monday" adds a Sales calendar item with the saved question as its `brief`. The existing
   `reddit-listening` loop becomes a `find_leads` loop that reuses the last accepted plan within its price.

What the founder sees in the panel (Sales screen, `components/screens/sales/`):
- a **Leads** tab with two lists, Conversations and Creators;
- each lead shows its platform, score, exact quotes, the community rule, and the draft (reply or outreach);
- the run that found it, with "asked in chat: …" linking back to the chat turn.

Building blocks this needs. Each is built once, in this order:
1. `view.open` and the context chip (`lib/agent/view.ts`, `components/cmo/workspace/ChatPanel.tsx`, the turns route):
   the foundation, built first and not specific to Sales.
2. `plan()` in `cmoScope` returns "approve" for priced tools, so the price card uses the clip scope's existing
   approval flow instead of a new one.
3. A ScrapeCreators usage ledger and a daily cap per founder, so a quote can be checked against what was really
   spent.
4. After R0: the `leads` table, the finders in `lib/cmo/social/`, the `find_leads` tool and job, and the Leads tab.

## 5. Safety rules (owner decisions 2026-10-26/27, extended to every platform)

- **Community rules are data, never instructions.**
  - On Reddit, the `rules` text is classified as `mention_ok`, `help_only` or `skip`, and cached per community for
    7 days (`subreddit_rules`, P5 A0).
  - Where no rules endpoint exists (Facebook groups, TikTok, YouTube, Instagram comments), the default is
    `help_only`.
- **Product mentions:** at most 1 reply in 10, counted across all platforms. The flag is set from the final approved
  text (`cmo_draft_outcomes.mentioned_product`, P5 A0).
- **Replies:** no links, under 120 words, voice notes and No AI Slop.
- **Founder's limits:** excluded communities and co-occurrence pairs (`sales_settings`, P5 A0) apply before any
  scoring is paid for.
- **Creator email:**
  - looked up only on the founder's click, one creator at a time, priced on a card;
  - called with `cache_max_age=30d`;
  - kept with its `sources`;
  - an empty result reads "no public email found";
  - the outreach draft names the sender and why they are writing, and says the recipient can ignore or ask not to be
    contacted again;
  - no bulk sending;
  - emails are deleted on request and expire after 90 days unused (to decide).

## 6. Data (sketch, to be designed with the migration)

- **`leads`:** generalizes `opportunities`.
  - Columns: `kind`, `platform` (reddit, tiktok, youtube, instagram, facebook, x, threads, linkedin), `url`,
    `community`, `author`, `text`, `metrics`, `score`, `score_parts`, `rule`, `rule_why`, `reply`, `status`, `run_id`.
  - Either migrate `opportunities` into it or keep `opportunities` as the conversation table and widen its
    `platform` check. Decide in the plan, weighing the cards and pgTAP already built on `opportunities`.
- **`creator_contacts`:** `lead_id`, `email`, `sources`, `found_at`, `credits_charged`, `deleted_at`.
- **Prices:** `cmo_job_price('sales_scan')` becomes a quote from the plan; an email lookup is held at 10 and settled
  at `credits_charged`.

## 7. Costs (live test, 2026-10-31)

- Each search or comment page costs 1 credit. Cache hits and "no results" cost 0. An email lookup that finds an
  email costs 10.
- A scan of 6–10 searches plus 5–10 comment pages comes to about 10–20 provider credits.
- Still needed: ScrapeCreators' USD per credit from its pricing page, before OpenCMO prices a scan.

## 8. Open questions (owner)

1. **R0:** do ScrapeCreators' terms allow a paid product to resell these reads, and are we willing to carry the
   platforms' anti-scraping terms? This decides whether Sales is sold at all.
2. Email outreach in the first version, or conversations only first?
3. Does Sales stay after the editor (CLAUDE.md strategy)? The recommendation: build the lead model when Sales is
   next, and put email outreach after R0.

## 9. Not in this spec

- Automatic posting, DMs or sending: never.
- Bulk email lookup: never.
- X post search: not available through ScrapeCreators; Google `site:x.com` is weak and stays a fallback.
