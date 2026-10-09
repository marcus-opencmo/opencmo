# @opencmo/editor-core

Mọi biến đổi project của một clip, trên **document JSON** (`@opencmo/clip-doc`):
không DOM, không runtime — chạy được trong trình duyệt lẫn trên Node
(`POST /api/v1/editor/ops`, Assistant). Từ B1 (spec editor-rewrite) document là
nguồn sự thật; TSX chỉ là bản cho fork Diffusion Studio đọc.

- `transcript.ts`: toán của transcript và cắt bằng chữ (thuần — import qua
  `@opencmo/editor-core/transcript` nếu chỉ cần phần này).
- `doc.ts`: đi trên cây theo thứ tự thẻ, tìm theo `id`, stamp id cho phần tử mới.
- `captions.ts`, `reframe.ts`, `summary.ts`: đọc/ghi trạng thái (mark
  `text-cut`, mark `reframe`) và bản tóm tắt cho agent.
- `ops/`: registry op có kiểu. **Đường ghi duy nhất** cho nút bấm, route ops và
  agent. `applyOps(document, ops, ctx)` không sửa document đầu vào.
  `ops/timeline.ts` (B3): dời, cắt đầu/cuối, tách, đổi chỗ lớp, dời keyframe,
  vùng làm việc — thời gian giải bằng `resolveTimes` của clip-render (cùng luật
  với lúc vẽ), độ dài nguồn qua `ctx.media`. Không cho Assistant gọi thẳng.
  `ops/inspector.ts` (B4): `set_props`, `set_keyframe`, `add_part`, `move_part`
  — đường ghi của inspector; cũng không cho Assistant gọi thẳng.
  `ops/library.ts` (B5): `insert_node` (chèn asset từ thư viện), `replace_src`
  (đổi tên asset thì `src` đi theo) — không cho Assistant gọi thẳng.
  `ops/structure.ts` (B7): nhân bản, dán, nhóm / bọc sequence / bọc scene, bỏ
  nhóm (nướng transform bằng `renderer.layout` của clip-render) — phím tắt và
  menu gọi; không cho Assistant gọi thẳng.
- `golden/`: 284 ca ghi từ bản TSX cũ; `golden.test.ts` giữ bản mới ra đúng như
  vậy (xem `golden/README.md`).

Fork gọi các hàm này qua `packages/editor/src/projects/doc-ops.ts` (TSX ↔
document). SourceWriter — đường ghi của canvas, code Diffusion Studio (MPL) —
nằm ở `packages/editor/src/projects/source-writer/`, không ở đây: package này
không mang code DS (`npm run check:clean-room`).

```bash
npm run test --workspace @opencmo/editor-core
npm run check --workspace @opencmo/editor-core
```
