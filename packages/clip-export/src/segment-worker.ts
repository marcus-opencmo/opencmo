import { parentPort, workerData } from 'node:worker_threads';

import { renderSegment, type SegmentInput } from './segment.ts';

// Gom khung trước khi báo: một message mỗi khung là thừa (30 khung/giây video).
const BATCH = 15;
let pending = 0;
try {
  await renderSegment(workerData as SegmentInput, (count) => {
    pending += count;
    if (pending >= BATCH) {
      parentPort!.postMessage({ frames: pending });
      pending = 0;
    }
  });
  if (pending) parentPort!.postMessage({ frames: pending });
  parentPort!.postMessage({ ok: true });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: String((error as Error).stack ?? error) });
}
