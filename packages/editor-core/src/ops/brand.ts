/**
 * `apply_brand` (spec brand-kit BK4): áp một Brand Kit lên clip trong MỘT op —
 * một checkpoint, một lần Undo:
 *
 * - mark `brand` trên scene (visual thêm sau đọc màu/font từ đây);
 * - kiểu phụ đề (preset, màu, cỡ, vị trí);
 * - font chữ của các lớp chữ (tiêu đề) và màu/font của visual đã có;
 * - logo ở góc, cả clip (`marks.brand-logo`: áp lại thì THAY, không nhân đôi);
 * - khung theo tỉ lệ của kit (`frame: false` để giữ khung hiện tại).
 *
 * Logo trỏ `brand:<object>` — nguồn riêng (bucket `brand`, không hết hạn theo
 * job); editor và worker đều biết cách nạp nó.
 */

import { z } from 'zod';

import type { ClipDocument } from '@opencmo/clip-doc';

import { BrandKitSchema, brandFrame, readBrand, rebrand, themeFromBrand, type BrandKit } from '../brand';
import { clone, sceneOf, walk, type Entity } from '../doc';
import { readFrame, writeFrame } from '../reframe';
import { OpFailure, type OpContext } from './context';
import { checked } from './project';

export const BRAND_SRC_PREFIX = 'brand:';
export const LOGO_MARK = 'brand-logo';

type ApplyBrand = { op: 'apply_brand'; kit: BrandKit; frame?: boolean };

const r = (value: number) => Math.round(value * 100) / 100;

/** Hộp của logo trong khung: góc của kit, lề 4% cạnh ngắn, chừa chỗ watermark ở góc dưới phải. */
export function logoBox(kit: BrandKit, frame: { width: number; height: number }) {
	const logo = kit.logo!;
	const width = r(frame.width * logo.size);
	const height = r((width * logo.height) / logo.width);
	const margin = r(Math.min(frame.width, frame.height) * 0.04);
	const right = logo.corner.endsWith('right');
	const bottom = logo.corner.startsWith('bottom');
	// Watermark bản free nằm góc dưới phải: logo góc đó lùi lên một dòng chữ.
	const lift = bottom && right ? r(frame.height * 0.05) : 0;
	return {
		x: right ? r(frame.width - margin - width) : margin,
		y: bottom ? r(frame.height - margin - height - lift) : margin,
		width,
		height,
	};
}

export const applyBrand = {
	name: 'apply_brand',
	// Kit là của người dùng (trang Brand kit, menu Apply brand kit), không phải
	// thứ agent tự bịa: agent chỉ đọc brand đã áp trong <clip_context>.
	agent: false,
	input: z.object({ op: z.literal('apply_brand'), kit: BrandKitSchema, frame: z.boolean().optional() }),
	describe: () => 'Apply the brand kit',
	async apply(document: ClipDocument, input: ApplyBrand, ctx?: OpContext) {
		const kit = input.kit;
		let next = document;

		// Khung trước: đổi khung dời lại mọi thứ theo tỉ lệ mới, logo tính sau.
		if (input.frame !== false) {
			const current = readFrame(next);
			const size = brandFrame(kit.layout.aspect);
			if (current && (current.width !== size.width || current.height !== size.height || current.mode !== kit.layout.fit)) {
				if (!ctx?.master) throw new OpFailure('The clip video is not ready yet. Try again in a moment.');
				try {
					next = writeFrame(next, { ...size, mode: kit.layout.fit }, ctx.master, ctx.viewport);
				} catch (error) {
					throw new OpFailure((error as Error).message);
				}
			}
		}

		next = clone(next);
		const scene = sceneOf(next) as Entity | undefined;
		if (!scene || !scene.width || !scene.height) throw new OpFailure('This project has no scene to edit.');
		const before = themeFromBrand(readBrand(next));
		const theme = themeFromBrand(kit);
		scene.marks = { ...((scene.marks as Record<string, unknown> | undefined) ?? {}), brand: kit };

		walk(next, ({ entity, tag }) => {
			if (tag === 'captions') {
				entity.preset = kit.captions.preset;
				entity.colors = kit.captions.colors?.length ? [...kit.captions.colors] : [kit.colors.accent];
				if (kit.captions.fontScale !== undefined) entity.fontScale = kit.captions.fontScale;
				if (kit.captions.position) entity.verticalAlign = kit.captions.position;
			}
		});

		const children = ((scene.children as Entity[] | undefined) ?? []).filter((child) => !(child.marks as Record<string, unknown> | undefined)?.[LOGO_MARK]);
		for (const [index, child] of children.entries()) {
			const marks = child.marks as Record<string, unknown> | undefined;
			// Visual đã có: đổi từ màu của kit cũ (hoặc mặc định) sang kit mới.
			if (marks?.visual) children[index] = rebrand(child, theme, before);
			// Lớp chữ của clip (tiêu đề, CTA): font tiêu đề của kit.
			else if (child.kind === 'text') child.fontFamily = kit.fonts.heading;
		}

		if (kit.logo) {
			const workarea = scene.workarea as [number, number] | undefined;
			children.push({
				kind: 'rect',
				name: 'Logo',
				keepAspectRatio: true,
				...logoBox(kit, { width: scene.width as number, height: scene.height as number }),
				opacity: kit.logo.opacity,
				...(workarea ? { start: workarea[0], end: workarea[1] } : {}),
				paints: [{ type: 'image', src: `${BRAND_SRC_PREFIX}${kit.logo.object}` }],
				marks: { [LOGO_MARK]: true },
			});
		}
		scene.children = children as never;
		return checked(next, 'That brand kit cannot be applied to this clip');
	},
};
