import { describe, expect, it } from 'vitest';

import { clipScript, clipWords, findQuote, formatScript, quoteTiming } from './script';
import type { Transcript } from './transcript';

/** Câu → từ có mốc đều, như fixture eval. */
function line(text: string, start: number, end: number) {
	const words = text.split(' ');
	const step = (end - start) / words.length;
	return { text, words: words.map((word, index) => ({ text: word, start: start + index * step, end: start + (index + 0.85) * step })) };
}

const TRANSCRIPT: Transcript = [
	line('So here is the one thing nobody tells you about growing an audience.', 10.3, 14.0),
	line('You do not need more content, you need better hooks.', 16.0, 20.5),
	line('Most people lose viewers in the first three seconds', 21.8, 26.0),
];

describe('clipScript', () => {
	it('đổi sang giây clip, gom câu theo dấu câu và chỗ lặng', () => {
		const words = clipWords(TRANSCRIPT, { start: 10, end: 26 }, []);
		const lines = clipScript(words);
		expect(lines.map((item) => item.text)).toEqual([
			'So here is the one thing nobody tells you about growing an audience.',
			'You do not need more content, you need better hooks.',
			'Most people lose viewers in the first three seconds',
		]);
		expect(lines[0]!.start).toBeCloseTo(0.3, 2);
		expect(formatScript(lines).split('\n')[1]).toMatch(/^\[6\.0–10\.\d\] You do not need/);
	});

	it('từ đã cắt biến mất, câu sau dời lên', () => {
		const words = clipWords(TRANSCRIPT, { start: 10, end: 26 }, [{ start: 15.9, end: 20.6 }]);
		const lines = clipScript(words);
		expect(lines.map((item) => item.text).join(' ')).not.toMatch(/hooks/);
		expect(lines.at(-1)!.start).toBeLessThan(8);
	});
});

describe('findQuote', () => {
	const words = clipWords(TRANSCRIPT, { start: 10, end: 26 }, []);

	it('khớp bỏ dấu câu, hoa thường; chịu sai một từ', () => {
		const exact = findQuote(words, 'you need better hooks');
		expect(exact?.score).toBe(1);
		expect(exact!.start).toBeGreaterThan(6);
		const fuzzy = findQuote(words, 'Most people lose their viewers in the first 3 seconds');
		expect(fuzzy).not.toBeNull();
		expect(fuzzy!.start).toBeCloseTo(11.8, 1);
	});

	it('transcript không có mốc từng chữ (cả dòng phụ đề là một "từ") vẫn tìm được câu', () => {
		// Phụ đề YouTube của clip TED (đo 01/10): mỗi dòng lưu thành MỘT từ — câu trích
		// ngắn hơn cả dòng không bao giờ khớp, mọi visual neo bằng quote đều hỏng.
		const lines = [
			{ text: 'and so I did the only thing I could:', start: 55.5, end: 57.5 },
			{ text: 'I wrote 90 pages over 72 hours,', start: 57.5, end: 60.2 },
			{ text: 'pulling not one but two all-nighters', start: 60.2, end: 62.5 },
		];
		const hit = findQuote(lines, 'I wrote 90 pages over 72 hours');
		expect(hit?.score).toBe(1);
		expect(hit!.start).toBe(57.5);
		expect(hit!.end).toBeCloseTo(60.2, 1);
		// Câu nằm giữa dòng: mốc chia theo độ dài chữ, không phải đầu dòng.
		const inner = findQuote(lines, 'two all-nighters')!;
		expect(inner.start).toBeGreaterThan(61);
		expect(inner.end).toBeCloseTo(62.5, 1);
	});

	it('câu không có trong clip → null', () => {
		expect(findQuote(words, 'compound interest is the eighth wonder')).toBeNull();
		expect(findQuote(words, '')).toBeNull();
	});

	it('mốc visual kéo tới hết câu, trong 2–6 giây', () => {
		const lines = clipScript(words);
		const hit = findQuote(words, 'nobody tells you')!;
		const timing = quoteTiming(hit, lines, 16);
		expect(timing.start).toBe(hit.start);
		expect(timing.end).toBeCloseTo(Math.max(lines[0]!.end, hit.start + 2), 2);
		expect(timing.end - timing.start).toBeLessThanOrEqual(6);
	});
});
