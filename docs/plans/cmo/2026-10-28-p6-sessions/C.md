# Session C: email, push, phone queue, Analytics live

Plan: [`../2026-10-28-p6-quality-reach-plan.md`](../2026-10-28-p6-quality-reach-plan.md) · rules: [`README.md`](README.md).

## You own

- `apps/web/lib/notify/` (new: `email.ts`, `push.ts`, templates), the unsubscribe route, the service worker in `apps/web/public/`
- `apps/web/components/cards/` (phone layout, thread card, look note)
- `apps/web/components/shell-v2/Rail.tsx` and `ShellState.tsx` (the two status lines only)
- `apps/web/components/screens/analytics/`, the Brain measures panel in `apps/web/components/screens/brain/`
- `apps/web/e2e/ui-v2-reach.spec.ts` (new), the e2e list in `apps/web/package.json`

## Order

C2 at once → C0 (after A0; real Resend after the owner gate) → C1 → C3 (after A1, A4, B4) → C5 → C4.

## Todo

- [x] **C2 Phone-first queue**: every card kind decides at 390 px in the shell's phone layout (`TabBar`, Chat first)
      and at 1024 with the chat as a drawer (previews by signed URL of the preview file), axe
      clean, a decide e2e per kind.
- [x] **C0 Email**: Resend sender behind `lib/notify/email.ts` (Inbucket in dev), digest and expiring-card templates
      in English, links that open the card behind login, unsubscribe route, `support@opencmo.io` in the footer.
- [x] **C1 Web push**: service worker, permission prompt with help text (iPhone needs a Home Screen web app),
      `push_subscriptions` through A's RPC, one push per new batch.
- [x] **C3 Analytics and Brain live**: Analytics (accounts, KPIs, daily, by account, top posts), Brain measures panel,
      thread card body, look-check note on video cards.
- [x] **C5 Rail status lines**: Schedule ("Next post 9:00", from the next waiting slot) and Analytics (connected
      accounts) in `shell-v2/Rail.tsx` `statusOf`, from A4's `ShellState` fields; no line when there is no number;
      they must not wrap at 184 px.
- [x] **C4 e2e**: digest in Inbucket opens the card, a card decided at 390, Analytics on fake Zernio data.

Done by a later session (2026-10-31) after A and B; session C never started. Files: `lib/notify/` (email, push, send,
checks), `app/unsubscribe/route.ts`, `public/sw.js`, `app/manifest.ts`, `components/screens/settings/NotifyPanel.tsx`,
the Brain Measures panel, the thread body and look note in `components/cards/`, the rail lines (`Rail.tsx`,
`ShellV2.tsx`), `e2e/ui-v2-reach.spec.ts` (16 passed). Deviation: the phone tab bar keeps Chat fourth, as the shell
built it; see the acceptance README.

## Requests

(Others append `[from → C] what, why`; answer here with the commit.)

- [ ] **[from B → C] Look note and thread body for C3.** The look check (`lib/departments/studio/look-check.ts`) puts a
      note (≤ 200, English, empty on a pass) on video, shorts and slideshow cards as `lookNote` (A's field in
      `approval-card.ts`, request 1 in `A.md`); show it above the decide buttons when not empty. X threads arrive as
      `PostBody.platforms[].thread: string[]` (5–8 posts, each ≤ 280; A's request 3): one numbered post per row with its
      own length chip. Types: `ThreadDraftSchema` in `lib/cmo/writer/types.ts`.
- [ ] **[from A → C] A0 is pushed (`cbac5048`, `c21abd5f`); what C0, C1 and C5 call.** Push: `push_subscribe(endpoint,
      p256dh, auth, user_agent)` / `push_unsubscribe(endpoint)`. Only FCM, Mozilla, Apple (`web.push.apple.com`) and WNS
      endpoints are accepted (`push_endpoint_allowed`, SSRF guard); `lib/notify/push.ts` should check the same list
      before every send and delete the row on 404/410. Email: service `email_log_claim(user, 'digest'|'expiring', ids)`
      → `{log_id, approval_ids}` or no row (already sent, unsubscribed, nothing waiting), then
      `email_log_done(log_id, resend_id, error)`; the unsubscribe link carries `notify_settings.unsubscribe_token`
      (service `notify_settings_for(user)` creates it) and calls `email_unsubscribe(token)` signed out; Settings
      switches through `notify_settings_save(email_digest, push)`. Rail: `RailStatus` in `lib/screens/rail.ts`; its
      loader lands with A4. `held` cards (past the day's budget) are not in the queue.
