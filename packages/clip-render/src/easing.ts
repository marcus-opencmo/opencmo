/**
 * Easing của keyframe. Tên có sẵn mở thành cùng đường cong mà người dùng đang
 * thấy trong fork; `animejs` (MIT) tính spring/bezier/steps để khớp từng giá trị.
 */

import { cubicBezier, spring, steps } from 'animejs';

type Ease = (t: number) => number;

/**
 * Tên → tham số đường cong. Ba cái đầu là bezier chuẩn CSS; bốn spring là
 * [độ nảy, thời lượng ms] khớp đúng các preset người dùng chọn trong fork.
 */
const PRESETS: Record<string, readonly ['bezier', number, number, number, number] | readonly ['spring', number, number]> = {
  easeIn: ['bezier', 0.42, 0, 1, 1],
  easeOut: ['bezier', 0, 0, 0.58, 1],
  easeInOut: ['bezier', 0.42, 0, 0.58, 1],
  gentle: ['spring', 0.5, 628],
  snappy: ['spring', 0.15, 300],
  bouncy: ['spring', 0.4, 500],
  strong: ['spring', 0.65, 400],
};

const fromSpring = (bounce: number, duration: number): Ease => {
  const shape = spring({ bounce, duration });
  return (t) => shape.ease(t);
};

const cache = new Map<string, Ease | null>();

/** null = tuyến tính. */
export function easing(name: string | undefined): Ease | null {
  if (!name || name === 'linear') return null;
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const spec = name.replace(/\s+/g, '');
  let fn: Ease | null = null;
  const args = (text: string) => text.split(',').map(Number);
  let match: RegExpExecArray | null;
  const preset = PRESETS[name];
  if (preset) {
    fn = preset[0] === 'bezier' ? cubicBezier(preset[1], preset[2], preset[3], preset[4]) : fromSpring(preset[1], preset[2]);
  } else if ((match = /^cubicBezier\(([^)]*)\)$/.exec(spec))) {
    const [x1, y1, x2, y2] = args(match[1]!);
    fn = cubicBezier(x1!, y1!, x2!, y2!);
  } else if ((match = /^spring\(([^)]*)\)$/.exec(spec))) {
    const [bounce, duration] = args(match[1]!);
    fn = fromSpring(bounce!, duration!);
  } else if ((match = /^steps\((\d+)\)$/.exec(spec))) {
    fn = steps(Number(match[1]), false);
  }
  cache.set(name, fn);
  return fn;
}

/** Đường cong riêng của các animation dựng sẵn. */
export const curve = (x1: number, y1: number, x2: number, y2: number): Ease => cubicBezier(x1, y1, x2, y2);
