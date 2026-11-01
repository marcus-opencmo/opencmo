/**
 * Where the slides of a slideshow sit in a document (P5 B0, `docs/architecture/studio.md` §7): shared by the
 * slide ops (`editor-core/ops/slides.ts`) and the still export (`clip-export`), so both find the same slides.
 * A slide is a timed group directly under the scene, marked `marks.visual.op = 'add_slide'`; no schema of its own.
 */

import type { ClipDocument, SceneNode } from './schema.ts';

export const SLIDE_OP = 'add_slide';
/** TikTok photo mode's limit: the PNG set must fit it. The op and the still export both hold it. */
export const MAX_SLIDES = 35;

export type SlideSpan = { id: string | undefined; start: number; end: number };

type Timed = { kind?: unknown; id?: string; start?: unknown; end?: unknown; marks?: { visual?: { op?: unknown } } };

const activeScene = (document: ClipDocument): SceneNode | undefined => {
  const scenes = document.stage.children.filter((node): node is SceneNode => node.kind === 'scene');
  return scenes.find((scene) => scene.active) ?? scenes[0];
};

/** The active timeline's slides in play order. Empty when the document is not a slideshow. */
export function slideSpans(document: ClipDocument): SlideSpan[] {
  const children = (activeScene(document)?.children ?? []) as unknown as Timed[];
  return children
    .filter((node) => node.kind === 'group' && node.marks?.visual?.op === SLIDE_OP && typeof node.start === 'number' && typeof node.end === 'number')
    .map((node) => ({ id: node.id, start: node.start as number, end: node.end as number }))
    .sort((a, b) => a.start - b.start);
}
