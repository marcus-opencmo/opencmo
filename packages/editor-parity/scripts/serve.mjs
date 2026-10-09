/**
 * Static server tối giản cho trang ứng viên: `/editor-parity/fixtures/*` → fixture,
 * `/render/*` → trang ứng viên (`.build/render`), `/frames/*` → khung video ffmpeg
 * đã tách, `/fonts/*` → font của app. Không phụ thuộc gì.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.webm': 'video/webm', '.mp4': 'video/mp4',
};

export function serve(root) {
  const routes = [
    ['/editor-parity/fixtures/', join(root, 'fixtures')],
    ['/render/', join(root, '.build', 'render')],
    ['/frames/', join(root, '.frames')],
    ['/fonts/', join(root, '..', 'clip-media', 'fonts')],
  ];
  const server = createServer((request, response) => {
    const url = decodeURIComponent((request.url ?? '/').split('?')[0]);
    // Trình duyệt tự xin favicon; trả 404 thì log đầy lỗi giả che mất fixture thiếu thật.
    if (url === '/favicon.ico') return void response.writeHead(204).end();
    for (const [prefix, dir] of routes) {
      if (!url.startsWith(prefix)) continue;
      const path = normalize(join(dir, url.slice(prefix.length)));
      if (!path.startsWith(dir) || !existsSync(path) || statSync(path).isDirectory()) break;
      response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
      createReadStream(path).pipe(response);
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
