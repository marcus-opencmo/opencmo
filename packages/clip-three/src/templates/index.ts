import type { SceneSpec, Template } from '../spec.ts';
import type { Stage } from '../studio.ts';
import { bars } from './bars.ts';
import { number } from './number.ts';
import { product } from './product.ts';
import { rise } from './rise.ts';

/** Template dựng sẵn → hàm dựng cảnh, trả `update(t)` (giây). Cảnh `code` đi đường riêng (`code/scene.ts`): code không nằm trong spec. */
export const TEMPLATES: Record<Exclude<Template, 'code'>, (stage: Stage, spec: SceneSpec) => (t: number) => void> = { bars, number, rise, product };
