/**
 * `@Image1` của ô Generate (G2): nhận thẻ đang gõ, chèn thẻ, đổi thành chữ model đọc.
 *
 *     cd apps/web && npx tsx lib/generate/mentions.check.ts
 */
import assert from "node:assert/strict";

import { insertMention, mentionAt, resolveMentions } from "../../components/editor/generate/mentions";

assert.deepEqual(mentionAt("a cat on @st", 12), { start: 9, query: "st" });
assert.deepEqual(mentionAt("@", 1), { start: 0, query: "" });
assert.equal(mentionAt("mail me at a@b", 14), null, "@ giữa chữ không phải thẻ");
assert.equal(mentionAt("a cat @ x", 9), null, "đã gõ khoảng trắng sau thẻ");

assert.deepEqual(insertMention("the mug from @mu on a desk", { start: 13 }, 16, 2), { text: "the mug from @Image2  on a desk", caret: 21 });

assert.deepEqual(resolveMentions("the mug from @Image1 next to @image 2", 2), { prompt: "the mug from image 1 next to image 2" });
assert.deepEqual(resolveMentions("no tags", 0), { prompt: "no tags" });
assert.deepEqual(resolveMentions("from @Image3", 2), { error: "@Image3 is not one of your 2 reference images." });
assert.deepEqual(resolveMentions("from @Image1", 0), { error: "@Image1 needs a reference image. Pick one below the prompt." });

console.log("mentions: mọi kiểm tra xanh");
