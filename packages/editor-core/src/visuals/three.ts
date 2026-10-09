/**
 * `add_3d`: cảnh 3D kiểu manim (spec visuals V5) — mặt cong z = f(x, y), khối,
 * trục, logo đùn nổi, camera bay quanh. clip-render chiếu trên CPU nên preview
 * và export giống nhau; đây chỉ đặt node `scene3d` vào vùng và cho nó hiện ra.
 */

import { z } from 'zod';

import { Camera3DSchema, Light3DSchema, Object3DSchema } from '@opencmo/clip-doc';

import { appear, fitSize, r2, textNode, type Box, type Node } from './common';
import { regionSchema } from './shape';

export const threeInput = z.object({
	objects: z.array(Object3DSchema).min(1).max(16),
	camera: Camera3DSchema.optional(),
	light: Light3DSchema.optional(),
	title: z.string().trim().min(1).max(60).optional(),
	region: regionSchema.optional(),
	background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export type ThreeInput = z.infer<typeof threeInput>;

export function buildThree(input: ThreeInput, frame: { width: number; height: number }, area: Box): Node[] {
	const unit = Math.min(frame.width, frame.height) / 1080;
	const out: Node[] = [];
	let body = area;
	if (input.title) {
		const h = Math.min(area.height * 0.14, 90 * unit);
		out.push({ ...textNode(input.title, { x: area.x, y: area.y, width: area.width, height: h }, { size: fitSize([input.title], area.width, h, 60 * unit) }), animations: appear('fade', 0) });
		body = { x: area.x, y: area.y + h * 1.1, width: area.width, height: area.height - h * 1.1 };
	}
	out.push({
		kind: 'scene3d',
		x: r2(body.x),
		y: r2(body.y),
		width: r2(body.width),
		height: r2(body.height),
		objects: input.objects,
		...(input.camera ? { camera: input.camera } : {}),
		...(input.light ? { light: input.light } : {}),
		...(input.background ? { background: input.background } : {}),
		animations: appear('fade', 0, 0.4),
	});
	return out;
}
