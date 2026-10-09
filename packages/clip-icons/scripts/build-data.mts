/**
 * Sinh `data/icons.json` từ `lucide-static` (ISC): mỗi icon thành MỘT chuỗi `d`
 * trong hệ 24×24, kèm tag để tìm. Node của clip-doc chỉ có `path`, nên circle/
 * rect/line/polyline/polygon/ellipse đổi sang lệnh path ở đây, một lần.
 *
 *   npx tsx packages/clip-icons/scripts/build-data.mts
 *
 * Mỗi thẻ SVG được đọc bằng parser của clip-doc rồi ghi lại bằng lệnh TUYỆT
 * ĐỐI: mỗi `<path>` của SVG bắt đầu lại ở (0,0), nên `m` tương đối ở đầu thẻ
 * là toạ độ tuyệt đối — nối thẳng các chuỗi `d` thì `m` đó thành tương đối với
 * điểm cuối của thẻ trước và icon vỡ ra ngoài hộp.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePath, type PathSegment } from '../../clip-doc/src/path.ts';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('lucide-static/package.json'));
const nodes = JSON.parse(readFileSync(join(root, 'icon-nodes.json'), 'utf8'));
const tags = JSON.parse(readFileSync(join(root, 'tags.json'), 'utf8'));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const n = (value: unknown) => Number(value ?? 0);
const f = (value: number) => String(Math.round(value * 1000) / 1000);

type Attrs = Record<string, string>;

/** Chuỗi `d` tuyệt đối từ các đoạn đã đọc. */
function absolute(segments: PathSegment[]): string {
  return segments
    .map((s) =>
      s.type === 'Z' ? 'Z'
      : s.type === 'C' ? `C${f(s.x1)} ${f(s.y1)} ${f(s.x2)} ${f(s.y2)} ${f(s.x)} ${f(s.y)}`
      : s.type === 'Q' ? `Q${f(s.x1)} ${f(s.y1)} ${f(s.x)} ${f(s.y)}`
      : `${s.type}${f(s.x)} ${f(s.y)}`,
    )
    .join('');
}

function toD([tag, attrs]: [string, Attrs]): string {
  switch (tag) {
    case 'path':
      return attrs.d;
    case 'line':
      return `M${f(n(attrs.x1))} ${f(n(attrs.y1))}L${f(n(attrs.x2))} ${f(n(attrs.y2))}`;
    case 'circle':
    case 'ellipse': {
      const rx = n(attrs.r ?? attrs.rx);
      const ry = n(attrs.r ?? attrs.ry);
      const cx = n(attrs.cx);
      const cy = n(attrs.cy);
      return `M${f(cx - rx)} ${f(cy)}a${f(rx)} ${f(ry)} 0 1 0 ${f(2 * rx)} 0a${f(rx)} ${f(ry)} 0 1 0 ${f(-2 * rx)} 0Z`;
    }
    case 'rect': {
      const x = n(attrs.x);
      const y = n(attrs.y);
      const w = n(attrs.width);
      const h = n(attrs.height);
      const r = Math.min(n(attrs.rx ?? attrs.ry), w / 2, h / 2);
      if (!r) return `M${f(x)} ${f(y)}h${f(w)}v${f(h)}h${f(-w)}Z`;
      return `M${f(x + r)} ${f(y)}h${f(w - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(r)}v${f(h - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(r)}h${f(-(w - 2 * r))}a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(-r)}v${f(-(h - 2 * r))}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(-r)}Z`;
    }
    case 'polyline':
    case 'polygon': {
      const points = attrs.points!.trim().split(/[\s,]+/).map(Number);
      let d = `M${f(points[0])} ${f(points[1])}`;
      for (let i = 2; i < points.length; i += 2) d += `L${f(points[i])} ${f(points[i + 1])}`;
      return tag === 'polygon' ? `${d}Z` : d;
    }
    default:
      throw new Error(`thẻ SVG chưa đổi được: ${tag}`);
  }
}

const icons: Record<string, { d: string; tags: string[] }> = {};
for (const [name, children] of Object.entries(nodes as Record<string, [string, Attrs][]>)) {
  icons[name] = { d: children.map((child) => absolute(parsePath(toD(child)))).join(''), tags: (tags as Record<string, string[]>)[name] ?? [] };
}
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'icons.json');
writeFileSync(out, JSON.stringify({ source: `lucide-static@${version}`, license: 'ISC', icons }));
console.log(`${Object.keys(icons).length} icon → ${out}`);
