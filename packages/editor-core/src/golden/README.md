# Fixture vàng của op (B1)

`ops.json.gz` ghi lại kết quả của bản editor-core CŨ (sửa TSX bằng ts-morph,
trước commit B1) trên 7 project gốc × 41 chuỗi op = 284 ca, gồm cả 79 ca lỗi có
chủ ý. Mỗi bước lưu `fromTsx(source)`, `summarizeProject`, `readCaptionState`,
`readFrame`, kết quả op và các transcript đã lưu.

Bản viết lại trên document (`../*.ts`) phải ra đúng như vậy — `golden.test.ts`.
Id mới sinh ngẫu nhiên nên được so theo vị trí (`#1`, `#2`…), không theo giá trị.

Không sinh lại file này: bản cũ đã bị xoá. Ca mới thì viết thành test thường.
Hai chỗ bản mới CỐ Ý khác bản cũ, test ghi rõ:

- `update_element` với `null`: bản cũ ghi `color={null}` — document không đọc
  được (lỗi thật). Bản mới hiểu `null` là bỏ prop.
- Nhãn trong `summarizeProject`: bản cũ trả văn bản nguồn — chữ JSX nguyên văn
  (`{"Watch {this}"}`) và lời gọi `generate.image({…})`. Bản mới trả chữ thật
  (`Watch {this}`) và null.
- Fixture sinh bằng `fromTsx` ĐÃ sửa lỗi khoảng trắng (`{'}'} {'<'}` từng ra hai
  dấu cách), chạy trên bản editor-core cũ ở một git worktree.
