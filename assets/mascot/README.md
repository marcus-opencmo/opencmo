# Nhân vật OpenCMO

Concept trắng kem đã được Marcus duyệt. Model dựng bằng lệnh `execute_blender_code`
qua Blender MCP, có 25 bộ phận, vật liệu và cạnh bo được xuất vào GLB.

- `opencmo-mascot.blend`: file Blender có scene studio và nhân vật.
- `opencmo-mascot.glb`: chỉ nhân vật, không có camera, đèn, nền hoặc cube mặc định.
- `preview.png`: render thật từ Blender Cycles.
- `concept.png`: ảnh concept đã duyệt.
- `build.py`: script dựng hình; đường dẫn đầu ra hiện dành cho máy Marcus.

Bản đầu chưa có rig hoặc animation. Asset web ở `apps/web/public/mascot/`;
chưa gắn viewer 3D vào giao diện.

## MCP trên máy Marcus

Blender 5.2 Flatpak; addon ở thư mục cấu hình Flatpak `5.2/scripts/addons/blender_mcp.py`.
Codex đăng ký server `blender`, chạy `/home/marcus/.local/bin/blender-mcp`.
Telemetry đã tắt. Addon đã bật và lưu preferences, nghe ở localhost:9876.
Nguồn: https://github.com/ahujasid/blender-mcp (server 1.9.1).
Đã kiểm tra handshake, đọc scene, dựng mesh, lưu blend và xuất GLB qua MCP.
Phiên Codex mới cần nạp lại cấu hình để thấy tool mới trực tiếp.

## Animation chạy — 13/09/2026

- `opencmo-mascot-run.blend`: bản animation riêng, giữ nguyên file tĩnh.
- `opencmo-mascot-run.glb`: clip `Run Forward 2s`, thời gian 0–2 giây,
  8 kênh chuyển động; tay chân đánh ngược nhịp, thân nhún/nghiêng, root tiến 3 đơn vị.
- `animate.py`: dựng hệ pivot và keyframe qua Blender MCP từ scene tĩnh.
- Chuyển động dùng pivot cho các bộ phận cứng, chưa có skeleton deform.
- Clip có dịch chuyển gốc; phát một lần. Lặp trực tiếp sẽ nhảy về điểm đầu.
- Bản web nằm ở `apps/web/public/mascot/opencmo-mascot-run.glb`.

## Nước rút — bản thay thế theo phản hồi Marcus

- `opencmo-mascot-sprint.glb`: clip `Sprint 2s`, đúng 0–2 giây, 11 kênh;
  sáu chu kỳ, root tiến 12 đơn vị (gấp bốn lần bản chạy đầu).
- `opencmo-mascot-sprint.blend`: thân chúi 0.4 radian, khuỷu tay gập,
  thêm pivot đầu gối cho chân sau co cao; camera theo một phần quãng chạy.
- `sprint.py`: áp dụng lên scene có hệ pivot của `animate.py`.
- Asset web tương ứng trong `apps/web/public/mascot/`. Không thay model tĩnh.

## Logo lặp hoàn chỉnh — bản cũ

`opencmo-logo-loop.glb` có clip **OpenCMO Logo Loop**, 8 giây, 24 fps,
14 kênh chuyển động; mọi giá trị đầu/cuối khớp nhau (đã kiểm tra dữ liệu GLB).

| Thời điểm | Chuyển động |
| --- | --- |
| 0–1.5 giây | Đứng lắc lư nhẹ |
| 1.5–1.9 giây | Chúi người lấy đà |
| 1.9–3.9 giây | Chạy nước rút |
| 3.9–4.4 giây | Giảm nhịp, dừng |
| 4.4–6.7 giây | Cúi người thở gấp, miệng mở, mắt hơi nheo |
| 6.7–8 giây | Đứng thẳng, trở về tư thế đầu |

Dành cho logo: chạy tại chỗ trong khung cố định, không trôi khỏi vị trí logo.
File Blender là `opencmo-logo-loop.blend`; script là `logo-loop.py`, áp dụng
trên scene có pivot của bản sprint. Model tĩnh và các bản trước được giữ lại.
GLB không có nền. Bản render logo dùng RGBA trong suốt. Chưa gắn vào UI.
Đặt animation GLB ở chế độ Repeat, không dừng ở khung cuối. Với người dùng
bật reduced motion, hiển thị `logo-poster.png` thay vì tự chạy.

- `opencmo-logo-loop.webm`: video VP9 alpha 480×480, 24 fps, 8 giây;
  đã giải mã kiểm tra alpha có pixel trong suốt và đục.
- `logo-loop-preview.mp4`: bản xem trước trên nền sáng, 192 frame, 8 giây.
- WebM và poster đã có trong `apps/web/public/mascot/`.

## Loading chạy liên tục — bản hiện tại, 19/09/2026

Thay yêu cầu logo có nghỉ bằng **chạy nước rút liên tục tại chỗ, đổ mồ hôi**.
`opencmo-loading.glb` có một clip `Loading Sprint`, dài 1 giây, 30 fps,
3 chu kỳ chạy/giây, 16 kênh. Mọi giá trị đầu/cuối khớp nhau trong sai số 0.00001.
Ba giọt mồ hôi xanh nhạt trên trán chuyển động theo vòng lặp; không có đoạn
lấy đà, dừng, thở hoặc phục hồi. Camera cố định, nền trong suốt.

- `opencmo-loading.blend`: file 3D chỉnh sửa được.
- `loading-sprint.py`: áp dụng trên scene của `opencmo-logo-loop.blend`.
- `opencmo-loading.webp`: ảnh động 256×256 cho UI, tự lặp liên tục.
- `opencmo-loading.webm`: video 512×512 có alpha, dùng autoplay/muted/loop.
- `loading-poster.png`: ảnh tĩnh cho người dùng bật reduced motion.
- Bản web ở `apps/web/public/mascot/`. **Đã gắn vào giao diện 21/09** — xem mục cuối file.

Ví dụ dùng asset: `<img src="/mascot/opencmo-loading.webp" width="96"
height="96" alt="" />`, với nhãn trạng thái loading riêng. Khi
`prefers-reduced-motion: reduce`, thay ảnh động bằng `loading-poster.png`.

## Chạy ngang trái → phải, có đường đua — 19/09/2026

Bản `opencmo-track-sprint` thêm đường chạy terracotta, vạch làn, vạch đích
caro và biển FINISH ở bên phải. Nhân vật giữ mồ hôi và nhịp nước rút,
root đi từ X=-12 tới X=12 trong 3 giây, không di chuyển sâu vào màn hình.
Camera cố định. Nhân vật đi ra mép phải rồi xuất hiện lại từ mép trái khi lặp;
đây là vòng lặp theo khung hình, không phải root motion khép kín trong thế giới 3D.

- `opencmo-track-sprint.blend` và `.glb`: scene và animation có background.
- `opencmo-track-sprint.webp`: ảnh động lặp cho UI, nền đường chạy.
- `track-preview.mp4`: video xem trước, 720×360, 30 fps, 3 giây.
- `track-sprint.py`: áp dụng lên scene bản Loading Sprint.
- Ảnh động này KHÔNG dùng trực tiếp trong UI; xem mục cuối file.

Bản loading nền trong suốt trước đó vẫn được giữ riêng.


## Đã gắn vào giao diện — 21/09/2026

Chỉ hai file được dùng, và cả hai đều là ảnh trong thẻ `<img>`: không GLB, không
three.js, không `<video>`. Lý do: thêm một viewer 3D là ~600KB JS cho một cái
spinner, còn `.webm` thì cần `autoplay`.

| File | Dùng ở đâu |
|---|---|
| `opencmo-loading.webp` | mọi trạng thái chờ, và nhân vật trên đường đua ở màn xử lý |
| `loading-poster.png` | bản tĩnh khi `prefers-reduced-motion: reduce` |
| `apps/web/public/mascot/track.webp` | nền đường đua — **file dẫn xuất**, xem dưới |

`track.webp` cắt ra từ `track-frames/frame-0001.png` (khung đầu, chưa có nhân
vật), bỏ bớt nền trống trên/dưới:

```bash
ffmpeg -y -i assets/mascot/track-frames/frame-0001.png \
  -vf "crop=720:250:0:45" -quality 90 apps/web/public/mascot/track.webp
```

`opencmo-track-sprint.webp` **không** dùng trong UI. Nó ghép sẵn nhân vật chạy
từ mép trái sang mép phải trong ba giây, nên không đặt được nhân vật theo stage
của job. Màn xử lý dựng hai lớp thay vào đó: nền là `track.webp` tĩnh, nhân vật
là `opencmo-loading.webp` (nền trong suốt, chạy tại chỗ) đặt `left` theo stage.
Vạch caro nằm ở ~77% bề rộng ảnh, nên đó là mốc "xong" chứ không phải mép phải.

Đổi ảnh nền thì phải đo lại vị trí vạch caro và cập nhật `STAGE_MARK` trong
`apps/web/components/clipping/ProcessingView.tsx`.
