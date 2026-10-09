/** Chọn đường ghi bytes thư viện: OPFS chỉ khi ghi được từ luồng chính (Safari < 26 thì không). */

import assert from "node:assert/strict";

import { canWriteOpfs, idbKey } from "./local";

const storage = { getDirectory: () => undefined };
assert.equal(canWriteOpfs({ navigator: { storage }, FileSystemFileHandle: { prototype: { createWritable() {} } } }), true, "Chrome/Firefox/Safari 26");
assert.equal(canWriteOpfs({ navigator: { storage }, FileSystemFileHandle: { prototype: {} } }), false, "Safari 17: có OPFS, không có createWritable");
assert.equal(canWriteOpfs({ navigator: {} }), false, "không có OPFS");
assert.equal(idbKey("c1", "/assets//Frames/a.jpg"), "projects/c1/assets/Frames/a.jpg");
console.log("library local: mọi kiểm tra xanh");
