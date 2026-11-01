/**
 * The Slideshow squad's code (`build.ts`): the reviewer holds what the frame fits, each slide's time follows its words,
 * and the hook and call to action keep the plain background while the middle slides take captured pages.
 *
 *     cd apps/web && NODE_OPTIONS=--conditions=react-server npx tsx lib/departments/studio/slideshow/squad.check.ts
 */
import assert from "node:assert/strict";

import { applyOps, SLIDE_TEXT_MAX, type OpContext } from "@opencmo/editor-core";
import { slideSpans, validate, type ClipDocument } from "@opencmo/clip-doc";

import { STUDIO_ACCESS } from "../types";
import { renderRequestId } from "../render";
import { reviewSlides, slideOps, slideSeconds, stillsRequestId } from "./build";
import { postImageAspect } from "./post-image";

const slide = (heading: string, body = "") => ({ heading, body });
const five = ["Hook", "Two", "Three", "Four", "Try it"].map((text) => slide(text, "One short line."));

assert.deepEqual(reviewSlides(five), []);
assert.match(reviewSlides([slide("x".repeat(SLIDE_TEXT_MAX.heading + 1))])[0]!, /Slide 1's heading/);
assert.match(reviewSlides([five[0]!, slide("ok", "y".repeat(SLIDE_TEXT_MAX.body + 1))])[0]!, /Slide 2's body/);

assert.equal(slideSeconds(slide("Hi")), 3, "never under 3 s");
assert.equal(slideSeconds(slide(Array(30).fill("word").join(" "))), 10, "about 3 words a second");

const ops = slideOps(five, ["c-1", "c-2"]);
assert.deepEqual(ops.map((op) => ("background" in op ? op.background!.src : null)), [null, "capture:c-1", "capture:c-2", null, null], "hook and call to action stay plain");
assert.equal(slideOps(five, []).every((op) => !("background" in op)), true, "no captures: the Brand Kit background");

// Request ids are how a retry finds the render already queued: the shared helper must not change them (values from the
// formula as it was before `requestIdFrom`).
assert.equal(stillsRequestId("clip-1", "a".repeat(64)), "c5fefb54-7e90-51cd-9ac4-92a93266c4bf");
assert.equal(renderRequestId("clip-1", "a".repeat(64)), "fcaa4fef-d43d-50cb-94bb-4d642160ce72");

assert.deepEqual(STUDIO_ACCESS.buildSlideshow, ["brain"], "only the brain's order builds a slideshow");
assert.deepEqual(STUDIO_ACCESS.buildPostImage, ["brain"], "only the brain's order builds a post image");
assert.deepEqual(["x", "youtube", "linkedin", "tiktok_caption"].map(postImageAspect), ["16:9", "16:9", "1:1", "9:16"]);

async function main() {
  // The ops the squad writes build a document the export can read.
  const blank = { version: 1, stage: { children: [{ kind: "scene", name: "Main", width: 1080, height: 1920, active: true, children: [] }] } } as unknown as ClipDocument;
  const { document } = await applyOps(blank, ops, {} as OpContext);
  validate(document);
  assert.equal(slideSpans(document).length, 5);
  console.log("slideshow squad.check: ok");
}

void main();
