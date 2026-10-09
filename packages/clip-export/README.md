# `@opencmo/clip-export`

Xuất document của một clip ra MP4 trong Node — đường export trên server (spec
`docs/specs/2026-09-24-editor-rewrite.md` §7). Worker Python (task
`render_document`) tải mọi nguồn về đĩa, ghi `job.json`, rồi gọi CLI này.

```bash
node packages/clip-export/src/cli.ts plan index.tsx 1080   # nguồn cần tải + cỡ khung
node packages/clip-export/src/cli.ts run job.json          # xuất
npm run check:clip-export && npm run test:clip-export      # test chạy ffmpeg thật
```

`job.json`: xem `src/job.ts` (`source`, `media[{src,file}]`, `transcripts`,
`fonts`, `out`, `resolution`, `videoFilter`, `parallel`).

## Cách chạy

1. Dò mọi nguồn (ffprobe), dựng renderer không vẽ để biết khoảng xuất
   (`workarea`) và biên độ tiếng từng khung.
2. Chia khoảng xuất thành vài đoạn liên tục. Mỗi đoạn là một worker thread: vẽ
   bằng `@opencmo/clip-render` trên `@napi-rs/canvas`, đẩy RGBA qua pipe cho
   một ffmpeg libx264.
3. Ghép đoạn bằng concat (`-c:v copy`), trộn tiếng, `+faststart`.

## Những thứ đã đo, đừng đổi mà không đo lại

- **Khung video**: mỗi nguồn là một ffmpeg giải mã tuần tự, `-ss` trước `-i`,
  giữ đúng một khung (luồng bị pause khi đệm đủ hai khung). Luật chọn khung như
  DS: khung đầu tiên có chỉ số ≥ `round(giây · fps)`. `-fps_mode passthrough`
  bắt buộc, thiếu nó mọi khung sau seek trễ một nhịp.
- **Màu**: nguồn không ghi ma trận giải theo BT.709 (như Chromium); bản ra
  mã hoá và gắn nhãn BT.709.
- **Số đoạn song song theo RAM** (`parallelFor`, ngân sách 1.5 GB): mỗi đoạn
  ~150 MB node + ~250 MB ffmpeg mã hoá + ~170 MB mỗi nguồn video. 4 đoạn trên
  một clip 1080×1920 là 3 GB.
- **Tiếng**: bus theo cây như DS, dB → biên độ mỗi khung qua `asendcmd`; mono
  lên stereo nguyên mức (Web Audio), không −3 dB như swresample mặc định.
