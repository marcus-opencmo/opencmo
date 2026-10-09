#!/usr/bin/env node
/**
 *   clip-export plan <document.json> [720|1080]   # JSON: nguồn cần tải + cỡ khung
 *   clip-export run <job.json>               # xuất; in JSON kết quả ra stdout
 *
 * `plan` chạy trước khi tải gì: worker biết phải lấy file nào, và dựng watermark
 * theo đúng chiều cao bản xuất (filter ffmpeg của nó tính cỡ chữ theo chiều cao).
 */

import { readFileSync } from 'node:fs';

import { validate } from '@opencmo/clip-doc';
import { mediaSources, outputSize, pickScene } from '@opencmo/clip-render';

import { exportJob } from './export.ts';
import { sourceKey } from './job.ts';

const [command, file, resolution] = process.argv.slice(2);
try {
  if (command === 'plan' && file) {
    const document = validate(JSON.parse(readFileSync(file, 'utf8')));
    const seen = new Set<string>();
    const sources = mediaSources(document).filter(({ kind, src }) => {
      const key = `${kind}:${sourceKey(src)}`;
      return !seen.has(key) && seen.add(key);
    });
    const { width, height } = outputSize(pickScene(document), Number(resolution ?? 1080));
    process.stdout.write(`${JSON.stringify({ sources, width, height })}\n`);
  } else if (command === 'run' && file) {
    const result = await exportJob(JSON.parse(readFileSync(file, 'utf8')), (line) => process.stderr.write(`${line}\n`));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stderr.write('dùng: clip-export plan <document.json> [720|1080] | clip-export run <job.json>\n');
    process.exit(2);
  }
} catch (error) {
  process.stderr.write(`${String((error as Error).stack ?? error)}\n`);
  process.exit(1);
}
