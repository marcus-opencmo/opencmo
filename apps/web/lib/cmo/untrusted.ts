/**
 * Text from outside (websites, Reddit and other social posts) goes into prompts. Two tricks hide
 * instructions in it (security plan fix 10):
 * - characters a reader never sees but a model reads: Unicode tags (U+E0000–E007F, "ASCII
 *   smuggling"), bidi controls, zero-width characters, variation selectors past U+FE0F, private use;
 * - markup that closes our own block early (`</thread><thread index="0">…`) so the rest reads as
 *   ours.
 * `cleanUntrusted` removes the first, `escapeForTag` / `escapeAttribute` neutralize the second.
 */

const INVISIBLE = new RegExp(
  [
    "[\\u{E0000}-\\u{E007F}]", // tags
    "[\\u202A-\\u202E\\u2066-\\u2069\\u200E\\u200F\\u061C]", // bidi controls and marks
    "[\\u200B\\u200C\\u2060-\\u2064\\uFEFF\\u00AD\\u180E]", // zero-width, word joiner, BOM, soft hyphen
    "[\\u{E0100}-\\u{E01EF}]", // variation selectors 17–256 (carry bytes, never needed in text)
    "[\\u{E000}-\\u{F8FF}\\u{F0000}-\\u{FFFFD}\\u{100000}-\\u{10FFFD}]", // private use
    // A zero-width joiner is kept only inside an emoji sequence (👩‍💻), where it is visible.
    "(?<![\\p{Extended_Pictographic}\\p{Emoji_Modifier}]\\uFE0F?)\\u200D|\\u200D(?!\\p{Extended_Pictographic})",
  ].join("|"),
  "gu",
);

export function cleanUntrusted(text: string): string {
  return text.normalize("NFC").replace(INVISIBLE, "");
}

/** For text inside one of our tags: it can no longer open or close a tag. */
export function escapeForTag(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** For a value inside `attr="…"`: it can no longer end the attribute. */
export function escapeAttribute(text: string): string {
  return escapeForTag(text).replace(/"/g, "&quot;");
}
