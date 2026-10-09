/**
 * Catalog sinh media theo khả năng model (plan Palmier P1): cùng luật với
 * `ai_check_spec`/`ai_price` (SQL) và `validate_spec`/`price_of` (Python).
 */

import { describe, expect, it } from 'vitest';

import { aiModel, priceOf, specSchema, type AiModel } from './generate';

const model = (id: string) => aiModel(id) as AiModel;
const UID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('giá theo độ phân giải', () => {
	it('nhân hệ số rồi làm tròn lên; thiếu = 1', () => {
		expect(priceOf(model('fal-seedance'), { prompt: 'x', aspectRatio: '9:16', duration: 5, resolution: '720p' })).toBe(10);
		expect(priceOf(model('fal-seedance'), { prompt: 'x', aspectRatio: '9:16', duration: 10, resolution: '480p' })).toBe(10);
		expect(priceOf(model('fal-seedance'), { prompt: 'x', aspectRatio: '9:16', duration: 5 })).toBe(5);
		expect(priceOf(model('fal-kling'), { prompt: 'x', aspectRatio: '9:16', duration: 5 })).toBe(30);
	});
});

describe('trường theo khả năng model', () => {
	it('frame đầu/cuối chỉ ở model khai báo', () => {
		const ok = specSchema(model('fal-seedance')).safeParse({
			prompt: 'x', aspectRatio: '9:16', duration: 5, startImage: `${UID}/j/a.png`, endImage: `${UID}/j/b.png`,
		});
		expect(ok.success).toBe(true);
		expect(specSchema(model('fal-kling')).safeParse({ prompt: 'x', aspectRatio: '9:16', duration: 5, endImage: `${UID}/j/b.png` }).success).toBe(false);
	});

	it('tham chiếu có trần và phải là tên object media', () => {
		const banana = specSchema(model('fal-nano-banana'));
		expect(banana.safeParse({ prompt: 'x', aspectRatio: '1:1', references: [`${UID}/j/a.png`] }).success).toBe(true);
		expect(banana.safeParse({ prompt: 'x', aspectRatio: '1:1', references: Array(5).fill(`${UID}/j/a.png`) }).success).toBe(false);
		expect(banana.safeParse({ prompt: 'x', aspectRatio: '1:1', references: ['../secret.png'] }).success).toBe(false);
		expect(specSchema(model('gemini-image')).safeParse({ prompt: 'x', aspectRatio: '1:1', references: [`${UID}/j/a.png`] }).success).toBe(false);
	});

	it('độ phân giải ngoài danh sách bị từ chối', () => {
		expect(specSchema(model('fal-seedance')).safeParse({ prompt: 'x', aspectRatio: '9:16', duration: 5, resolution: '1080p' }).success).toBe(false);
	});
});

describe('sửa video (G2, video-to-video)', () => {
	it('bắt buộc video nguồn + giây bắt đầu; giá theo số giây cắt', () => {
		const edit = model('fal-kling-edit');
		const ok = { prompt: 'make it night', aspectRatio: '9:16', duration: 6, sourceVideo: `${UID}/j/clip.mp4`, sourceStart: 12.5 };
		expect(specSchema(edit).safeParse(ok).success).toBe(true);
		expect(specSchema(edit).safeParse({ ...ok, sourceVideo: undefined }).success).toBe(false);
		expect(specSchema(edit).safeParse({ ...ok, duration: 11 }).success).toBe(false);
		expect(specSchema(edit).safeParse({ ...ok, sourceVideo: '../x.mp4' }).success).toBe(false);
		expect(priceOf(edit, ok)).toBe(24);
		// Model sinh thường không nhận video nguồn.
		expect(specSchema(model('fal-kling')).safeParse({ prompt: 'x', aspectRatio: '9:16', duration: 5, sourceVideo: `${UID}/j/clip.mp4` }).success).toBe(false);
	});
});
