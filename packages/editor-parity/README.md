# editor-parity — ảnh vàng lấy Diffusion Studio làm chuẩn

Bộ đo "đạt như DS" của spec `docs/specs/2026-09-24-editor-rewrite.md` (§5).
Checklist nghiệm thu: `docs/editor-parity/checklist.md`.

DS là **oracle**: fork Diffusion Studio (đã xoá ở C3) vẽ từng mẫu ra PNG trong
`references/`, và renderer của OpenCMO phải vẽ ra ảnh khớp trong ngưỡng. Từ C3
ảnh tham chiếu là ĐÃ CHỐT: không còn DS để vẽ lại. Thêm mẫu mới thì ảnh của nó
phải do người duyệt bằng mắt, không có đáp án tự động.

```
samples/           70 mẫu document JSON (<id>.json) + manifest.json — đã chốt cùng references/
fixtures/          ảnh, video VP9, transcript dùng chung (nhỏ, có trong git)
references/        PNG tham chiếu do DS vẽ — <id>/<giây>s.png, dấu . thành _
thresholds.json    ngưỡng so ảnh (mặc định + ghi đè theo mẫu)
render/            trang ứng viên trong Chromium (esbuild bundle clip-render)
scripts/
  candidate.mjs    clip-render vẽ mẫu → PNG, đích node hoặc browser
  compare.mjs      so thư mục ứng viên với references/
  serve.mjs        static server cho trang ứng viên, không phụ thuộc gì
.build/ .candidate-*/ .diff-*/ .frames/   bản build, ảnh ứng viên, ảnh diff, khung video — gitignore
```

## Chạy

```bash
# So một thư mục ứng viên (cùng bố cục <id>/<giây>s.png) với references/
npm run parity:compare -- --candidate <thư mục> [--diff <thư mục ảnh diff>] [--verbose] [id…]
```

Renderer mới (`@opencmo/clip-render`) vẽ ứng viên theo hai đường. `--phase A2`
chỉ đòi các mẫu mà giai đoạn hiện tại phải vẽ khớp (trường `phase` của manifest:
mẫu có chữ/phụ đề là A3):

```bash
npm run parity:candidate -- --target node       # export: @napi-rs/canvas
npm run parity:candidate -- --target browser    # preview: Chromium
npm run parity:compare -- --candidate .candidate-node --phase A2
```

`--diff` ghi ảnh cho mọi frame hỏng: nền là ảnh tham chiếu mờ đi, chỗ lệch tô
đỏ. **Mở ảnh diff ra xem** trước khi nới ngưỡng. Luật "phải nhìn vào clip" của
`CLAUDE.md` áp dụng ở đây.

Oracle vẽ khung LIỀN TRƯỚC mỗi mốc rồi bỏ ảnh đó. DS tính vài thứ từ lượt vẽ
trước (hộp group, font vừa nạp), nên khung đầu tiên sau khi mount bị sai: ở A0,
ảnh khung đầu của phụ đề đã ra font dự phòng serif. Khi phát liên tục, lượt trước
chỉ cách 1/30 s, nên người dùng không bao giờ thấy lỗi này.

Oracle khai báo Inter (thường + nghiêng thật) như CSS giao diện của editor
fork. Thiếu nó, chữ không ghi `fontFamily` ra serif dự phòng: đó là cái bẫy
của 16 ảnh chữ ở A0.

Hai cờ trong manifest:

- `linear`: phát liên tục từ khung 0 rồi mới lấy ảnh (guinea đổi màu theo số
  lần dòng đổi khi phát).
- `oracleBroken`: export của DS vẽ sai mẫu đó (stark mất chữ). Compare bỏ qua
  và in lý do; kiểm bằng mắt và bằng test.

- `oracle: "opencmo"`: tính năng DS không có (node `path`, spec visuals). Ảnh
  tham chiếu do đích `node` của clip-render vẽ rồi được duyệt bằng mắt; mẫu này
  giữ preview (Chromium) và export (Node) vẽ giống nhau và bắt hồi quy.
  `three-scene` (3D chiếu CPU) có ngưỡng tile 6: lưới 1.5 px trên mặt cong khử
  răng cưa khác nhau giữa hai bản Skia (đã xem ảnh diff: chỉ nét lưới, hình học
  trùng, mean 0.14).

`references/` không vẽ lại được nữa (DS đã gỡ). Đổi `times` của một mẫu là đổi
ảnh tham chiếu của nó — chỉ làm khi đã xem ảnh ứng viên và chấp nhận nó làm chuẩn.

## Phiên bản Chromium

Ảnh tham chiếu vẽ bằng **Chromium 141.0.7390.37** (bản có sẵn trong sandbox, cũng
là bản của Playwright 1.56.1). Raster chữ đổi theo phiên bản: 153 lệch tới tile
55 trên mẫu chữ. Đích `browser` phải chạy đúng bản đó: CI cài
`playwright@1.56.1` rồi trỏ `CHROMIUM` vào. Nâng Chromium thì vẽ lại toàn bộ
ảnh tham chiếu (không còn oracle: đổi Chromium là việc phải cân nhắc kỹ), không nới ngưỡng.

## Ngưỡng và cách đã đo

Mỗi frame đo hai số, cả hai phải ≤ ngưỡng:

| Số đo | Nghĩa | Bắt được |
|---|---|---|
| `mean` | lệch trung bình mỗi kênh RGBA (0–255) trên cả ảnh | màu, blend, easing lệch khắp khung |
| `tile` | lệch trung bình của ô 32×32 tệ nhất | lỗi cục bộ: thiếu một chữ, viền lệch, mask sai góc |

Số đo (24/09/2026, 540×960 và 1080×1920):

| Thí nghiệm | mean lớn nhất | tile lớn nhất |
|---|---|---|
| DS vẽ lại lần hai, 65 mẫu | 0.00 | 0.00 |
| Làm mờ AA nhẹ (`gblur σ=0.35`): chữ, viền, phụ đề, rect, xoay | 0.14 | 3.01 |
| Dời 1 px: rect / xoay | 0.21 | 2.77 |
| Dời 1 px: phụ đề | 0.51 | 7.13 |
| Dời 1 px: chữ, chữ viền | 1.08 | 21.63 |
| Ô đỏ 40×20 px dán lên `rect-basic` | 0.12 | 41.70 |
| `@napi-rs/canvas` (Node) vẽ `transition-dissolve` 2.25s | 0.51 | 0.53 |

DS tất định từng bit, nên ngưỡng không đo nhiễu DS mà đo **dung sai giữa hai bộ
raster** (Canvas2D của Chromium và `@napi-rs/canvas` phía server khử răng cưa
khác nhau). Chọn **`mean 1, tile 4`**: tile trên mức AA (3.01) và dưới mọi lần
dời chữ 1 px (≥ 6.2). Mean ban đầu là 0.5, nâng lên 1 ở A2: Skia CPU của Node trộn
alpha làm tròn khác Chromium, lệch ĐỀU ~0.5 mức trên cả khung (tile 0.53). Kiểu
lệch đều này mắt không thấy; lệch cục bộ vẫn do `tile` bắt. Dời 1 px một cạnh rect vẫn lọt (2.5–2.8). Đó là lệch làm tròn
toạ độ, mắt không thấy, và chặn nó thì chặn luôn khác biệt AA hợp lệ. Ô đỏ nhỏ
lọt qua `mean` (0.12) nhưng `tile` bắt được. Đó là lý do cần cả hai số.

Ghi đè theo mẫu (`thresholds.json` → `samples.<id>`) chỉ được thêm kèm lý do
trong commit và ảnh diff đã xem. Mặc định thì không bao giờ nới.

### Đường Node, mẫu có chữ: `mean 1, tile 14` (`--target node`)

Skia của `@napi-rs/canvas` đo bề rộng chữ lệch Chromium một phần rất nhỏ, và
khử răng cưa glyph khác. Cộng dồn đủ để một từ nhích 1 px (lớn nhất đo được:
tile 12.43, `cap-whisper`). Logic vẽ chữ đã được đích TRÌNH DUYỆT đo chặt: 66/66
mẫu, hầu hết lệch 0. Nên ở Node chỉ cần bắt lỗi thô: thiếu font (tile 80–110),
sai baseline (≥ 20). Ba chỗ Node lệch Chromium mà renderer đã tự bù:

- trục `wght`/`opsz`;
- baseline `top/middle/bottom` (bảng `emTop`);
- ascent rơi đúng nửa pixel (dời 1 px, đúng 600/600 tổ hợp font × cỡ đã đo).

### Mẫu có video: `mean 1.2, tile 6`

Ứng viên lấy khung video bằng ffmpeg (đường export trên server), còn DS giải
bằng WebCodecs của Chromium. Cùng một khung, hai bộ giải lệch nhau tới ~5/255
trên mảng màu phẳng (đo 24/09: mean ≤ 1.00, tile ≤ 5.25). Mắt không thấy, và
renderer không liên quan. Ngưỡng này vẫn bắt lỗi thật: chọn lệch MỘT khung cho
tile ≥ 37 trên clip có chuyển động.

Luồng video không ghi ma trận màu thì giải theo **BT.709** như Chromium. Theo
BT.601, mặc định của ffmpeg, màu đỏ lệch sang cam (tile 10–12).
