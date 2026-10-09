# @opencmo/clip-doc

Document JSON của một clip — thứ `clip-render` vẽ, export trên Modal đọc, và
thứ duy nhất database lưu (từ C3). Spec:
`docs/specs/2026-09-24-editor-rewrite.md` (§4, §6).

```ts
import { migrate, validate } from '@opencmo/clip-doc';
const loaded = migrate(json);       // JSON đã lưu, version bất kỳ → version hiện tại
const checked = validate(json);     // migrate + trần cỡ + id không trùng: cửa của mọi đường ghi
```

- **Schema** ở `src/schema.ts` (zod). JSON schema cho Python sinh ra ở
  `packages/contracts/clip-document.schema.json`:
  `node packages/clip-doc/scripts/json-schema.ts` (CI chạy `--check`).
- **Thời gian luôn là giây.** `parseTime` đổi `"15f"`, `"02:30"` sang giây.
- **Không còn TSX** (R7): parser `fromTsx` đã gỡ cùng script backfill; 70 mẫu ảnh vàng là
  document JSON ở `packages/editor-parity/samples/<id>.json`.
- Import dùng đuôi `.ts` để Node 22 chạy thẳng không cần build (exporter dùng nó). Package nào import thì cần `allowImportingTsExtensions` trong tsconfig.

Kiểm:

```bash
npm run check:clip-doc      # tsc + JSON schema khớp zod
npm run test:clip-doc       # 70 mẫu JSON qua validate, parseTime, migrate, marks, hash
```

Viết mới hoàn toàn (clean-room): không chép code Diffusion Studio. Tên thẻ và prop
khớp JSX của DS vì đó là giao diện dữ liệu người dùng đang có, không phải vì mã.
