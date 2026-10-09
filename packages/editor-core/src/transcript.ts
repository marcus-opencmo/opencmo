/**
 * Sửa transcript, và phần toán của "sửa video bằng chữ".
 *
 * Thuần: không DOM, không store, không runtime — để test được từng ca biên
 * (từ lặp ở ranh giới, khoảng trống, mốc chồng nhau) mà không dựng editor.
 *
 * ## Hai thang thời gian
 *
 * - **Nguồn**: giây của file `master.mp4`. Transcript engine sinh ra, và mọi
 *   `sourceIn`/`sourceOut` trong TSX, đều ở thang này.
 * - **Output**: giây của clip sau khi cắt. Transcript mà `<captions>` đọc SAU
 *   khi cắt ở thang này, vì `<captions>` không nằm trong `<sequence>` của các
 *   đoạn video — nó chạy thẳng trên timeline của scene.
 *
 * Cắt luôn tính lại TỪ transcript nguồn và danh sách khoảng đã xoá, không bao
 * giờ cắt tiếp trên một transcript đã cắt: cắt chồng lên kết quả của lần cắt
 * trước là cách chắc chắn để mốc trôi dần sau mỗi lượt.
 */

/**
 * `id` là tên ổn định của một từ — thứ agent và panel dùng để nói "từ này"
 * thay cho vị trí `[đoạn, từ]`, vốn đổi mỗi lần tách/gộp dòng. Transcript của
 * engine không có id; `normalize` đặt cho nó (xem `wordId`).
 */
export type Word = { id?: string; text: string; start: number; end: number };
export type Segment = { text: string; words: Word[] };
export type Transcript = Segment[];

/** Một khoảng theo thang NGUỒN, `[start, end)`. */
export type Range = { start: number; end: number };

/** Làm tròn mili-giây: mốc ghi vào TSX và JSON, và 0.30000000000000004 không nên là một mốc. */
export const round = (value: number): number => Math.round(value * 1000) / 1000;

const joinWords = (words: Word[]): string =>
	words
		.map((word) => word.text.trim())
		.filter(Boolean)
		.join(' ');

/**
 * Id của một từ chưa có tên: theo mốc bắt đầu (ms, base36), không theo thứ tự.
 * Cùng một transcript nguồn luôn ra cùng bộ id, nên panel đọc file lần này và
 * route `/editor/ops` đọc lại lần sau nói về cùng những từ — không phải lưu
 * transcript chỉ để có id. Trùng mốc thì thêm hậu tố.
 */
function wordId(start: number, taken: Set<string>): string {
	const base = `w${Math.max(0, Math.round(start * 1000)).toString(36)}`;
	let id = base;
	for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
	return id;
}

/**
 * Chuẩn hoá thứ đến từ file: bỏ từ rỗng, sắp theo mốc, `text` của đoạn là
 * chữ của các từ — decoder của DS vẽ `words`, còn `text` chỉ để đọc, và hai
 * thứ lệch nhau là panel hiện một câu khác với câu trên canvas.
 */
export function normalize(transcript: Transcript): Transcript {
	const out: Transcript = [];
	for (const segment of transcript) {
		const words = (segment.words ?? [])
			.filter((word) => word && typeof word.text === 'string' && word.text.trim() !== '')
			.map((word) => ({
				id: typeof word.id === 'string' && word.id ? word.id : undefined,
				text: word.text.trim(),
				start: round(word.start),
				end: round(Math.max(word.start, word.end)),
			}))
			.sort((a, b) => a.start - b.start);
		if (!words.length) continue;
		out.push({ text: joinWords(words), words });
	}
	// Hai lượt: id có sẵn giữ chỗ trước, rồi mới đặt tên cho từ chưa có — một
	// từ mới không được giành mất id của một từ đã có tên đứng sau nó.
	const taken = new Set<string>();
	for (const word of out.flatMap((segment) => segment.words)) {
		if (word.id && !taken.has(word.id)) taken.add(word.id);
		else word.id = undefined;
	}
	for (const word of out.flatMap((segment) => segment.words)) {
		if (word.id) continue;
		word.id = wordId(word.start, taken);
		taken.add(word.id);
	}
	return out;
}

/** Vị trí `[đoạn, từ]` của một id, hoặc null khi transcript không có từ đó. */
export function locateWord(transcript: Transcript, id: string): [number, number] | null {
	for (let s = 0; s < transcript.length; s++) {
		const w = transcript[s]!.words.findIndex((word) => word.id === id);
		if (w >= 0) return [s, w];
	}
	return null;
}

const clone = (transcript: Transcript): Transcript =>
	transcript.map((segment) => ({ text: segment.text, words: segment.words.map((word) => ({ ...word })) }));

/**
 * Đổi chữ của một từ. Chuỗi có dấu cách thì thành NHIỀU từ, chia đều khoảng
 * thời gian của từ cũ theo độ dài chữ — người dùng gõ "gonna" thành "going to"
 * phải ra hai từ, không phải một "từ" chứa dấu cách mà preset nhấn từng từ sẽ
 * nhấn cả cụm. Chuỗi rỗng là xoá từ đó khỏi phụ đề (không cắt video).
 */
export function setWordText(transcript: Transcript, at: [number, number], text: string): Transcript {
	const next = clone(transcript);
	const segment = next[at[0]];
	const word = segment?.words[at[1]];
	if (!segment || !word) return next;

	const parts = text.trim().split(/\s+/).filter(Boolean);
	if (!parts.length) {
		segment.words.splice(at[1], 1);
	} else {
		const total = parts.reduce((sum, part) => sum + part.length, 0);
		const span = word.end - word.start;
		let cursor = word.start;
		const words = parts.map((part, index) => {
			const end = index === parts.length - 1 ? word.end : round(cursor + (span * part.length) / total);
			// Từ đầu giữ tên cũ: "gonna" → "going to" vẫn là từ người ta đã chọn.
			const piece: Word = { id: index === 0 ? word.id : undefined, text: part, start: round(cursor), end };
			cursor = end;
			return piece;
		});
		segment.words.splice(at[1], 1, ...words);
	}
	return normalize(next);
}

/** Tách đoạn ngay TRƯỚC từ `at[1]`: từ đó mở đầu một dòng phụ đề mới. */
export function splitSegment(transcript: Transcript, at: [number, number]): Transcript {
	const next = clone(transcript);
	const segment = next[at[0]];
	if (!segment || at[1] <= 0 || at[1] >= segment.words.length) return next;
	const tail = segment.words.splice(at[1]);
	next.splice(at[0] + 1, 0, { text: '', words: tail });
	return normalize(next);
}

/** Gộp đoạn `index` với đoạn ngay sau nó. */
export function mergeWithNext(transcript: Transcript, index: number): Transcript {
	const next = clone(transcript);
	if (index < 0 || index >= next.length - 1) return next;
	next[index]!.words.push(...next[index + 1]!.words);
	next.splice(index + 1, 1);
	return normalize(next);
}

/** Bước nudge mặc định: hơn một khung hình ở 30fps, đủ nhỏ để chỉnh tinh. */
export const NUDGE = 0.05;

/**
 * Dời mốc đầu hoặc cuối của một từ, kẹp để từ không dài âm và không chồng lên
 * từ bên cạnh — chồng lên thì hai từ cùng "đang nói" và preset nhấn từng từ
 * nhấp nháy giữa chúng.
 */
export function nudgeWord(
	transcript: Transcript,
	at: [number, number],
	edge: 'start' | 'end',
	delta: number,
): Transcript {
	const next = clone(transcript);
	const flat = next.flatMap((segment) => segment.words);
	const word = next[at[0]]?.words[at[1]];
	if (!word) return next;
	const index = flat.indexOf(word);
	const previous = flat[index - 1];
	const following = flat[index + 1];

	if (edge === 'start') {
		const floor = previous ? previous.end : 0;
		word.start = round(Math.min(Math.max(word.start + delta, floor), word.end));
	} else {
		const ceiling = following ? following.start : Number.POSITIVE_INFINITY;
		word.end = round(Math.max(Math.min(word.end + delta, ceiling), word.start));
	}
	return normalize(next);
}

/** Mọi vị trí `[đoạn, từ]` có chữ chứa `query` (không phân biệt hoa thường). */
export function search(transcript: Transcript, query: string): Array<[number, number]> {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const hits: Array<[number, number]> = [];
	transcript.forEach((segment, s) =>
		segment.words.forEach((word, w) => {
			if (word.text.toLowerCase().includes(needle)) hits.push([s, w]);
		}),
	);
	return hits;
}

// ---------------------------------------------------------------------------
// Sửa video bằng chữ

/** Nới mỗi khoảng xoá ra hai phía: mốc từ của ASR hay cắt sát phụ âm cuối. */
export const CUT_PAD = 0.03;
/** Hai khoảng xoá cách nhau ít hơn thế thì gộp: một mẩu 0.1s còn lại chỉ là một tiếng nấc. */
export const MIN_KEEP = 0.15;

/** Khoảng nguồn mà một nhóm từ chiếm, đã nới `CUT_PAD` và kẹp trong cửa sổ. */
export function rangeOfWords(words: Word[], window: Range): Range | null {
	if (!words.length) return null;
	const start = Math.max(window.start, Math.min(...words.map((word) => word.start)) - CUT_PAD);
	const end = Math.min(window.end, Math.max(...words.map((word) => word.end)) + CUT_PAD);
	return end > start ? { start: round(start), end: round(end) } : null;
}

/**
 * Độ chặt khi cắt chữ (học Palmier §B2): khoảng lặng chừa lại MỖI phía chỗ cắt.
 * Không chừa gì thì hai câu dính vào nhau; chừa cả khoảng hở thì nghe lững.
 */
export const CUT_TIGHTNESS = { tight: 0.06, balanced: 0.15, loose: 0.32 } as const;
export type CutTightness = keyof typeof CUT_TIGHTNESS;

/**
 * Khoảng cắt cho một dải từ liền nhau, ăn luôn phần khoảng hở hai bên chỉ chừa
 * `keep` giây cạnh từ còn lại. Không có từ trước/sau (đầu/cuối cửa sổ) thì cắt
 * tới mép cửa sổ — không để khoảng chết ở đầu/cuối clip.
 */
export function rangeAround(run: Word[], prev: Word | null, next: Word | null, window: Range, keep: number): Range | null {
	if (!run.length) return null;
	const first = Math.min(...run.map((word) => word.start));
	const last = Math.max(...run.map((word) => word.end));
	const start = prev ? Math.max(prev.end, Math.min(first - CUT_PAD, prev.end + keep)) : window.start;
	const end = next ? Math.min(next.start, Math.max(last + CUT_PAD, next.start - keep)) : window.end;
	const clipped = { start: Math.max(window.start, start), end: Math.min(window.end, end) };
	return clipped.end > clipped.start ? { start: round(clipped.start), end: round(clipped.end) } : null;
}

/** Sắp và gộp các khoảng chồng/chạm nhau, hoặc cách nhau dưới `MIN_KEEP`. */
export function mergeRanges(ranges: Range[]): Range[] {
	const sorted = ranges.filter((range) => range.end > range.start).sort((a, b) => a.start - b.start);
	const out: Range[] = [];
	for (const range of sorted) {
		const last = out[out.length - 1];
		if (last && range.start - last.end < MIN_KEEP) {
			last.end = Math.max(last.end, range.end);
		} else {
			out.push({ ...range });
		}
	}
	return out.map((range) => ({ start: round(range.start), end: round(range.end) }));
}

/**
 * Các khoảng GIỮ LẠI của cửa sổ `[window.start, window.end)` sau khi bỏ
 * `removed`. Mẩu giữ lại ngắn hơn `MIN_KEEP` ở hai mép cũng bị bỏ.
 */
export function keptRanges(window: Range, removed: Range[]): Range[] {
	const kept: Range[] = [];
	let cursor = window.start;
	for (const cut of mergeRanges(removed)) {
		const start = Math.max(cut.start, window.start);
		const end = Math.min(cut.end, window.end);
		if (end <= start) continue;
		if (start - cursor >= MIN_KEEP) kept.push({ start: round(cursor), end: round(start) });
		cursor = Math.max(cursor, end);
	}
	if (window.end - cursor >= MIN_KEEP) kept.push({ start: round(cursor), end: round(window.end) });
	return kept;
}

export const keptDuration = (kept: Range[]): number =>
	round(kept.reduce((sum, range) => sum + (range.end - range.start), 0));

/**
 * Thời gian output của một mốc nguồn, hoặc null khi mốc đó rơi vào khoảng đã
 * cắt. Mốc nằm đúng ranh giới thuộc về khoảng đứng trước.
 */
export function toOutput(time: number, kept: Range[]): number | null {
	let offset = 0;
	for (const range of kept) {
		if (time >= range.start && time <= range.end) return round(offset + (time - range.start));
		offset += range.end - range.start;
	}
	return null;
}

/**
 * Transcript theo thang OUTPUT cho `<captions>` sau khi cắt: từ nằm trong
 * khoảng đã xoá biến mất, từ vắt qua ranh giới bị kẹp vào phần còn lại, mốc
 * dời theo tổng độ dài các khoảng đứng trước.
 */
export function remapTranscript(transcript: Transcript, kept: Range[]): Transcript {
	const out: Transcript = [];
	for (const segment of transcript) {
		const words: Word[] = [];
		for (const word of segment.words) {
			// Phần của từ nằm trong một khoảng giữ nào đó; từ vắt qua ranh giới
			// giữ phần dài hơn — nửa từ còn lại vẫn là tiếng người ta nghe thấy.
			let best: { start: number; end: number } | null = null;
			let offset = 0;
			for (const range of kept) {
				const start = Math.max(word.start, range.start);
				const end = Math.min(word.end, range.end);
				if (end > start && (!best || end - start > best.end - best.start)) {
					best = { start: offset + (start - range.start), end: offset + (end - range.start) };
				}
				offset += range.end - range.start;
			}
			if (best) words.push({ id: word.id, text: word.text, start: round(best.start), end: round(best.end) });
		}
		if (words.length) out.push({ text: joinWords(words), words });
	}
	return out;
}

/** Một từ có nằm trọn trong khoảng đã xoá không — để panel gạch ngang nó. */
export function isRemoved(word: Word, removed: Range[]): boolean {
	const middle = (word.start + word.end) / 2;
	return removed.some((range) => middle >= range.start && middle <= range.end);
}

/**
 * Bỏ khỏi `removed` mọi khoảng chạm vào các từ này — "Restore" trên một vùng
 * chọn. Khoảng còn lại được giữ nguyên, kể cả khi nó từng được gộp với khoảng
 * vừa bỏ.
 */
export function restoreWords(removed: Range[], words: Word[]): Range[] {
	return removed.filter(
		(range) => !words.some((word) => word.end > range.start - CUT_PAD && word.start < range.end + CUT_PAD),
	);
}
