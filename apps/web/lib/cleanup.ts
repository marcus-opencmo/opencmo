/** Mỗi trang đã lưu cursor ở DB nên dừng vì ngân sách vẫn tiến ở lượt sau. */
export async function sweepOrphanPages(options: {
  deadline: number;
  now?: () => number;
  maxPages?: number;
  scan: () => Promise<string[]>;
  safe: (paths: string[]) => Promise<string[]>;
  remove: (paths: string[]) => Promise<boolean>;
}): Promise<number> {
  const now = options.now ?? Date.now;
  let removed = 0;
  for (let page = 0; page < (options.maxPages ?? 10) && now() < options.deadline; page++) {
    const candidates = await options.scan();
    if (!candidates.length) break;
    for (const batch of chunk(candidates, 100)) {
      if (now() >= options.deadline) return removed;
      const safe = await options.safe(batch);
      if (now() >= options.deadline) return removed;
      if (safe.length && await options.remove(safe)) removed += safe.length;
    }
  }
  return removed;
}

export type CleanupQueueEntry = { id: number; bucket: string; path: string };

/** Chia thao tác Storage để không vượt giới hạn remove và để lỗi có phạm vi nhỏ. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}
