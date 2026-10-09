/**
 * Khoảng lặng của clip, đọc từ khoảng hở giữa các từ trong transcript — thứ
 * `media_waveform` của DS đưa ra bằng sóng âm, ở đây có sẵn mà không phải
 * giải mã âm thanh. Chỉ xét từ còn giữ (chưa cắt) trong cửa sổ clip.
 *
 * `cut` là gợi ý cho `remove_ranges`: chừa lại `keep` giây (chia đều hai
 * phía) để câu không dính vào nhau.
 */

import { isRemoved, keptRanges, round, toOutput, type Range, type Transcript } from './transcript';

export type Silence = {
	/** Giây NGUỒN, cùng thang với `get_transcript`. */
	start: number;
	end: number;
	duration: number;
	/** Mốc trên timeline của clip (sau cắt); null khi nằm trong khoảng đã cắt. */
	output_start: number | null;
	after_word_id: string | null;
	before_word_id: string | null;
	/** Khoảng nên cắt, hay null khi chừa `keep` thì không còn gì. */
	cut: Range | null;
};

export function findSilences(
	model: { transcript: Transcript; window: Range; removed: Range[] },
	options: { minGap?: number; keep?: number } = {},
): Silence[] {
	const minGap = options.minGap ?? 0.5;
	const keep = options.keep ?? 0.2;
	const kept = keptRanges(model.window, model.removed);
	const words = model.transcript
		.flatMap((segment) => segment.words)
		.filter((word) => word.end > model.window.start && word.start < model.window.end && !isRemoved(word, model.removed))
		.sort((a, b) => a.start - b.start);
	const out: Silence[] = [];
	const push = (start: number, end: number, after: string | null, before: string | null) => {
		// Phần đã cắt của khoảng hở không còn là khoảng lặng người xem nghe thấy.
		const audible = kept.reduce((sum, range) => sum + Math.max(0, Math.min(end, range.end) - Math.max(start, range.start)), 0);
		if (audible < minGap) return;
		const cutStart = after === null ? start : start + keep / 2;
		const cutEnd = before === null ? end : end - keep / 2;
		out.push({
			start: round(start),
			end: round(end),
			duration: round(audible),
			output_start: toOutput(start, kept) ?? toOutput(end, kept),
			after_word_id: after,
			before_word_id: before,
			cut: cutEnd - cutStart >= 0.05 ? { start: round(cutStart), end: round(cutEnd) } : null,
		});
	};
	let cursor = model.window.start;
	let previous: string | null = null;
	for (const word of words) {
		if (word.start - cursor >= minGap) push(cursor, word.start, previous, word.id ?? null);
		cursor = Math.max(cursor, word.end);
		previous = word.id ?? null;
	}
	if (model.window.end - cursor >= minGap) push(cursor, model.window.end, previous, null);
	return out;
}
