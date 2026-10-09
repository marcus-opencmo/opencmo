# Viết bài blog OpenCMO

Tài liệu này là hợp đồng cho người viết, kể cả lịch Claude tự viết bài. Mỗi bài là
**một file** `content/blog/<slug>.html`. Đăng bài nghĩa là mở PR thêm file đó; Marcus
xem bản preview Vercel rồi merge. Blog là trang tĩnh, nên bài lên site khi deploy.

`npm run check:blog` cưỡng chế mọi luật dưới đây (cũng chạy trong CI). Đỏ thì không
mở PR.

## Chủ đề: dạy marketing, không quảng cáo

Blog là trường dạy marketing và bán hàng cho **solo founder và team nhỏ**, không phải
trang tính năng. Người đọc phải học được cách làm dù không bao giờ dùng OpenCMO.

- **Viết về:** định vị, ICP, nỗi đau khách hàng, viết bài X, tham gia Reddit đúng
  cách, video ngắn, lịch nội dung, tái sử dụng nội dung, đo lường, ra mắt sản phẩm,
  pricing page, landing page, email đầu tiên…
- **Không viết:** bài về một tính năng của OpenCMO (clipping, editor, phụ đề…), bài so
  sánh "tool tốt nhất", bài chê đối thủ.
- OpenCMO chỉ nhắc nhẹ, tối đa một lần, khi thật sự liên quan; khung CTA cuối bài do
  trang tự thêm.

## Ngôn ngữ

- Tài liệu này viết tiếng Việt. **Bài viết: tiếng Anh**, vì khách hàng là thị trường
  toàn cầu.
- Giọng văn: thẳng, cụ thể, không sáo rỗng. Viết như một founder nói với một founder.

## Cấu trúc file

```html
<!--meta
{
  "title": "How to Write Your First Positioning Statement",
  "description": "Một câu 120–160 ký tự: bài này giúp người đọc làm gì.",
  "category": "how-to",
  "date": "2026-10-01",
  "updated": "2026-10-01",
  "author": "marcus",
  "answer": "Câu trả lời 30–80 từ cho câu hỏi chính của bài.",
  "faq": [{ "q": "Câu hỏi thật người ta hỏi?", "a": "Trả lời 1–3 câu." }],
  "keywords": ["từ khoá chính", "biến thể"],
  "draft": false
}
-->
<p>Đoạn mở bài…</p>
<h2 id="what-is-x">What is X?</h2>
<p>…</p>
```

- `category` là **dạng bài**, một trong: `how-to` (từng bước cho một việc), `tips`
  (mẹo ngắn dùng ngay), `playbooks` (kế hoạch lặp lại được để có khách), `basics`
  (giải thích một khái niệm nền). Danh sách nằm ở `categories.ts`.
- `author` là khoá trong `authors.ts`.
- `updated` để trống nghĩa là bằng `date`. Khi sửa nội dung một bài cũ thì cập nhật
  `updated`, không sửa `date`.
- `draft: true` chỉ hiện khi `next dev`.

## Slug: chuẩn SEO / AEO / GEO

- Slug là tên file. Gồm 2–6 từ tiếng Anh chữ thường, nối bằng `-`, dài tối đa 60 ký tự.
- **Từ khoá chính đứng trước.** Ví dụ: `write-positioning-statement`, không phải
  `how-i-finally-figured-out-positioning`.
- **Không có năm hay ngày.** Bài sẽ được cập nhật, nên URL phải đúng mãi.
- Không mở đầu hay kết thúc bằng từ nối (`the`, `a`, `of`, `for`…).
- URL phẳng: `/blog/<slug>`. Category KHÔNG nằm trong URL, nên đổi category không
  làm gãy link.
- **Slug là bất biến.** Bắt buộc phải đổi thì thêm `"slug-cũ": "slug-mới"` vào
  `redirects.json`. Next sẽ trả redirect 308, giữ thứ hạng và link ngoài.

## Khung bài (AEO: để AI và featured snippet trích được)

1. **`answer`**: trả lời thẳng câu hỏi chính trong 30–80 từ. Đoạn này hiện thành khung
   "Short answer" ở đầu bài và vào JSON-LD.
2. **Mở bài** 1–2 đoạn: vấn đề là gì, vì sao người đọc nên quan tâm.
3. **H2 viết dạng câu hỏi** người ta thật sự gõ: "How do you…?", "What makes…?",
   "Should you…?".
4. **Câu đầu tiên dưới mỗi H2 trả lời luôn**, chi tiết để sau. AI trích đúng câu đó.
5. Có ít nhất **một bảng hoặc danh sách** (so sánh, các bước, checklist).
6. **3–6 câu FAQ** trong meta. Trang tự dựng phần FAQ và `FAQPage` JSON-LD, nên
   KHÔNG viết lại FAQ trong thân bài.
7. **Ít nhất 2 link nội bộ**: tới `/` (landing) và/hoặc `/blog/<slug>` của bài khác
   đang có. Check sẽ báo link tới bài không tồn tại.
8. Kết bài bằng một đoạn tóm tắt ngắn. Khung CTA cuối bài do trang tự thêm.
9. Thân bài từ 500 từ trở lên.

## HTML được phép

`p h2 h3 h4 ul ol li a strong em b i blockquote figure figcaption img table thead
tbody tr th td code pre hr br sup sub mark small`

- **Không có `<h1>`.** Tiêu đề lấy từ `meta.title`.
- Mọi `h2`/`h3`/`h4` phải có `id` dạng `chu-thuong-noi-gach` và không trùng. Mục lục
  và link neo dùng id này. `faq` là id dành riêng.
- Mọi `<img>` phải có `alt` mô tả.
- Không dùng `style`, `class`, `script`, `iframe`, `on*=`, `javascript:`. Giao diện
  do `styles/blog.css` lo.

## Sự thật

- **Cấm bịa số liệu, nghiên cứu hay trích dẫn.** Không có nguồn thì không viết con
  số. Một con số bịa trong một bài được AI trích lại là rủi ro thật cho thương hiệu.
- Nói về OpenCMO thì chỉ nói những gì sản phẩm làm được hôm nay. Định vị: AI CMO
  với ba department (Video, Post, Sales), người dùng duyệt mọi thứ đi ra ngoài —
  xem "Luật sản phẩm" trong `CLAUDE.md` và `docs/cmo/san-pham.md` §2.
  Phần video hôm nay làm được:
  - **upload** video người dùng sở hữu (KHÔNG viết "dán link YouTube" — bên thanh
    toán xếp đó vào "content downloader", bị cấm);
  - tự chọn moment, hoặc người dùng tự chọn;
  - khung dọc 9:16 bám mặt người nói;
  - phụ đề burn-in theo brand;
  - sửa clip bằng lời;
  - Brand Kit;
  - giá: xem `lib/pricing.ts` và `lib/usage.ts`.

  Department nào chưa chạy thật thì KHÔNG viết như đã có.
- Không dùng chữ dễ bị bên thanh toán đánh trượt: "lead generation", "leads",
  "outreach", "growth hack", "get rich", con số thu nhập.
- Không nhắc tên đối thủ theo kiểu chê bai.

## Quy trình cho lịch tự động

1. Chọn một câu hỏi marketing mà founder thật sự tìm, chưa có bài nào trả lời; ưu
   tiên category đang ít bài nhất. Đọc danh sách bài
   trong thư mục này để tránh trùng.
2. Đặt slug theo luật trên, viết file `content/blog/<slug>.html`.
3. Chạy `npm run check:blog --workspace @opencmo/web` cho tới khi xanh.
4. Chạy `npm run build --workspace @opencmo/web`.
5. Commit (message tiếng Việt), push nhánh `blog/<slug>`, mở PR tên `Blog: <title>`.
   **Không merge.**
