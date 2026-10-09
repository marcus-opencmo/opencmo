/**
 * Tiếng của một scene, theo đúng luật DS lúc xuất:
 *
 * - Mỗi node có MỘT nguồn tiếng: paint video cuối cùng, không có thì chính
 *   video/âm thanh của node. Node `muted` hay `hidden` (kể cả tổ tiên hidden)
 *   không kêu.
 * - Tiếng chạy liên tục trong `[start, end)` của node, bắt đầu ở `sourceIn`,
 *   giãn theo `playbackRate` mà giữ cao độ.
 * - Âm lượng là tích các bus từ scene xuống node: mỗi bus `10^(dB/20)`, câm khi
 *   `muted` hoặc −∞. dB đi qua track `volume` và animation `gain`, và được đặt
 *   lại MỖI KHUNG — nên export đổi âm lượng theo bậc 1/30 s, không nội suy.
 */

import type { AssetInput, ClipNode } from '@opencmo/clip-doc';

import { FPS, type RNode } from './tree.ts';

export type AudioClip = {
  src: AssetInput;
  /** Khung của scene: tiếng kêu trong `[start, end)`. */
  start: number;
  end: number;
  /** Giây của nguồn ứng với `start`. */
  sourceIn: number;
  rate: number;
  node: RNode;
};

type Audible = ClipNode & { hidden?: boolean; muted?: boolean; src?: AssetInput; paints?: { type: string; src?: AssetInput }[] };

function sourceOf(node: Audible): AssetInput | null {
  let src: AssetInput | null = null;
  if ((node.kind === 'video' || node.kind === 'audio') && node.src !== undefined) src = node.src;
  for (const paint of node.paints ?? []) if (paint.type === 'video' && paint.src !== undefined) src = paint.src;
  return src;
}

export function audioClips(root: RNode): AudioClip[] {
  const clips: AudioClip[] = [];
  const visit = (r: RNode) => {
    const node = r.node as Audible;
    if (node.hidden) return;
    const src = sourceOf(node);
    if (src !== null && !node.muted && r.end > r.start) {
      clips.push({
        src,
        start: r.start,
        end: r.end,
        sourceIn: Math.round((r.start - r.origin) * r.rate) / FPS,
        rate: r.rate,
        node: r,
      });
    }
    r.children.forEach(visit);
  };
  visit(root);
  return clips;
}

/** Biên độ (0–1+) của một clip ở khung vừa `evaluate`. */
export function audioGain(clip: AudioClip): number {
  if (!clip.node.visible) return 0;
  let gain = 1;
  for (let r: RNode | null = clip.node; r; r = r.parent) {
    const volume = r.values.volume;
    if ((r.node as Audible).muted || volume === -Infinity) return 0;
    gain *= 10 ** (volume / 20);
  }
  return gain;
}
