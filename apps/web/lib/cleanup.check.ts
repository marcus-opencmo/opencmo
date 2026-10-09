import assert from "node:assert/strict";

import {
  chunk,
  sweepOrphanPages,
} from "./cleanup";

async function main(): Promise<void> {
  // Deadline hết giữa hai lô: không mở thêm request, cũng không xoá sau reserve.
  let now = 0;
  const removed: string[] = [];
  await sweepOrphanPages({
    deadline: 50, now: () => now,
    scan: async () => { now += 30; return ['u/old.mp4']; },
    safe: async (paths) => { now += 30; return paths; },
    remove: async (paths) => { removed.push(...paths); return true; },
  });
  assert.deepEqual(removed, [], 'không bắt đầu remove sau deadline');
  let scannedPages = 0;
  await sweepOrphanPages({
    deadline: 50, now: () => 0, maxPages: 2,
    scan: async () => { scannedPages++; return ['u/live.mp4']; },
    safe: async () => [], remove: async () => true,
  });
  assert.equal(scannedPages, 2, 'invocation có trần trang cả khi mọi file còn live');
  const events: string[] = [];
  let scanCalls = 0;
  const total = await sweepOrphanPages({
    deadline: 50, now: () => 0,
    scan: async () => scanCalls++ ? [] : Array.from({length: 201}, (_, i) => `u/${i}`),
    safe: async (paths) => {
      events.push(`check:${paths.length}`);
      return paths.filter((path) => path !== 'u/200');
    },
    remove: async (paths) => { events.push(`remove:${paths.length}`); return true; },
  });
  assert.equal(total, 200, 'file trở thành live không bị xoá');
  assert.deepEqual(events, ['check:100','remove:100','check:100','remove:100','check:1'],
    'kiểm lại tham chiếu ngay trước từng lô remove');

  assert.deepEqual(
    chunk(Array.from({ length: 201 }, (_, index) => `u/orphan-${index}.mp4`), 100).map((batch) => batch.length),
    [100, 100, 1],
    "orphan deletes remain within the 100-object Storage batch bound",
  );

  console.log("cleanup sweep: mọi kiểm tra xanh");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
