# Tăng trưởng: Sales tìm khách trên mọi nền tảng qua ScrapeCreators (2026-10-31)

## TL;DR

- ScrapeCreators đọc được nhiều hơn Reddit rất nhiều: có tìm theo từ khoá trên Reddit (bài **và** comment), TikTok
  (video, user, hashtag), YouTube (video, Shorts, kênh), Instagram (Reels), Pinterest; đọc comment của TikTok,
  YouTube, Instagram, Facebook, Reddit; đọc group Facebook công khai; có **Google Search** (dùng `site:` để với tới
  X, Facebook, LinkedIn, Threads); và **Find Creator Emails** (email công khai của creator, kèm URL nguồn).
- Nên thiết kế lại Sales: founder hỏi bằng lời trong CMO chat ("tìm người đang chê Descript", "tìm creator
  TikTok làm video SaaS, có email"), một planner chọn công cụ tìm phù hợp trên mọi nền tảng. Không còn câu hỏi
  "đọc từ nguồn nào".
- Thử thật ngày 31/10 với khoá của anh (gói free 100 credit): 14 lần gọi, **20 credit** (13 lần × 1 credit,
  1 lần tìm email × 10). Mọi endpoint quan trọng trả đúng dạng doc mô tả, trừ 3 điểm ghi ở dưới.
- Có hai loại kết quả: **cuộc trò chuyện** (một người đang có vấn đề, founder trả lời bằng tay) và **creator**
  (người có khán giả đúng, founder tự gửi email mời hợp tác). Cả hai vẫn theo luật "Assist, never act": OpenCMO
  tìm và soạn, founder tự đăng hoặc tự gửi.
- Rủi ro lớn nhất không nằm ở kỹ thuật: điều khoản dữ liệu (R0) và luật email (thu thập và gửi email thương mại).
  Cần quyết R0 trước khi bán tính năng này.

## Phát hiện

### 1. Bản đồ endpoint theo việc Sales cần

Nguồn: mục lục `https://docs.scrapecreators.com/llms.txt` và trang doc từng endpoint (đọc ngày 2026-10-31).

| Việc | Reddit | TikTok | YouTube | Instagram | Facebook | X | Threads / LinkedIn |
|---|---|---|---|---|---|---|---|
| Tìm bài theo từ khoá | `/v1/reddit/search` (posts) | `/v1/tiktok/search/keyword` | `/v1/youtube/search` (`type=shorts|videos`) | `/v2/instagram/reels/search` | không có; Google `site:facebook.com/groups` | **không có**; Google `site:x.com` | không có; Google `site:` |
| Tìm comment theo từ khoá | `/v1/reddit/search?filter=comments` | — | — | — | — | — | — |
| Đọc comment của một bài | `/v1/reddit/post/comments` | `/v1/tiktok/video/comments` | `/v1/youtube/video/comments` | `/v2/instagram/post/comments` | `/v1/facebook/post/comments` | — | LinkedIn: chỉ bản xem trước |
| Tìm creator | — | `/v1/tiktok/search/users` | `type=channels` | qua Reels search (`owner`) | — | — | `/v1/threads/search/users` |
| Hồ sơ creator | — | `/v1/tiktok/profile` | `/v1/youtube/channel` | `/v1/instagram/profile` (`business_email`, `bio_links`) | `/v1/facebook/profile` | `/v1/twitter/profile` | `/v1/linkedin/profile` |
| Email creator | `/v1/find-creator-emails` cho `instagram`, `tiktok`, `youtube`, `x`, `facebook` | | | | | | |
| Luật cộng đồng | `/v1/reddit/subreddit/details` → trường `rules` (một chuỗi) | — | — | — | — | — | — |

Ý nghĩa với mình:
- Lấy luật subreddit không cần nguồn riêng: `subreddit/details` có sẵn `rules` và có cache (`cache_max_age`; lần thử
  của mình trả `cached: true`, 0 credit).
- Nhu cầu mua thật thường nằm trong comment. Reddit tìm được comment theo từ khoá, các nền tảng video thì đọc comment
  của những video đúng chủ đề.
- X không có tìm kiếm bài. Google `site:x.com` chủ yếu ra trang profile, nên X không nên là nguồn tìm cuộc trò
  chuyện chính.

### 2. Thử thật (2026-10-31, gói free, script chỉ in dạng dữ liệu)

| Lần gọi | Kết quả | Credit |
|---|---|---|
| Reddit search (posts, tháng này) | 8 bài, có `title`, `selftext`, `subreddit`, `url`, `score`, `num_comments`, `created_utc`, phân trang `after` | 1 |
| Reddit search `filter=comments` "descript alternative" | 7 comment có `body`, `url`, `post`, `subreddit`, nhưng **lạc đề** (r/secondlife) | 1 |
| Subreddit details r/SaaS | `rules` dạng văn bản, `weekly_active_users` 276 528, `subscribers` = null | 0 (cache) |
| TikTok keyword (tháng này, `trim`) | 31 video; **dạng đã phẳng**: `url`, `desc`, `create_time_utc`, `statistics`, `author` ngay trên item, **không** có `aweme_info` như doc | 1 |
| YouTube `type=shorts` | 16 Short, có `viewCountInt` | 1 |
| Instagram Reels search | 11 reel, kèm `owner`, `video_duration`, `comment_count` và **sẵn vài comment** | 1 |
| Google `site:x.com` + `date_posted` | 404 "No Google search results found", không tính credit | 0 |
| Google `site:x.com` không lọc ngày | 10 kết quả, chủ yếu trang profile, không phải bài | 1 |
| Google `site:facebook.com/groups` (tháng này) | 10 bài trong group, có cả bài "cần người làm video demo SaaS" | 1 |
| TikTok search users "saas founder" | 31 user, có `follower_count`, `unique_id`, `nickname` | 1 |
| Find Creator Emails (TikTok) | 1 email công khai, kèm `sources`; `partial: true` (vài trang quét lỗi) | **10** |
| TikTok comments | 20 comment một trang, có `text`, `digg_count`, `create_time`, `has_more` | 1 |
| YouTube comments | rỗng (video ít người xem) | 1 |

Ba điều code hiện tại phải sửa:
- Parser TikTok trong `apps/web/lib/cmo/social/scrapecreators.ts` đọc theo dạng doc. Response thật (với `trim=true`)
  đã phẳng, nên phải đọc cả hai dạng.
- `threadsSearch` gọi `/v1/threads/search`, nhưng endpoint này **không có** trong mục lục (chỉ có search users).
- Code đọc biến `SCRAPECREATORS_API_KEY`, trong khi khoá ban đầu được đặt tên `SCRAPE_CREATORS_API_KEY`
  (anh đã đổi lại). Nên đọc được cả hai tên, hoặc ghi rõ tên trong `.env.example`.

### 3. Chi phí

- Hầu hết lời gọi: 1 credit. Response từ cache và lỗi: 0 credit. Tìm email: 10 credit nếu thấy, 1 credit nếu không
  thấy, 0 credit nếu trúng cache.
- Một lượt Sales kiểu mới, ước tính (ý kiến, chưa đo): 6–10 lần tìm, cộng 5–10 lần đọc comment, tức khoảng
  **10–20 credit**. Mỗi lần tìm email thêm 10 credit, nên chỉ chạy khi founder bấm cho một creator cụ thể, không chạy
  hàng loạt.
- Giá USD mỗi credit: chưa kiểm trong lượt này, phải đọc trang pricing trước khi định giá credit OpenCMO.

### 4. Pháp lý và an toàn (ý kiến, không phải tư vấn luật)

- **Điều khoản (R0):** ScrapeCreators đọc dữ liệu công khai, nhưng điều khoản của từng nền tảng (Reddit, Meta,
  TikTok, YouTube, X) thường cấm scrape. Đây là rủi ro của nhà cung cấp, và một phần thành rủi ro của mình khi bán.
  Vẫn cần anh quyết R0.
- **Email creator là dữ liệu cá nhân.** Doc ScrapeCreators nói email có thể của creator, manager hoặc booking, họ
  không đoán địa chỉ và có kênh xoá dữ liệu (support@scrapecreators.com). Với mình:
  - chỉ tìm khi founder yêu cầu cho từng creator;
  - lưu kèm URL nguồn;
  - không gửi hàng loạt;
  - founder tự gửi từ hộp thư của họ;
  - bản soạn có tên người gửi, lý do liên hệ và một câu để người nhận từ chối (CAN-SPAM; ở EU là cơ sở lợi ích hợp
    pháp).
  - xoá khi được yêu cầu.
- **Prompt injection:** comment và bài viết là văn bản của người lạ. Phải giữ quy tắc của `untrusted.ts` cho mọi nền
  tảng, không chỉ Reddit.

## Repo đáng học

| Repo | Học được gì | File nên đọc | Licence | Copy hay chỉ học |
|---|---|---|---|---|
| — | Lượt này chỉ đọc doc API và thử thật, chưa đọc repo nào | — | — | — |

## Khuyến nghị

1. **Thiết kế lại Sales thành "Sales finder" theo câu hỏi, đa nền tảng** (M–L).
   - Founder hỏi trong CMO chat hoặc đặt lịch; planner dịch câu hỏi thành kế hoạch tìm: chọn công cụ theo loại việc
     (bảng ở mục 1), không theo nguồn cố định.
   - Kết quả quy về một kiểu **lead**: `kind` (`conversation` | `creator`), `platform`, `url`, `text`, `author`,
     số liệu, bằng chứng trích nguyên văn, luật cộng đồng nếu có.
   - Mọi lead có điểm, theo cùng khung chấm (pain, fit, timing, reach, evidence) như bản Reddit hiện tại.
   - Cuộc trò chuyện ra bản nháp trả lời. Creator ra bản nháp email mời hợp tác.
   - Cải thiện: activation và doanh thu (Sales là tính năng trả tiền). Thuộc track Sales; thay thế A1 hiện tại
     của P5.
2. **Giữ nguyên các luật an toàn đã quyết, áp cho mọi nền tảng** (S).
   - Đọc luật cộng đồng nếu có. Reddit dùng `subreddit/details.rules`. Group Facebook chưa có endpoint luật, nên
     mặc định chỉ giúp, không nhắc sản phẩm.
   - Nhắc sản phẩm tối đa 1 trong 10 câu trả lời, đếm trên mọi nền tảng.
   - Không link, dưới 120 từ.
   - Không có nút đăng.
3. **Tìm email: chỉ theo yêu cầu, báo giá trước** (S).
   - Một nút "Find email" trên lead creator. Thẻ giá ghi tối đa 10 credit, trừ credit theo `credits_charged`
     thực tế.
   - Gọi với `cache_max_age=30d`. Lưu email kèm `sources`.
   - Kết quả rỗng ghi "không thấy email công khai", không ghi "không có".
4. **Sửa ba lỗi tích hợp ở mục 2** (S): parser TikTok hai dạng, bỏ hoặc sửa `threadsSearch`, tên biến khoá.
   Nên làm ngay, vì cả nghiên cứu video ngách (A2) cũng dùng TikTok search.
5. **Thứ tự so với chiến lược** (ý kiến): `CLAUDE.md` đặt editor là mũi nhọn và để Sales sau khi editor bán được.
   Khuyến nghị:
   - viết spec Sales finder và sửa mục 4 ngay;
   - làm schema lead đa nền tảng trong P5 thay cho A1 Reddit-only;
   - để phần email outreach sang P6, sau khi R0 có quyết định.
   Như vậy không làm hai lần, và không đốt thời gian của editor.

## Nguồn

- ScrapeCreators, mục lục endpoint: https://docs.scrapecreators.com/llms.txt (đọc 2026-10-31)
- Find Creator Emails: https://docs.scrapecreators.com/v1/find-creator-emails.md (2026-10-31)
- Google Search: https://docs.scrapecreators.com/v1/google/search.md (2026-10-31)
- Instagram Reels search: https://docs.scrapecreators.com/v2/instagram/reels/search.md (2026-10-31)
- TikTok keyword search: https://docs.scrapecreators.com/v1/tiktok/search/keyword.md (2026-10-31)
- TikTok search users: https://docs.scrapecreators.com/v1/tiktok/search/users.md (2026-10-31)
- YouTube search: https://docs.scrapecreators.com/v1/youtube/search.md (2026-10-31)
- YouTube comments: https://docs.scrapecreators.com/v1/youtube/video/comments.md (2026-10-31)
- Reddit search: https://docs.scrapecreators.com/v1/reddit/search.md (2026-10-31)
- Reddit subreddit details: https://docs.scrapecreators.com/v1/reddit/subreddit/details.md (2026-10-31)
- Facebook group posts: https://docs.scrapecreators.com/v1/facebook/group/posts.md (2026-10-31)
- Instagram profile: https://docs.scrapecreators.com/v1/instagram/profile.md (2026-10-31)
- Thử thật bằng khoá của owner, 14 lần gọi, 20 credit (2026-10-31); script và kết quả thô không đưa vào repo.
