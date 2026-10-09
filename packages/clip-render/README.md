# @opencmo/clip-render

Vẽ document của clip (`@opencmo/clip-doc`) ra Canvas 2D. Cùng một mã chạy trong
trình duyệt (preview và chụp khung của editor mới) và trong Node qua
`@napi-rs/canvas` (export trên Modal). Spec: `docs/specs/2026-09-24-editor-rewrite.md`
§4, §7.

```ts
import { createRenderer, mediaSources } from '@opencmo/clip-render';

const renderer = createRenderer(document, media);      // media: MediaHost
const frame = renderer.exportFrame(t);                  // t = giây của bản xuất
for (const need of renderer.needs(frame)) await load(need);
renderer.render(ctx, frame);                            // đồng bộ, tất định
```

- **Không tự tải gì.** `MediaHost` trả ảnh / khung video / độ dài nguồn. Nơi chạy
  nạp trước theo `needs(frame)`: trình duyệt dùng `ImageBitmap`, Node dùng ffmpeg.
- **Thời gian là frame 30 fps**, làm tròn như fork. `exportFrame` tính từ đầu
  `workarea`.
- **Vẽ như fork, kể cả chỗ trông lạ.** Opacity, blend và filter không cô lập
  lớp. Pivot là tâm hộp. Node tĩnh có `scaleX` thì bỏ `scale`. Chi tiết ở đầu
  `frame.ts` và `draw.ts`, và ở checklist §4.
- **Chữ và phụ đề (A3).** Phụ đề dựng một `<text>` ảo mỗi khung theo preset
  (`captions.ts`); `MediaHost.transcript` trả transcript đã đọc sẵn. Font: bảng
  `FONTS` (10 họ + nghiêng Inter thật). Nơi chạy phải nạp đủ các file đó.
- **Node khác Chromium ở ba chỗ, renderer tự bù** khi context có
  `fontVariationSettings`: trục font variable, baseline hộp em, và ascent nửa
  pixel. Chi tiết ở đầu `text.ts` và `fonts.ts`.

Kiểm:

```bash
npm run check:clip-render && npm run test:clip-render
npm run parity:candidate -- --target node      # hoặc --target browser
npm run parity:compare -- --candidate .candidate-node --phase A2
```

Viết mới hoàn toàn (clean-room). Hành vi lấy từ việc chạy DS (`editor-parity`,
`scripts/probe.mjs`) và đọc cách nó chạy, không chép mã. `check:clean-room` chặn
trên CI.
