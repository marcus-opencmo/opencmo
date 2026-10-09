/**
 * Dịch phụ đề (E4-e): phần THUẦN — đọc transcript, chia từ của câu dịch vào khung giờ câu
 * gốc. Model chỉ dịch từng dòng; mốc từ của bản dịch là ước lượng (đều theo độ dài từ)
 * trong đúng khoảng [đầu, cuối] của dòng gốc, nên phụ đề dịch luôn hiện cùng lúc với lời
 * nói, và karaoke từng từ lệch tối đa trong một dòng.
 */

export type TranscriptWord = { text: string; start: number; end: number };
export type TranscriptLine = { text: string; words: TranscriptWord[] };

export const TRANSLATE_LANGUAGES = [
  "English", "Spanish", "Portuguese", "French", "German", "Italian", "Dutch", "Polish", "Turkish",
  "Russian", "Ukrainian", "Arabic", "Hindi", "Indonesian", "Vietnamese", "Thai", "Japanese", "Korean",
  "Chinese (Simplified)", "Chinese (Traditional)",
] as const;
export type TranslateLanguage = (typeof TRANSLATE_LANGUAGES)[number];

/** Đọc + kiểm hình dạng transcript đã lưu; bỏ dòng rỗng và từ thiếu mốc. */
export function parseTranscript(body: string): TranscriptLine[] {
  const raw = JSON.parse(body) as unknown;
  if (!Array.isArray(raw)) throw new Error("not an array");
  return raw
    .map((line) => {
      const value = line as { text?: unknown; words?: unknown };
      const words = (Array.isArray(value.words) ? value.words : [])
        .map((word) => word as { text?: unknown; word?: unknown; start?: unknown; end?: unknown })
        .filter((word) => typeof word.start === "number" && typeof word.end === "number")
        .map((word) => ({ text: String(word.text ?? word.word ?? ""), start: word.start as number, end: word.end as number }));
      return { text: typeof value.text === "string" ? value.text.trim() : "", words };
    })
    .filter((line) => line.text && line.words.length);
}

/** Giây phụ đề được tính phí: từ từ đầu tiên tới từ cuối cùng. */
export function captionSeconds(lines: TranscriptLine[]): number {
  if (!lines.length) return 0;
  const first = Math.min(...lines.map((line) => line.words[0]!.start));
  const last = Math.max(...lines.map((line) => line.words[line.words.length - 1]!.end));
  return Math.max(0, last - first);
}

/** Tiếng không dùng dấu cách giữa từ: chia theo ký tự thay vì theo từ. */
const UNSPACED = /^(Japanese|Chinese|Thai)/;

/** Ghép bản dịch vào khung giờ của từng dòng gốc. `translated[i]` là bản dịch dòng i. */
export function applyTranslation(lines: TranscriptLine[], translated: string[], language: string): TranscriptLine[] {
  return lines.map((line, index) => {
    const text = (translated[index] ?? "").trim() || line.text;
    const start = line.words[0]!.start;
    const end = Math.max(start + 0.05, line.words[line.words.length - 1]!.end);
    const tokens = UNSPACED.test(language) ? chunks(text) : text.split(/\s+/).filter(Boolean);
    const weights = tokens.map((token) => Math.max(1, [...token].length));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let at = start;
    const words = tokens.map((token, i) => {
      const span = ((end - start) * weights[i]!) / total;
      const word = { text: token, start: round(at), end: round(at + span) };
      at += span;
      return word;
    });
    return { text, words };
  });
}

/** Cụm 2–4 ký tự cho tiếng không có dấu cách, để karaoke vẫn có nhịp. */
function chunks(text: string): string[] {
  const chars = [...text.replace(/\s+/g, "")];
  const size = chars.length > 24 ? 4 : chars.length > 8 ? 3 : 2;
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Bản giả cho CI/E2E: không gọi model, đánh dấu ngôn ngữ để test thấy chữ đã đổi. */
export function fakeTranslate(lines: TranscriptLine[], language: string): string[] {
  return lines.map((line) => `[${language}] ${line.text}`);
}
