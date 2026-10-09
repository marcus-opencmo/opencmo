/**
 * Kịch bản của clip theo giây CLIP (sau cắt) — thứ agent đọc trước khi làm
 * visual (spec visual-grounding). Transcript lưu theo giây NGUỒN; visual đặt
 * theo giây CLIP; bắt model tự đổi hai thang là chỗ nó hay sai, nên đổi ở đây.
 *
 * `findQuote` neo một câu người nói vào đúng mốc clip: visual/ảnh sinh gắn với
 * một câu có thật, không phải một chủ đề model tự nghĩ ra.
 */

import { keptRanges, remapTranscript, round, type Range, type Transcript, type Word } from './transcript';

export type ScriptLine = { start: number; end: number; text: string };

/** Lặng dài hơn thế giữa hai từ là hết một câu (transcript tự động không có dấu câu). */
const PAUSE = 0.7;
/** Câu dài hơn thế thì cắt: một dòng kịch bản phải đọc được trong một nhịp. */
const MAX_WORDS = 28;

/** Transcript còn lại sau cắt, theo giây CLIP (giữ ranh giới dòng của ASR). */
export function clipTranscript(transcript: Transcript, window: Range, removed: Range[]): Transcript {
	return remapTranscript(transcript, keptRanges(window, removed));
}

/** Từ còn lại sau cắt, theo giây CLIP. */
export function clipWords(transcript: Transcript, window: Range, removed: Range[]): Word[] {
	return clipTranscript(transcript, window, removed).flatMap((segment) => segment.words);
}

/**
 * Gom từ thành dòng kịch bản: hết dòng ở dấu . ? ! …, ở chỗ lặng, ở cuối một
 * dòng ASR (transcript tự động không có dấu câu — dòng ASR là cụm nói liền),
 * hoặc khi quá dài.
 */
export function clipScript(input: Word[] | Transcript): ScriptLine[] {
	const segments: Word[][] = input.length && 'words' in (input[0] as object) ? (input as Transcript).map((segment) => segment.words) : [input as Word[]];
	const ends = new Set<Word>(segments.map((words) => words.at(-1)).filter((word): word is Word => !!word));
	const words = segments.flat();
	const lines: ScriptLine[] = [];
	let current: Word[] = [];
	const flush = () => {
		if (!current.length) return;
		lines.push({ start: round(current[0]!.start), end: round(current.at(-1)!.end), text: current.map((word) => word.text.trim()).join(' ') });
		current = [];
	};
	words.forEach((word, index) => {
		const previous = words[index - 1];
		if (previous && current.length && word.start - previous.end > PAUSE) flush();
		current.push(word);
		if (/[.?!…]["')\]]*$/.test(word.text.trim()) || current.length >= MAX_WORDS || (ends.has(word) && current.length >= 3)) flush();
	});
	flush();
	return lines;
}

/** Kịch bản dạng chữ cho model: `[12.4–15.1] you need better hooks`, có trần số từ. */
export function formatScript(lines: ScriptLine[], maxWords = 2500): string {
	const out: string[] = [];
	let count = 0;
	for (const line of lines) {
		count += line.text.split(/\s+/).length;
		if (count > maxWords) {
			out.push('[…transcript continues…]');
			break;
		}
		out.push(`[${line.start.toFixed(1)}–${line.end.toFixed(1)}] ${line.text}`);
	}
	return out.join('\n');
}

const token = (text: string): string => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}']+/gu, '').replace(/^'+|'+$/g, '');

const tokens = (text: string): string[] => text.split(/\s+/).map(token).filter(Boolean);

/** Tỉ lệ từ khớp tối thiểu: ASR sai một từ trong câu vẫn nhận ra. */
export const QUOTE_MATCH = 0.8;

export type QuoteHit = { start: number; end: number; score: number; text: string };

/**
 * Tìm câu `quote` trong các từ của clip: so theo thứ tự từ (LCS), bỏ dấu câu và
 * hoa thường. Trả mốc CLIP của từ khớp đầu và cuối; null khi không đủ khớp.
 */
/**
 * Tách "từ" chứa nhiều chữ thành từng chữ, mốc chia theo độ dài ký tự. Phụ đề
 * không có mốc từng chữ (YouTube) lưu cả dòng thành một từ — so khớp theo từ
 * thì câu trích ngắn hơn cả dòng không bao giờ khớp.
 */
function splitWords(words: Word[]): Word[] {
	return words.flatMap((word) => {
		const parts = word.text.trim().split(/\s+/).filter(Boolean);
		if (parts.length <= 1) return [word];
		const total = parts.reduce((sum, part) => sum + part.length + 1, 0);
		const span = word.end - word.start;
		let at = 0;
		return parts.map((part) => {
			const start = word.start + (span * at) / total;
			at += part.length + 1;
			return { ...word, text: part, start, end: word.start + (span * at) / total };
		});
	});
}

export function findQuote(input: Word[], quote: string): QuoteHit | null {
	const words = splitWords(input);
	const needle = tokens(quote);
	if (!needle.length) return null;
	const hay = words.map((word) => token(word.text));
	const span = needle.length + Math.max(2, Math.ceil(needle.length * 0.25));
	let best: QuoteHit | null = null;
	for (let i = 0; i < hay.length; i++) {
		if (!hay[i]) continue;
		// Câu phải bắt đầu gần từ đầu của quote: khớp từ đầu hoặc từ thứ hai.
		if (hay[i] !== needle[0] && hay[i] !== needle[1]) continue;
		const window = hay.slice(i, i + span);
		const { length, first, last } = lcs(needle, window);
		const score = length / needle.length;
		if (score >= QUOTE_MATCH && (!best || score > best.score)) {
			const endWord = words[i + last]!;
			best = {
				start: round(words[i + first]!.start),
				end: round(endWord.end),
				score: round(score),
				text: words.slice(i + first, i + last + 1).map((word) => word.text.trim()).join(' '),
			};
			if (score === 1) break;
		}
	}
	return best;
}

/** Độ dài LCS và vị trí (trong `b`) của phần tử khớp đầu và cuối. */
function lcs(a: string[], b: string[]): { length: number; first: number; last: number } {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const table: number[] = new Array(rows * cols).fill(0);
	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			table[i * cols + j] = a[i - 1] === b[j - 1] ? table[(i - 1) * cols + j - 1]! + 1 : Math.max(table[(i - 1) * cols + j]!, table[i * cols + j - 1]!);
		}
	}
	// Truy ngược để biết từ cuối cùng của `b` nằm trong chuỗi khớp.
	let i = a.length;
	let j = b.length;
	let last = -1;
	let first = 0;
	while (i > 0 && j > 0) {
		if (a[i - 1] === b[j - 1]) {
			if (last < 0) last = j - 1;
			// Truy ngược: lần khớp cuối cùng gặp là từ khớp ĐẦU — "I" của "I could I
			// wrote…" đứng trước câu thì không được lấy làm mốc bắt đầu.
			first = j - 1;
			i--;
			j--;
		} else if (table[(i - 1) * cols + j]! >= table[i * cols + j - 1]!) i--;
		else j--;
	}
	return { length: table[rows * cols - 1]!, first, last: Math.max(0, last) };
}

/** Mốc CLIP cho một visual neo vào `quote`: bắt đầu ở từ đầu, kéo tới hết câu, trong [min, max] giây. */
export function quoteTiming(hit: QuoteHit, lines: ScriptLine[], duration: number | null, options: { min?: number; max?: number } = {}): { start: number; end: number } {
	const min = options.min ?? 2;
	const max = options.max ?? 6;
	const line = lines.find((item) => hit.start >= item.start - 0.05 && hit.start <= item.end);
	let end = Math.max(hit.end, line?.end ?? hit.end);
	end = Math.min(Math.max(end, hit.start + min), hit.start + max);
	if (duration !== null) end = Math.min(end, duration);
	return { start: hit.start, end: round(end) };
}
