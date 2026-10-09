/**
 * Duyệt hình nhanh: ghép PNG ở vài mốc giây của một spec thành một tấm.
 *   npx tsx packages/clip-three/scripts/stills.mts <spec.json> <out.png> [giây,giây,…]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderStills } from '../src/render.ts';

const [file, out, list] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(file!, 'utf8'));
const times = (list ?? `${spec.duration * 0.25},${spec.duration * 0.55},${spec.duration - 0.1}`).split(',').map(Number);
const started = Date.now();
const images = await renderStills(spec, times);
const dir = mkdtempSync(join(tmpdir(), 'stills-'));
const inputs = images.flatMap((image, index) => {
	const path = join(dir, `${index}.png`);
	writeFileSync(path, image);
	return ['-i', path];
});
if (images.length === 1) writeFileSync(out!, images[0]!);
else execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', `hstack=${images.length}`, out!]);
console.log(`${images.length} ảnh, ${Date.now() - started} ms`);
