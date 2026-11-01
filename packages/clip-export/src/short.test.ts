/** A short's own edit (P2 B3): `make_short`'s document renders only the short's range, at 9:16. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validate } from '@opencmo/clip-doc';
import { makeShort } from '@opencmo/editor-core';

import { exportJob } from './export.ts';

const FONTS = fileURLToPath(new URL('../../clip-media/fonts', import.meta.url));

describe('a short (ffmpeg)', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'clip-export-short-'));
    // A 16:9 finished edit, 3 s; frame N of the source is gray 2N.
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', "color=s=640x360:r=30:d=3,format=gray,geq=lum='2*N'", '-c:v', 'libx264', '-preset', 'veryfast', '-qp', '0', '-pix_fmt', 'yuv420p', join(dir, 'wide.mp4')]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Mean gray of the 40×40 top-left corner of frame `n`. */
  const grayAt = (file: string, n: number) => {
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n}),crop=40:40:0:0,format=gray`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
    return raw.reduce((sum, value) => sum + value, 0) / raw.length;
  };

  it('renders only its range, at 9:16', async () => {
    const parent = validate({
      version: 1,
      stage: { children: [{ kind: 'scene', name: 'Main', width: 640, height: 360, fill: '#000000', active: true, workarea: [0, 3], children: [
        { kind: 'video', src: 'assets/master.mp4', width: 640, height: 360, objectFit: 'cover', sourceOut: 3 },
      ] }] },
    });
    const short = await makeShort.apply(parent, { start: 1, end: 2 }, { master: { width: 640, height: 360 }, readTranscript: async () => [], saveTranscript: async () => 'x' });
    const out = join(dir, 'short.mp4');
    const result = await exportJob({ document: short, media: [{ src: 'assets/master.mp4', file: join(dir, 'wide.mp4') }], transcripts: [], fonts: FONTS, out, resolution: 720, parallel: 1 });
    expect(result).toMatchObject({ frames: 30, width: 720, height: 1280 });
    for (const n of [0, 15, 29]) expect(Math.abs(grayAt(out, n) - 2 * (30 + n))).toBeLessThan(3);
  });
});
