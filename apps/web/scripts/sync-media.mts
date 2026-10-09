/**
 * Chép font + Lottie của clip (`packages/clip-media`) sang `public/` để web phục
 * vụ cùng origin (CSP `font-src 'self'`). Chạy ở `predev`/`prebuild` và trong
 * `scripts/dev.mjs`; hai đích nằm trong `.gitignore`.
 *
 * Chép lại toàn bộ mỗi lần (vài chục MB, dưới một giây): so mtime để bỏ qua
 * thì một file bị xoá ở nguồn sẽ còn sống mãi ở đích.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = join(WEB, '..', '..', 'packages', 'clip-media');

for (const name of ['fonts', 'lottie']) {
  const from = join(MEDIA, name);
  if (!existsSync(from)) throw new Error(`Thiếu ${from} — font/Lottie của clip đã dời sang packages/clip-media.`);
  const to = join(WEB, 'public', name);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}
