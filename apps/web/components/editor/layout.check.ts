/** Bố cục editor kiểu Palmier: lưới theo preset, tay kéo, phím. */

import assert from "node:assert/strict";

import { defaultSizes, gridFor, layoutKey, splitterFor } from "./layout";

const all = { agent: false, media: true, inspector: true };
const key = (code: string, extra: Partial<KeyboardEvent> = {}) => ({ code, key: "", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });

const def = gridFor({ preset: "default", visible: all, sizes: defaultSizes("default", 1440, 900) }, false);
assert.equal(def.areas, `"media preview inspector" "timeline timeline timeline"`, "default: timeline cả bề ngang");
assert.match(def.columns, /^minmax\(200px, 260px\) minmax\(320px, 1fr\) minmax\(240px, 300px\)$/, "Preview giữ ≥ 320px, panel bên co về MIN");

const media = gridFor({ preset: "media", visible: all, sizes: defaultSizes("media", 1440, 900) }, false);
assert.equal(media.areas, `"media preview inspector" "media timeline timeline"`, "media: Media cao hết bên trái");

const vertical = gridFor({ preset: "vertical", visible: all, sizes: defaultSizes("vertical", 1440, 900) }, false);
assert.equal(vertical.areas, `"media inspector preview" "timeline timeline preview"`, "vertical: Preview cột phải cao hết");
const bare = gridFor({ preset: "vertical", visible: { agent: false, media: false, inspector: false }, sizes: defaultSizes("vertical", 1440, 900) }, false);
assert.equal(bare.areas, `"timeline timeline preview" "timeline timeline preview"`, "vertical không còn panel trên: timeline lấp chỗ");

const hidden = gridFor({ preset: "default", visible: { ...all, media: false }, sizes: defaultSizes("default", 1440, 900) }, true);
assert.ok(hidden.columns.startsWith("0px "), "panel ẩn: cột 0");
assert.ok(hidden.rows.endsWith(" 0px"), "tắt timeline: hàng 0");

assert.deepEqual(splitterFor("default", "inspector"), { edge: "left", key: "inspector" });
assert.equal(splitterFor("vertical", "inspector"), null, "vertical: Inspector lấy phần còn lại, không có tay kéo");
assert.deepEqual(splitterFor("vertical", "preview"), { edge: "left", key: "preview" });
assert.deepEqual(splitterFor("media", "timeline"), { edge: "top", key: "timeline" });

assert.deepEqual(layoutKey(key("Digit2", { altKey: true }), false), { preset: "media" }, "Alt+2 → preset Media");
assert.equal(layoutKey(key("Digit2", { altKey: true, metaKey: true }), false), null, "⌘⌥2 không phải phím bố cục");
assert.equal(layoutKey(key("Digit1", { metaKey: true }), false), null, "⌘1 vẫn là Zoom to fit");
assert.equal(layoutKey(key("Backquote"), false), "maximize");
assert.equal(layoutKey(key("Escape", { key: "Escape" }), true), "restore", "Esc thu panel đang phóng to");
assert.equal(layoutKey(key("Escape", { key: "Escape" }), false), null, "không phóng to thì Esc là bỏ chọn như cũ");

console.log("layout: mọi kiểm tra xanh");
