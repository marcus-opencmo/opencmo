import { describe, expect, it } from 'vitest';

import {
  lottieInfo,
  addAsset,
  childrenOf,
  createFolder,
  deleteFolder,
  foldersOf,
  moveAssets,
  moveFolder,
  normalizeManifest,
  orphanedMedia,
  recordFor,
  removeAssets,
  renameAsset,
  renameFolder,
  stemOf,
  typeOfMime,
  uniquePath,
  type AssetRecord,
  type Manifest,
} from './index.ts';

const asset = (id: string, path: string, extra: Partial<AssetRecord> = {}): AssetRecord => ({
  id,
  path,
  source: `assets/${path}`,
  type: 'VIDEO',
  mimeType: 'video/mp4',
  createdAt: '2026-09-25T00:00:00Z',
  ...extra,
});
const lib = (...assets: AssetRecord[]): Manifest => ({ version: 1, folders: [], assets });

describe('manifest', () => {
  it('bỏ record hỏng, giữ khoá lạ, chuẩn hoá đường dẫn', () => {
    const out = normalizeManifest({
      folders: ['a//b/', 'a/b', 7],
      assets: [
        { ...asset('x', '/clips\\one.mp4'), cloud: { state: 'synced', mediaId: 'm' } },
        { id: 'x', path: 'dup.mp4', source: 's', type: 'VIDEO', mimeType: 'video/mp4' },
        { id: 'y', path: 'no-source.mp4', type: 'VIDEO', mimeType: 'video/mp4' },
        { id: 'z', path: 'gen.png', type: 'IMAGE', state: 'pending', generation: { key: '{}' } },
        { id: 'w', path: 'weird', type: 'MOVIE', source: 's', mimeType: 'x' },
      ],
    });
    expect(out.folders).toEqual(['a/b']);
    expect(out.assets.map((record) => [record.id, record.path])).toEqual([['x', 'clips/one.mp4'], ['z', 'gen.png']]);
    expect((out.assets[0] as AssetRecord).cloud).toEqual({ state: 'synced', mediaId: 'm' });
    expect(normalizeManifest(null)).toEqual({ version: 1, folders: [], assets: [] });
  });

  it('thư mục ngầm có từ đường dẫn asset; con trực tiếp', () => {
    const manifest = { ...lib(asset('a', 'x/y/one.mp4'), asset('b', 'two.mp4')), folders: ['empty'] };
    expect(foldersOf(manifest)).toEqual(['empty', 'x', 'x/y']);
    expect(childrenOf(manifest, '').folders).toEqual(['empty', 'x']);
    expect(childrenOf(manifest, 'x/y').assets.map((record) => record.id)).toEqual(['a']);
  });

  it('src gọi tên theo path trước, rồi source', () => {
    const manifest = lib(asset('a', 'renamed.mp4', { source: 'assets/original.mp4' }));
    expect(recordFor(manifest, 'renamed.mp4')?.id).toBe('a');
    expect(recordFor(manifest, 'assets/original.mp4')?.id).toBe('a');
    expect(recordFor(manifest, 'original.mp4')).toBeUndefined();
  });
});

describe('tên không trùng', () => {
  it('thêm " 2", " 3" trước phần mở rộng', () => {
    const manifest = lib(asset('a', 'b-roll.mp4'), asset('b', 'b-roll 2.mp4'));
    expect(uniquePath(manifest, 'b-roll.mp4')).toBe('b-roll 3.mp4');
    expect(uniquePath(manifest, 'b-roll.mp4', 'a')).toBe('b-roll.mp4');
    expect(uniquePath(manifest, 'x/b-roll.mp4')).toBe('x/b-roll.mp4');
  });

  it('thêm asset: mới nhất lên đầu, cùng id thì giữ bản cũ', () => {
    const first = addAsset(lib(asset('a', 'one.mp4')), asset('b', 'one.mp4'));
    expect(first.manifest.assets.map((record) => record.path)).toEqual(['one 2.mp4', 'one.mp4']);
    const again = addAsset(first.manifest, asset('a', 'other.mp4'));
    expect(again.manifest).toBe(first.manifest);
    expect(again.record.path).toBe('one.mp4');
  });
});

describe('đổi tên, dời, xoá', () => {
  it('đổi tên asset giữ thư mục và source, báo src phải đổi', () => {
    const out = renameAsset(lib(asset('a', 'cuts/one.mp4')), 'a', 'intro/b.mp4');
    expect(out.manifest.assets[0]).toMatchObject({ path: 'cuts/intro-b.mp4', source: 'assets/cuts/one.mp4' });
    expect(out.renames).toEqual([{ from: 'cuts/one.mp4', to: 'cuts/intro-b.mp4' }]);
    const same = lib(asset('a', 'one.mp4'));
    expect(renameAsset(same, 'a', 'one.mp4').manifest).toBe(same);
  });

  it('dời asset vào thư mục', () => {
    const out = moveAssets(lib(asset('a', 'one.mp4'), asset('b', 'x/one.mp4')), ['a'], 'x');
    expect(out.manifest.assets.map((record) => record.path)).toEqual(['x/one 2.mp4', 'x/one.mp4']);
    expect(out.renames).toEqual([{ from: 'one.mp4', to: 'x/one 2.mp4' }]);
  });

  it('đổi tên/dời thư mục kéo theo con; không dời vào chính nó; trùng tên thì thêm số', () => {
    const base = { ...lib(asset('a', 'x/y/one.mp4')), folders: ['x', 'x/y', 'z'] };
    const renamed = renameFolder(base, 'x', 'z');
    expect(renamed.manifest.folders).toEqual(['z', 'z 2', 'z 2/y']);
    expect(renamed.renames).toEqual([{ from: 'x/y/one.mp4', to: 'z 2/y/one.mp4' }]);
    expect(moveFolder(base, 'x', 'x/y').manifest).toBe(base);
    const moved = moveFolder(base, 'x/y', 'z');
    expect(moved.manifest.assets[0]!.path).toBe('z/y/one.mp4');
  });

  it('xoá thư mục xoá cả bên trong; Storage chỉ xoá bản không ai còn dùng', () => {
    const base = {
      ...lib(
        asset('a', 'x/one.mp4', { cloud: { state: 'synced', mediaId: 'm1' } }),
        asset('b', 'two.mp4', { cloud: { state: 'synced', mediaId: 'm1' } }),
        asset('c', 'x/deep/three.mp4', { cloud: { state: 'synced', mediaId: 'm3' } }),
      ),
      folders: ['x', 'x/deep'],
    };
    const out = deleteFolder(base, 'x');
    expect(out.manifest.assets.map((record) => record.id)).toEqual(['b']);
    expect(out.manifest.folders).toEqual([]);
    expect(orphanedMedia(out.manifest, out.removed)).toEqual(['m3']);
    expect(removeAssets(base, ['nope']).manifest).toBe(base);
  });

  it('tạo thư mục một lần', () => {
    const once = createFolder(lib(), 'Clips/');
    expect(once.folders).toEqual(['Clips']);
    expect(createFolder(once, 'Clips')).toBe(once);
  });
});

it('tên element mặc định và loại theo MIME', () => {
  expect(stemOf('x/b-roll 2.mp4')).toBe('b-roll 2');
  expect(typeOfMime('video/webm')).toBe('VIDEO');
  expect(typeOfMime('application/pdf')).toBeNull();
  expect(typeOfMime('application/x-subrip')).toBe('TRANSCRIPT');
  expect(typeOfMime('text/vtt')).toBe('TRANSCRIPT');
});

it('id theo nội dung: ổn định, khác nội dung thì khác, file lớn chỉ băm mẫu', async () => {
  const { contentId } = await import('./index.ts');
  const a = await contentId(new Blob(['hello']));
  expect(a).toMatch(/^[0-9a-f]{16}$/);
  expect(await contentId(new Blob(['hello']))).toBe(a);
  expect(await contentId(new Blob(['hellO']))).not.toBe(a);
  const big = new Uint8Array(4 * 1024 * 1024);
  const same = new Uint8Array(big);
  same[1024 * 1024 + 10] = 7; // ngoài ba đoạn mẫu
  expect(await contentId(new Blob([same]))).toBe(await contentId(new Blob([big])));
  // Cùng công thức với fork: sha256("5" + "hello") cắt 16 ký tự.
  const { createHash } = await import('node:crypto');
  expect(a).toBe(createHash('sha256').update('5hello').digest('hex').slice(0, 16));
});

describe('lottieInfo', () => {
  it('nhận Lottie, trả cỡ + độ dài; transcript và JSON hỏng thì null', () => {
    expect(lottieInfo(JSON.stringify({ v: '5.7.0', fr: 30, ip: 0, op: 45, w: 400, h: 300, layers: [] }))).toEqual({ width: 400, height: 300, duration: 1.5 });
    expect(lottieInfo(JSON.stringify([{ words: [{ word: 'hi', start: 0, end: 1 }] }]))).toBeNull();
    expect(lottieInfo(JSON.stringify({ segments: [] }))).toBeNull();
    expect(lottieInfo('{nope')).toBeNull();
  });
});
