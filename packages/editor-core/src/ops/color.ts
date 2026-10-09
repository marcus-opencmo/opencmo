/**
 * `apply_color` (E3, học tool `apply_color` / `apply_effect` của Palmier): chỉnh màu
 * một hay nhiều phần tử trong MỘT op, bằng tên thường dùng của colorist thay vì danh
 * sách effect thô. Mỗi khoá thay effect cùng loại đang có (giữ id) hoặc thêm mới; giá
 * trị 0 bỏ effect đó. Effect không phải chỉnh màu (blur, hueRotate…) không bị đụng.
 */

import { z } from 'zod';

import { NODE_SHAPES, type ClipDocument } from '@opencmo/clip-doc';

import { byId, clone, type Entity } from '../doc';
import { OpFailure } from './context';
import { checked } from './project';

const elementId = z.string().min(1).max(64);
const signed = z.number().min(-1).max(1);
const unit = z.number().min(0).max(1);
const point = z.tuple([unit, unit]);
const huePoint = z.tuple([unit, signed]);
const triple = z.tuple([signed, signed, signed]);

/** Mọi loại effect mà `apply_color` quản lý — `reset` chỉ xoá các loại này. */
const COLOR_EFFECTS = new Set([
  'exposure', 'vibrance', 'temperature', 'tint', 'vignette',
  'highlights', 'shadows', 'whites', 'blacks', 'saturation', 'curves', 'wheels', 'hueCurves',
  'chromaKey', 'sharpen', 'clarity', 'dehaze', 'grain', 'glow', 'motionBlur', 'lut',
]);

const adjustments = z
  .object({
    exposure: z.number().min(-2).max(2).optional().describe('Stops of light, -2…2.'),
    contrast: signed.optional().describe('-1…1, applied as a soft S-curve on the master curve.'),
    highlights: signed.optional(),
    shadows: signed.optional(),
    whites: signed.optional(),
    blacks: signed.optional(),
    saturation: signed.optional(),
    vibrance: signed.optional(),
    temperature: signed.optional().describe('+ warmer, − cooler.'),
    tint: signed.optional().describe('+ magenta, − green.'),
    clarity: signed.optional(),
    dehaze: signed.optional(),
    sharpen: unit.optional(),
    grain: unit.optional(),
    glow: unit.optional(),
    vignette: z
      .object({ amount: unit, midpoint: unit.optional(), roundness: unit.optional(), feather: unit.optional() })
      .optional(),
    curves: z
      .object({
        master: z.array(point).min(2).max(16).optional(),
        red: z.array(point).min(2).max(16).optional(),
        green: z.array(point).min(2).max(16).optional(),
        blue: z.array(point).min(2).max(16).optional(),
        strength: unit.optional(),
      })
      .optional()
      .describe('Tone curves: [input, output] points 0…1 per channel. Omit a channel to leave it straight.'),
    wheels: z
      .object({ lift: triple.optional(), gamma: triple.optional(), gain: triple.optional(), strength: unit.optional() })
      .optional()
      .describe('Lift (shadows), gamma (midtones), gain (highlights) as [r, g, b] offsets -1…1. Small values (±0.05–0.2) are a normal grade.'),
    hue_curves: z
      .object({ hue: z.array(huePoint).max(16).optional(), sat: z.array(huePoint).max(16).optional(), lum: z.array(huePoint).max(16).optional() })
      .optional()
      .describe('Per-hue changes: points [hue 0…1 (0 red, 0.33 green, 0.66 blue), change -1…1].'),
    chroma_key: z
      .object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/), range: unit.optional(), spill: unit.optional() })
      .optional()
      .describe('Make one background color transparent (green screen).'),
    motion_blur: z.object({ amount: unit, angle: z.number().min(-180).max(180).optional() }).optional(),
    lut: z
      .object({ path: z.string().min(1).max(500), strength: unit.optional() })
      .optional()
      .describe('A 3D .cube LUT from the library (list_library, type LUT) as the look; strength 0-1 (0 removes it).'),
  })
  .strict();

type Adjustments = z.infer<typeof adjustments>;
type ApplyColor = { element_ids: string[]; adjustments: Adjustments; reset?: boolean };
type Effect = { type: string; value: number; params?: Record<string, unknown>; id?: string };

const round = (value: number) => Math.round(value * 1e4) / 1e4;

/** S-curve tương phản trên master. */
const contrastCurve = (amount: number): [number, number][] => [
  [0, 0],
  [0.25, round(0.25 - 0.08 * amount)],
  [0.75, round(0.75 + 0.08 * amount)],
  [1, 1],
];

const compact = (params: Record<string, unknown>) => {
  const out = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
  return Object.keys(out).length ? out : undefined;
};

/** Danh sách (loại, effect mới hoặc null = bỏ) từ các khoá được gửi. */
function plan(input: Adjustments): [string, Omit<Effect, 'type'> | null][] {
  const out: [string, Omit<Effect, 'type'> | null][] = [];
  const scalar = (type: string, value: number | undefined) => {
    if (value === undefined) return;
    out.push([type, Math.abs(value) < 1e-4 ? null : { value: round(value) }]);
  };
  scalar('exposure', input.exposure);
  for (const type of ['highlights', 'shadows', 'whites', 'blacks', 'saturation', 'vibrance', 'temperature', 'tint', 'clarity', 'dehaze', 'sharpen', 'grain', 'glow'] as const) {
    scalar(type, input[type]);
  }
  if (input.vignette) {
    const { amount, ...rest } = input.vignette;
    out.push(['vignette', amount < 1e-4 ? null : { value: amount, params: compact(rest) }]);
  }
  if (input.contrast !== undefined && input.curves?.master) {
    throw new OpFailure('Pass contrast or a master curve, not both: contrast is drawn as a master curve.');
  }
  if (input.curves || input.contrast !== undefined) {
    const { strength, ...channels } = input.curves ?? {};
    const master = channels.master ?? (input.contrast ? contrastCurve(input.contrast) : undefined);
    const params = compact({ ...channels, master });
    out.push(['curves', params ? { value: strength ?? 1, params } : null]);
  }
  if (input.wheels) {
    const { strength, ...rest } = input.wheels;
    const params = compact(rest);
    out.push(['wheels', params ? { value: strength ?? 1, params } : null]);
  }
  if (input.hue_curves) {
    const params = compact({ ...input.hue_curves });
    out.push(['hueCurves', params ? { value: 1, params } : null]);
  }
  if (input.chroma_key) {
    const { range, ...rest } = input.chroma_key;
    out.push(['chromaKey', range === 0 ? null : { value: range ?? 0.4, params: { ...rest, color: rest.color.toUpperCase() } }]);
  }
  if (input.lut) {
    const { path, strength } = input.lut;
    out.push(['lut', strength === 0 ? null : { value: strength ?? 1, params: { src: path } }]);
  }
  if (input.motion_blur) {
    const { amount, angle } = input.motion_blur;
    out.push(['motionBlur', amount < 1e-4 ? null : { value: amount, params: compact({ angle }) }]);
  }
  return out;
}

export const applyColor = {
  name: 'apply_color',
  input: z.object({
    op: z.literal('apply_color'),
    element_ids: z.array(elementId).min(1).max(50).describe('Video, image or shape elements to grade.'),
    adjustments,
    reset: z.boolean().optional().describe('Remove every existing color adjustment first (start the grade over).'),
  }),
  describe: (input: ApplyColor) => (input.reset ? 'Regrade color' : 'Adjust color'),
  async apply(document: ClipDocument, input: ApplyColor) {
    const changes = plan(input.adjustments);
    if (!changes.length && !input.reset) throw new OpFailure('Nothing to change.');
    const next = clone(document);
    for (const id of new Set(input.element_ids)) {
      const hit = byId(next, id);
      if (!hit) throw new OpFailure(`There is no element "${id}" in this project.`);
      const shape = NODE_SHAPES[hit.tag as keyof typeof NODE_SHAPES];
      if (!shape || !('effects' in shape.shape)) throw new OpFailure(`"${id}" (${hit.tag}) cannot take color adjustments.`);
      const entity = hit.entity as Entity & { effects?: Effect[] };
      let effects = (entity.effects ?? []).filter((effect) => !(input.reset && COLOR_EFFECTS.has(effect.type)));
      for (const [type, change] of changes) {
        const index = effects.findIndex((effect) => effect.type === type);
        if (!change) {
          effects = effects.filter((effect) => effect.type !== type);
          continue;
        }
        const effect: Effect = { type, value: change.value, ...(change.params ? { params: change.params } : {}) };
        if (index >= 0) effects[index] = { ...effect, ...(effects[index]!.id ? { id: effects[index]!.id } : {}) };
        else effects.push(effect);
      }
      if (effects.length) entity.effects = effects;
      else delete entity.effects;
    }
    return checked(next, 'Those color values are not accepted');
  },
};
