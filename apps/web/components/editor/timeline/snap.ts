/**
 * Mép bị kéo dính vào đâu (checklist TML-02): đầu scene, playhead, vùng làm
 * việc, và mép của mọi clip KHÔNG đang di chuyển. Tính bằng frame chứ không
 * bằng pixel — một frame là đơn vị thật của timeline, và làm tròn qua lại theo
 * pixel làm clip giật một frame quanh điểm dính ở mức zoom lẻ.
 *
 * Bỏ khỏi đích: chính các clip đang kéo, con cháu của chúng (đi theo chúng),
 * và tổ tiên dạng group bao con (mép của nó đi theo thứ đang kéo).
 */

import type { ClipNode } from "@opencmo/clip-doc";
import type { TimeNode } from "@opencmo/clip-render";

export function snapTargets(times: Map<ClipNode, TimeNode>, moving: Set<ClipNode>, extra: number[]): number[] {
  const skip = new Set<TimeNode>();
  for (const node of moving) {
    const t = times.get(node);
    if (!t) continue;
    const down = (item: TimeNode) => {
      skip.add(item);
      item.children.forEach(down);
      item.masks.forEach(down);
    };
    down(t);
    for (let up = t.parent; up; up = up.parent) if (up.fits) skip.add(up);
  }
  const out = new Set<number>(extra);
  for (const t of times.values()) {
    if (skip.has(t) || t.node.kind === "scene") continue;
    out.add(t.start);
    out.add(t.end);
  }
  return [...out];
}

/** Đích gần `frame` nhất trong `threshold` frame, hoặc null. */
export function snapFrame(frame: number, targets: number[], threshold: number): number | null {
  let best: number | null = null;
  for (const target of targets) {
    if (Math.abs(target - frame) <= threshold && (best === null || Math.abs(target - frame) < Math.abs(best - frame))) {
      best = target;
    }
  }
  return best;
}

/**
 * Một lượt dính cho cả nhóm đang kéo: trong mọi mép (đầu và cuối của từng
 * clip) dời `delta`, mép nào gần đích nhất quyết định. Trả delta đã chỉnh và
 * frame của điểm dính (để vẽ đường gióng).
 */
export function snapDelta(
  edges: number[],
  delta: number,
  targets: number[],
  threshold: number,
): { delta: number; at: number } | null {
  let best: { delta: number; at: number; distance: number } | null = null;
  for (const edge of edges) {
    const target = snapFrame(edge + delta, targets, threshold);
    if (target === null) continue;
    const distance = Math.abs(target - (edge + delta));
    if (!best || distance < best.distance) best = { delta: target - edge, at: target, distance };
  }
  return best && { delta: best.delta, at: best.at };
}

/** Bước vạch chính của thước: khoảng "tròn" gần ~160 px nhất. */
const STEPS = [1, 2, 5, 10, 15, 30, 60, 150, 300, 450, 900, 1800, 3600, 9000, 18000];
export function rulerStep(pixelsPerFrame: number, target = 160): number {
  for (const step of STEPS) if (step * pixelsPerFrame >= target) return step;
  return STEPS[STEPS.length - 1]!;
}
