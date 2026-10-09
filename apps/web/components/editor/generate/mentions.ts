/**
 * `@Image1` trong prompt của ô Generate (G2, học "@-tag" của Palmier): ảnh tham chiếu được gọi
 * bằng số thứ tự trong danh sách đã chọn. Model đọc "image 1", không đọc "@Image1", nên lúc gửi
 * thẻ được đổi thành chữ thường; thẻ trỏ tới ảnh chưa chọn là lỗi, không gửi bừa.
 */

const TAG = /@image\s*(\d+)/gi;

/** Đang gõ một thẻ: `@` ở đầu dòng hoặc sau khoảng trắng, theo sau là chữ chưa có khoảng trắng. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([\w.-]*)$/.exec(before);
  if (!match) return null;
  return { start: caret - match[2]!.length - 1, query: match[2]! };
}

/** Thay phần đang gõ (`@que…`) bằng `@ImageN `; trả chữ mới và vị trí con trỏ. */
export function insertMention(text: string, mention: { start: number }, caret: number, index: number): { text: string; caret: number } {
  const tag = `@Image${index} `;
  return { text: text.slice(0, mention.start) + tag + text.slice(caret), caret: mention.start + tag.length };
}

/** Prompt gửi đi: `@Image2` → "image 2". Thẻ vượt số ảnh đã chọn trả lỗi tiếng Anh cho người dùng. */
export function resolveMentions(prompt: string, references: number): { prompt: string } | { error: string } {
  for (const match of prompt.matchAll(TAG)) {
    const index = Number(match[1]);
    if (index < 1 || index > references) {
      return {
        error: references
          ? `@Image${index} is not one of your ${references} reference image${references === 1 ? "" : "s"}.`
          : `@Image${index} needs a reference image. Pick one below the prompt.`,
      };
    }
  }
  return { prompt: prompt.replace(TAG, (_tag, index: string) => `image ${index}`) };
}
