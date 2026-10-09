/**
 * Bản op trên document phải ra đúng như bản TSX cũ, trên 284 ca ghi sẵn
 * (`golden/README.md`).
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import type { ClipDocument, ClipNode } from '@opencmo/clip-doc';

import { readCaptionState, readCaptionStyle } from './captions';
import { same, sceneOf } from './doc';
import { OpError, applyOps, captionsOnTop, type OpContext } from './ops';
import { fitCamera, readFrame, type Viewport } from './reframe';
import { summarizeProject, type ProjectSummary } from './summary';
import type { Transcript } from './transcript';

type Step =
  | { results: unknown; document: ClipDocument; summary: ProjectSummary; captionState: unknown; frame: unknown }
  | { error: { index: number | null; op: string | null; message: string } };
type Case = { name: string; base: string; ops: unknown[][]; viewport?: Viewport; steps: Step[]; files: Record<string, Transcript> };
type Golden = {
  transcript: Transcript;
  bases: Record<string, ClipDocument>;
  direct: Record<
    string,
    {
      summary: ProjectSummary;
      captionState: unknown;
      captionStyle: unknown;
      frame: unknown;
      fitCamera: ClipDocument;
      fitCameraSame: boolean;
    }
  >;
  cases: Case[];
};

const golden = JSON.parse(
  gunzipSync(readFileSync(new URL('./golden/ops.json.gz', import.meta.url))).toString('utf8'),
) as Golden;

function memoryContext(viewport?: Viewport) {
  const files = new Map<string, Transcript>([['assets/transcript.json', golden.transcript]]);
  const ctx: OpContext = {
    master: { width: 1920, height: 1080 },
    readTranscript: async (path) => {
      const found = files.get(path);
      if (!found) throw new Error(`missing ${path}`);
      return structuredClone(found);
    },
    saveTranscript: async (transcript) => {
      const path = `assets/transcripts/${String(files.size).padStart(64, '0')}.json`;
      files.set(path, structuredClone(transcript));
      return path;
    },
    ...(viewport ? { viewport } : {}),
  };
  return { ctx, files };
}

/** Mọi id có trong document gốc. */
function idsOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => idsOf(item, into));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'id' && typeof item === 'string') into.add(item);
      else idsOf(item, into);
    }
  }
  return into;
}

/**
 * Id mới (không có trong gốc) thành `#1`, `#2`… theo thứ tự gặp khi duyệt với
 * khoá sắp xếp — hai document cùng nội dung ra cùng một bản.
 */
function normalizer(known: Set<string>) {
  const fresh = new Map<string, string>();
  const rename = (id: string) => {
    if (known.has(id)) return id;
    if (!fresh.has(id)) fresh.set(id, `#${fresh.size + 1}`);
    return fresh.get(id)!;
  };
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => {
          const item = (value as Record<string, unknown>)[key];
          return [key, key === 'id' && typeof item === 'string' ? rename(item) : walk(item)];
        }),
    );
  };
  return { walk, rename };
}

/**
 * Nhãn bản cũ là văn bản NGUỒN: chữ JSX nguyên văn (`{"Watch {this}"}`) và lời
 * gọi `generate.image({…})`. Bản mới trả chữ thật và null — nhãn chữ được kiểm
 * riêng (`summary.test`), ở đây chỉ so phần còn lại.
 */
const comparable = (tag: string, label: string | null) =>
  tag === 'text' || label?.startsWith('generate.') ? null : label;

function summaryShape(summary: ProjectSummary, rename: (id: string) => string) {
  const elements = summary.elements
    .map((element) => ({ ...element, id: element.id && rename(element.id), label: comparable(element.tag, element.label) }))
    .map((element) => JSON.stringify(element))
    .sort();
  return { ...summary, elements };
}

/**
 * CỐ Ý khác bản cũ: bản cũ đặt ảnh/video `add_generated` lên TRÊN CÙNG scene,
 * che mất phụ đề và tiêu đề hook (UAT 29/09). Bản mới đặt nó ngay dưới lớp
 * chữ/phụ đề đầu tiên. Dời lớp đó trong bản chờ đợi rồi so như thường — mọi
 * prop còn lại vẫn phải khớp.
 */
const isGeneratedVisual = (node: ClipNode) =>
  node.kind === 'rect' &&
  !!(node.paints as { src?: { generate?: string } }[] | undefined)?.some(
    (paint) => paint.src?.generate === 'image' || paint.src?.generate === 'video',
  );

function generatedBelowText(document: ClipDocument): ClipDocument {
  const next = structuredClone(document);
  const scene = sceneOf(next);
  if (!scene?.children) return next;
  const generated = scene.children.filter(isGeneratedVisual);
  if (!generated.length) return next;
  const rest = scene.children.filter((node) => !isGeneratedVisual(node));
  const at = rest.findIndex((node) => node.kind === 'captions' || node.kind === 'text');
  rest.splice(at < 0 ? rest.length : at, 0, ...generated);
  scene.children = rest;
  return next;
}

/**
 * CỐ Ý khác bản cũ: video/tiếng `add_generated` mang `end = start + duration`.
 * Bản cũ để trống, nên trong lúc chờ layer dài 16 giây mặc định (Veo 4s hiện
 * thành 16s, UAT production 29/09). Chỉ thêm khi bản chờ đợi CHƯA có `end`.
 */
function generatedWithEnd(document: ClipDocument): ClipDocument {
  const next = structuredClone(document);
  const visit = (nodes: ClipNode[] | undefined) => {
    for (const node of nodes ?? []) {
      const own = node as ClipNode & { src?: { generate?: string; duration?: number }; start?: number; end?: number };
      const declaration =
        own.src ??
        ((node as { paints?: { src?: { generate?: string; duration?: number } }[] }).paints ?? []).find((paint) => paint.src)?.src;
      const timed = declaration?.generate === 'video' || declaration?.generate === 'audio';
      if (timed && own.end === undefined && typeof declaration?.duration === 'number') {
        own.end = Math.round(((own.start ?? 0) + declaration.duration) * 1000) / 1000;
      }
      visit((node as { children?: ClipNode[] }).children);
    }
  };
  visit(sceneOf(next)?.children);
  return next;
}

/**
 * CỐ Ý khác bản cũ: media `add_generated` vào một HÀNG (`sequence` "B-roll N" /
 * "Audio N", `tracks.ts`) thay vì một lớp riêng của scene (UAT 09/10). Gỡ hàng ra
 * tại chỗ trước khi so — hàng nằm đúng chỗ lớp cũ nằm, mọi prop của con giữ nguyên.
 */
function withoutRows(document: ClipDocument): ClipDocument {
  const next = structuredClone(document);
  const scene = sceneOf(next);
  if (!scene?.children) return next;
  scene.children = scene.children.flatMap((node) =>
    node.kind === 'sequence' && /^(B-roll|Audio) \d+$/.test(String(node.name)) ? ((node as { children?: ClipNode[] }).children ?? []) : [node],
  );
  return next;
}

const hasGeneratedVisual = (ops: unknown[][]) =>
  ops.flat().some((op) => {
    const item = op as { op?: string; kind?: string };
    return item.op === 'add_generated' && (item.kind === 'image' || item.kind === 'video');
  });

describe('golden: op trên document = op trên TSX cũ', () => {
  it('đủ ca', () => {
    expect(golden.cases.length).toBe(284);
  });

  it.each(golden.cases.map((test) => [test.name, test] as const))('%s', async (_name, test) => {
    const { ctx, files } = memoryContext(test.viewport);
    const base = golden.bases[test.base]!;
    const known = idsOf(base);
    let document = structuredClone(base);
    let edited = false;
    for (const [index, ops] of test.ops.entries()) {
      const expected = test.steps[index]!;
      if ('error' in expected) {
        if (test.name.endsWith('/update-text-null')) {
          // Bản cũ ghi `color={null}` — lỗi thật; bản mới bỏ prop.
          const { document: next } = await applyOps(document, ops, ctx);
          const text = summarizeProject(next).elements.find((element) => element.tag === 'text')!;
          const node = JSON.stringify(next).includes('"color":null');
          expect(node).toBe(false);
          expect(text).toBeTruthy();
          return;
        }
        const error = await applyOps(document, ops, ctx).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(OpError);
        expect({ index: (error as OpError).index, op: (error as OpError).op, message: (error as OpError).message }).toEqual(
          expected.error,
        );
        return;
      }
      const before = structuredClone(document);
      const result = await applyOps(document, ops, ctx);
      expect(document, 'op không được sửa document đầu vào').toEqual(before);
      document = result.document;
      const flat = withoutRows(document);
      // Mỗi bên một bảng đổi tên: id mới của hai bản là hai dãy ngẫu nhiên khác nhau.
      const mine = normalizer(known);
      const theirs = normalizer(known);
      const reordered = hasGeneratedVisual(test.ops.slice(0, index + 1)) ? generatedBelowText(expected.document) : expected.document;
      const ended = generatedWithEnd(reordered);
      // CỐ Ý khác bản cũ: từ lượt op đầu tiên có đổi document, phụ đề nằm lớp
      // trên cùng (`captionsOnTop`) — bản cũ để chữ/tiếng thêm sau nằm trên phụ đề.
      edited ||= !same(result.document, before);
      const wanted = edited ? captionsOnTop(ended) : ended;
      // `end` mới hay thứ tự lớp mới cũng đổi tóm tắt: khi đó so với tóm tắt của chính bản chờ đợi đã chỉnh.
      const wantedSummary =
        JSON.stringify(wanted) === JSON.stringify(expected.document) ? expected.summary : summarizeProject(wanted);
      expect(mine.walk(flat)).toEqual(theirs.walk(wanted));
      expect(result.results).toEqual(expected.results);
      expect(readCaptionState(document)).toEqual(expected.captionState);
      expect(readFrame(document)).toEqual(expected.frame);
      expect(summaryShape(summarizeProject(flat), mine.rename)).toEqual(summaryShape(wantedSummary, theirs.rename));
    }
    expect(Object.fromEntries([...files].filter(([path]) => path !== 'assets/transcript.json'))).toEqual(test.files);
  });

  it.each(Object.keys(golden.direct))('đọc trực tiếp: %s', (name) => {
    const base = golden.bases[name]!;
    const expected = golden.direct[name]!;
    const { rename } = normalizer(idsOf(base));
    expect(summaryShape(summarizeProject(base), rename)).toEqual(summaryShape(expected.summary, rename));
    expect(readCaptionState(base)).toEqual(expected.captionState);
    expect(readCaptionStyle(base)).toEqual(expected.captionStyle);
    expect(readFrame(base)).toEqual(expected.frame);
    const fitted = fitCamera(base, { width: 900, height: 600 });
    expect(fitted).toEqual(expected.fitCamera);
    expect(fitted === base).toBe(expected.fitCameraSame);
  });
});
