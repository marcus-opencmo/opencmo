/**
 * Runs for real:
 *
 *     cd apps/web && NODE_OPTIONS=--conditions=react-server npx tsx lib/mcp/save-frame.check.ts
 *
 * The library step of save_frame over MCP: the frame lands in Frames/ as an uploaded image record
 * that generate_media's `start_image` lookup accepts (type IMAGE, no `state`, `cloud.mediaId`).
 */
import assert from "node:assert/strict";

import { frameRecord, frameStem } from "./save-frame";

const now = "2026-10-20T00:00:00.000Z";
const first = frameRecord(null, { stem: frameStem(2.5), mediaId: "m-1", width: 720, height: 1280, now, id: "a" });
assert.equal(first.path, "Frames/frame-2.5s.jpg");
assert.deepEqual(first.manifest.folders, ["Frames"]);
const record = first.manifest.assets[0] as { path: string; type: string; state?: string; cloud?: { mediaId?: string; state?: string }; source: string };
assert.equal(record.type, "IMAGE");
assert.equal(record.state, undefined, "not a partial record");
assert.deepEqual(record.cloud, { state: "synced", mediaId: "m-1" });
assert.equal(record.source, "assets/Frames/frame-2.5s.jpg");

// A second frame with the same name gets a free path; the folder is not listed twice.
const second = frameRecord(first.manifest, { stem: frameStem(2.5), mediaId: "m-2", width: 720, height: 1280, now, id: "b" });
assert.notEqual(second.path, first.path);
assert.ok(second.path.startsWith("Frames/"));
assert.deepEqual(second.manifest.folders, ["Frames"]);
assert.equal(second.manifest.assets.length, 2);

assert.equal(frameStem(1, "before cut/1"), "before-cut-1");
console.log("save-frame.check: ok");
