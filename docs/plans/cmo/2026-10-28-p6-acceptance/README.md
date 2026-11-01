# P6 acceptance (A5, plan F13)

Run on 2026-10-31 against a local Supabase with fake models, Zernio, mail and push service:

```bash
cd apps/web
eval "$(supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET|INBUCKET_URL)=' | sed 's/^/export /')"
NEXT_PUBLIC_SUPABASE_URL=$API_URL NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY \
  SUPABASE_JWT_SECRET=$JWT_SECRET OPENCMO_AGENT_FAKE=1 OPENCMO_PUBLISH_FAKE=1 SCRAPECREATORS_API_KEY= ZERNIO_API_KEY= \
  RESEND_API_KEY= OPENCMO_DIGEST_LOCAL_MAIL=1 OPENCMO_LOCAL_MAIL_URL=$INBUCKET_URL \
  NODE_OPTIONS=--conditions=react-server npx tsx lib/screens/p6-acceptance.e2e.ts
```

and the browser checks on the separate e2e stack and a production build:

```bash
cd apps/web
NEXT_PUBLIC_OPENCMO_UI=v2 npx tsx e2e/run.ts ui-v2-reach    # 16 passed
```

| Feature | Result |
|---|---|
| F5 Zernio metrics | 10 X posts published through Zernio and 31 account days read from the fake Zernio by `pull_metrics`. Analytics (`kpis`, `byAccount`, `posts`) and Dashboard `results` are live. In the browser, Analytics shows a connected account's stored numbers at 1440 and 390, with no "Sample data" tag, and is axe clean. |
| F6 Best time | Six posts at 14:00 do far better than four at 09:00 (the default). After ten posts, `best_slots` holds both hours. A new approved post is proposed at 14:00, and its card says "Your posts on X do best around 2 pm." |
| F4 Card budget | 10 new cards raised today, then 3 held until tomorrow. The queue only shows waiting cards. |
| F1 Email digest | "9 things wait on you · Saturday 31 Oct" lands in the local mail catcher, once. It has links that open each card, an unsubscribe link and `support@opencmo.io` (`digest-email.html`, `digest-email.png`). In the browser: the cron sends it once a day, its link goes to login and then opens the card, and the unsubscribe page asks first and then stops the emails. |
| F2 Web push | One VAPID-signed push to a test subscription through a fake push service. No second push until a new card arrives. |
| F3 Phone-first queue | Every card kind (post, thread, reply, goal, script, price, finished video, finished video with a look note, shorts, slideshow, schedule, correction) decides at 390 and at 1024. Each is axe clean, has no sideways scroll, and its decide button fits the screen. The phone tab bar has Approve and Chat one tap away; at 1024 the chat is a drawer (`phone-queue-390.png`). |
| F7 Reply outcomes | A Hacker News reply marked replied four days ago is found by its words. Its outcome is stored, and memory gets "A reply on Hacker News that only helped got no vote count and 0 replies three days later." |
| F9 Look check | The SQL wait and send-back are covered by pgTAP `231` (round 0 sent back, round 1 noted, "unchanged" raises the card now). The note on the card is checked in the browser (`card-finished-look-*.png`). |
| F12 X threads | Each post is numbered with its own length; the card is approved as written, with no edit (`card-thread-*.png`). Posting uses Zernio `threadItems` (`draft-thread.check.ts`). |

Measured elsewhere: pgTAP `233`–`237` and the updated `182`, `202`, `231`. Every pgTAP file ran on a fresh database in CI.

Found and fixed during this run:
- `greatest(0, null)` is 0 in Postgres, so an unreported number would have been stored as zero (`nonneg()`).
- The hourly `/api/cron/cmo-digest` was never scheduled. A Modal `cmo_digest` job now runs it every hour, and it releases held cards, sends emails and pushes.
- The digest titled a schedule card "schedule".
- A link inside a card's meta line had no underline (axe `link-in-text-block`).

Not done in this run:
- **Owner gates:** Resend account and verified domain, VAPID keys in env, the Zernio analytics add-on (a 402 is handled), and the one real-model brain and Studio eval run.
- **Real sends:** no real email, push, Zernio call or vision judge was made.
- **Chat as the first phone tab:** the plan (F3) says "Chat first", but the shell built in S1–S3 has Today · Approve · Calendar · Chat · More. It is left as built, for the owner to decide.
- **The reply link field:** `opportunity_reply_url` exists, but the reply card has no field to paste the link yet.
- **Batching several items into one card:** past the budget, cards are held; they are not merged.
