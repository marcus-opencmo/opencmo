import { describe, expect, it } from 'vitest';

import { validate, type ClipDocument } from '@opencmo/clip-doc';

import { priceOf, specSchema, aiModel } from './generate';
import { AGENT_OP_INPUTS, applyOps, frameRatio, planStudio3d, sceneSummary, type OpContext } from './ops';

const ctx = { master: { width: 1920, height: 1080 }, readTranscript: async () => [], saveTranscript: async () => 'x' } as unknown as OpContext;
const base = {
	version: 1,
	stage: { children: [{ kind: 'scene', id: 'sc', width: 1080, height: 1920, fill: '#000000', workarea: [0, 20], active: true, children: [] }] },
} as unknown as ClipDocument;

type Entity = Record<string, unknown> & { children?: Entity[] };
const children = (document: ClipDocument) => (document.stage.children[0] as unknown as Entity).children!;

const NUMBER = { template: 'number', value: 2400000, prefix: '$', label: 'Revenue' } as const;

describe('add_3d_studio', () => {
	it('đặt khai báo generate.video của studio-3d trong vùng visual, dài theo đoạn hiện', async () => {
		const { document } = await applyOps(base, [{ op: 'add_3d_studio', start: 2, end: 7.4, ...NUMBER }] as never, ctx);
		expect(() => validate(document)).not.toThrow();
		const rect = children(document).at(-1)!;
		expect(rect.kind).toBe('rect');
		expect(rect.start).toBe(2);
		expect(rect.end).toBe(7);
		const src = (rect.paints as { type: string; src: Record<string, unknown> }[])[0]!;
		expect(src.type).toBe('video');
		expect(src.src).toMatchObject({ generate: 'video', model: 'studio-3d', duration: 5, scene: NUMBER });
		// Vùng mặc định của khung dọc (rộng, thấp) → tỉ lệ ngang gần nhất.
		expect(src.src.aspectRatio).toBe('16:9');
		expect((rect.width as number) / (rect.height as number)).toBeCloseTo(16 / 9, 1);
	});

	it('frameRatio: hình khung của clip — dọc và ngang (clip TED 16:9, 02/10)', () => {
		expect(frameRatio(base)).toBe('9:16');
		const wide = structuredClone(base) as unknown as { stage: { children: Entity[] } };
		Object.assign(wide.stage.children[0]!, { width: 1920, height: 1080 });
		expect(frameRatio(wide as unknown as ClipDocument)).toBe('16:9');
	});

	it('đoạn quá ngắn/dài bị kẹp về 3–10 giây của model', async () => {
		const short = await applyOps(base, [{ op: 'add_3d_studio', start: 1, end: 2, ...NUMBER }] as never, ctx);
		expect(children(short.document).at(-1)!.end).toBe(4);
		const long = await applyOps(base, [{ op: 'add_3d_studio', start: 1, end: 19, ...NUMBER }] as never, ctx);
		expect(children(long.document).at(-1)!.end).toBe(11);
	});

	it('spec của kế hoạch qua được schema của model và giá 1 credit', async () => {
		const plan = await planStudio3d(base, { op: 'add_3d_studio', start: 0, end: 6, template: 'bars', bars: [{ label: 'A', value: 1 }, { label: 'B', value: 3, highlight: true }] } as never, ctx);
		const model = aiModel('studio-3d')!;
		const spec = specSchema(model).parse(plan.spec);
		expect(priceOf(model, spec)).toBe(1);
		expect(spec.prompt).toBe('3D bars A 1, B 3');
	});

	it('dữ liệu thiếu theo template bị từ chối bằng câu đọc được', async () => {
		await expect(applyOps(base, [{ op: 'add_3d_studio', start: 0, end: 5, template: 'bars' }] as never, ctx)).rejects.toThrow(/bars needs/);
		await expect(applyOps(base, [{ op: 'add_3d_studio', start: 0, end: 5, template: 'product', object: 'car' }] as never, ctx)).rejects.toThrow();
	});

	it('agent không gọi thẳng được (đi qua tool có thẻ giá)', () => {
		expect(AGENT_OP_INPUTS.add_3d_studio).toBeUndefined();
	});

	it('model video thường không nhận scene', () => {
		expect(specSchema(aiModel('fake-video')!).safeParse({ prompt: 'x', aspectRatio: '9:16', duration: 4, scene: NUMBER }).success).toBe(false);
	});

	it('câu tóm tắt đọc được', () => {
		expect(sceneSummary(NUMBER as never)).toBe('3D number $2.4M Revenue');
		expect(sceneSummary({ template: 'product', object: 'trophy', title: 'Winner' } as never)).toBe('Winner: 3D trophy');
	});
});

describe('add_3d_studio theo Brand Kit', () => {
	it('clip đã áp kit: scene mang màu + font của kit', async () => {
		const kit = {
			version: 1,
			colors: { primary: '#FF5A1F', secondary: '#1F2937', accent: '#22C55E', text: '#F9FAFB', background: '#111827' },
			fonts: { heading: 'Anton', body: 'DM Sans' },
			captions: { preset: 'spotlight' },
			layout: { aspect: '9:16', fit: 'fill' },
			logo: null,
		};
		const { document } = await applyOps(base, [{ op: 'apply_brand', kit, frame: false }, { op: 'add_3d_studio', start: 1, end: 6, ...NUMBER }] as never, ctx);
		const rect = children(document).at(-1)!;
		const scene = (rect.paints as { src: { scene: Record<string, unknown> } }[])[0]!.src.scene;
		expect(scene.brand).toEqual({ background: '#111827', text: '#F9FAFB', colors: ['#22C55E', '#FF5A1F', '#1F2937'], font: 'Anton' });
	});
});
