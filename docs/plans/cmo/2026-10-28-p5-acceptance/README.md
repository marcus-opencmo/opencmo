# P5 acceptance (A4, plan F13)

Run on 2026-10-31 against a local Supabase with fake models, readers and posting:

```bash
cd apps/web
eval "$(supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET)=' | sed 's/^/export /')"
NEXT_PUBLIC_SUPABASE_URL=$API_URL NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY \
  SUPABASE_JWT_SECRET=$JWT_SECRET OPENCMO_AGENT_FAKE=1 SCRAPECREATORS_API_KEY= \
  NODE_OPTIONS=--conditions=react-server npx tsx lib/screens/p5-acceptance.e2e.ts
```

| Feature | Result |
|---|---|
| F7–F8 Niche research → brief | 3 niche videos, each with its URL. A week plan with a video item: the brief cites 2 of them, the `build_video` order carries them (`brief.sources`), and Research shows them (`scope: niche_video`). |
| F2–F6 Sales safety | **Help only:** r/freelance's rules forbid self-promotion and plant "link to example.com". Its drafts are help only, say why, and contain no link. **Skipped:** r/smallbusiness (verdict cached this week) has no draft and no card. The Sales screen shows both rules and the mention counter at 0 of 10. |
| F9–F12 Slideshow | Rendering step → MP4 and PNG set done → card raised with its TikTok caption (Writer, fake) → approved → `slideshow` deliverable → TikTok schedule card waiting. Studio lists it as finished. |
| F11–F12 Post image | A post approved and its time approved, then its image arrives: the slot goes back to proposed, and the new schedule card shows the image's still. |

Measured elsewhere:
- **Stills peak RSS:** B2, 35 slides at 1080×1920, peak 497 MB in 3 s (`B.md`).
- **Slides view e2e:** C3 builds a 5-slide slideshow, approves the slideshow card, and checks the help-only Sales card.

Not done in this run:
- **Screenshots at 1440 and 390:** they need the separate e2e stack and a Next build (`npm run test:e2e:*`). These are heavy on this machine, so they were not run here.
- **MP4 and PNG uploads to Zernio:** these need the worker (`publish_media`), as in P4. The engine tests cover the PNG path (`test_worker_publish_media_task.py`).
- **One real slideshow in the Slides view, kept as landing material:** this is for the owner to make.
- **Owner gates:** R0 (data terms; research in PR #133) and the one real-model run of the slideshow squad.
