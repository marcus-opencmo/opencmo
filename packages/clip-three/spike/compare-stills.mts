// So khung của runtime cục bộ (cùng runtime với preview) với MP4 render trên Modal.
import { readFileSync, writeFileSync } from 'node:fs';
import { renderCodeStills } from '../src/render.ts';
const [codePath, outPrefix] = process.argv.slice(2);
const result = await renderCodeStills({ code: readFileSync(codePath!, 'utf8'), width: 540, height: 960, duration: 4 }, [0.5, 2, 3.7]);
if (!result.ok) throw new Error(`${result.phase}: ${result.message}`);
result.images.forEach((image, index) => writeFileSync(`${outPrefix}-${index}.jpg`, Buffer.from(image.split(',').pop()!, 'base64')));
console.log(JSON.stringify(result.reports.map((r) => r), null, 0).slice(0, 1500));
