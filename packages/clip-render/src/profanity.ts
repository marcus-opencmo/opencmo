/**
 * Lọc từ tục trên phụ đề (E4-e, học Palmier "censor profanity"): chỉ đổi chữ HIỂN THỊ,
 * transcript gốc giữ nguyên. Giữ chữ đầu + đủ số `*` để độ dài từ không đổi — nhờ vậy mọi
 * khoảng ký tự (từ đang nói, hộp nhấn, xuống dòng) tính trên chữ gốc vẫn khớp.
 */

import type { Transcript } from './captions.ts';

// Danh sách tiếng Anh dựng sẵn, so theo gốc từ sau khi bỏ dấu câu và hạ chữ thường.
const ROOTS = [
  'fuck', 'fucking', 'fucker', 'fucked', 'motherfucker', 'shit', 'shitty', 'bullshit', 'bitch', 'bitches',
  'asshole', 'ass', 'bastard', 'dick', 'dickhead', 'cock', 'cunt', 'pussy', 'slut', 'whore', 'damn',
  'goddamn', 'crap', 'piss', 'pissed', 'wanker', 'twat', 'prick', 'bollocks', 'douche', 'douchebag',
];
const WORDS = new Set(ROOTS);

/** "Fucking!" → "F******!" — dấu câu hai đầu giữ nguyên. */
export function censorWord(text: string): string {
  const match = /^([^\p{L}\p{N}]*)([\p{L}\p{N}'’]+)([^\p{L}\p{N}]*)$/u.exec(text);
  if (!match) return text;
  const [, lead, core, tail] = match;
  const key = core!.toLowerCase().replace(/['’]s$/, '');
  if (!WORDS.has(key)) return text;
  const chars = [...core!];
  return `${lead}${chars[0]}${'*'.repeat(chars.length - 1)}${tail}`;
}

export function censorTranscript(transcript: Transcript): Transcript {
  return transcript.map((line) => ({
    ...line,
    ...(line.text !== undefined ? { text: line.text.split(' ').map(censorWord).join(' ') } : {}),
    words: line.words.map((word) => ({ ...word, text: censorWord(word.text) })),
  }));
}
