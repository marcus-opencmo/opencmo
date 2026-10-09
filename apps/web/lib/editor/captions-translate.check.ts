/**
 * Dịch phụ đề (E4-e): bản dịch nằm đúng khung giờ dòng gốc, từ chia theo độ dài, tiếng
 * không có dấu cách chia theo cụm ký tự, giây tính phí đúng.
 *
 *   npx tsx lib/editor/captions-translate.check.ts
 */

import assert from "node:assert/strict";

import { applyTranslation, captionSeconds, parseTranscript } from "./captions-translate";

const lines = parseTranscript(
  JSON.stringify([
    { text: "hello there friend", words: [{ text: "hello", start: 1, end: 1.4 }, { text: "there", start: 1.4, end: 1.8 }, { text: "friend", start: 1.8, end: 3 }] },
    { text: "", words: [] },
    { text: "bye", words: [{ word: "bye", start: 4, end: 4.5 }] },
  ]),
);
assert.equal(lines.length, 2, "bỏ dòng rỗng");
assert.equal(captionSeconds(lines), 3.5, "từ từ đầu tới từ cuối");

const es = applyTranslation(lines, ["hola amigo", "adiós"], "Spanish");
assert.deepEqual(es[0]!.words.map((word) => word.text), ["hola", "amigo"]);
assert.equal(es[0]!.words[0]!.start, 1, "bắt đầu cùng dòng gốc");
assert.equal(es[0]!.words.at(-1)!.end, 3, "kết thúc cùng dòng gốc");
assert.ok(es[0]!.words[0]!.end < es[0]!.words[1]!.end, "mốc tăng dần");
assert.deepEqual(es[1]!.words, [{ text: "adiós", start: 4, end: 4.5 }]);

const ja = applyTranslation(lines, ["こんにちは友達", ""], "Japanese");
assert.ok(ja[0]!.words.length >= 3, "tiếng Nhật chia theo cụm ký tự");
assert.equal(ja[0]!.words.map((word) => word.text).join(""), "こんにちは友達");
assert.equal(ja[1]!.text, "bye", "dòng dịch rỗng thì giữ chữ gốc");

console.log("captions-translate: bản dịch đúng khung giờ, chia từ đúng, giây tính phí đúng.");
