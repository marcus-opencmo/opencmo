/** Cổng editor dò tính năng: Safari/Firefox đủ tính năng thì vào, điện thoại và cửa sổ nhỏ thì không. */

import assert from "node:assert/strict";

import { deviceVerdict, type DeviceFacts } from "./device";

const desktop: DeviceFacts = { width: 1440, height: 900, touchOnly: false, storage: true, offscreen2d: true, audio: true, h264: true };

assert.deepEqual(deviceVerdict(desktop), { ok: true }, "máy tính đủ tính năng (Chrome, Safari 17+, Firefox) vào được");
assert.deepEqual(deviceVerdict({ ...desktop, touchOnly: true }), { ok: false, reason: "touch" }, "điện thoại bị chặn dù màn to");
assert.deepEqual(deviceVerdict({ ...desktop, width: 700 }), { ok: false, reason: "small" });
assert.deepEqual(deviceVerdict({ ...desktop, h264: false }), { ok: false, reason: "codec" });
assert.deepEqual(deviceVerdict({ ...desktop, storage: false, offscreen2d: false }), {
  ok: false,
  reason: "missing",
  missing: ["local file storage", "offscreen canvas"],
});

console.log("device: mọi kiểm tra xanh");
