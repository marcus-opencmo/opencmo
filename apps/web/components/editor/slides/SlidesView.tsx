"use client";

/**
 * Slides view (P5 C1): the editor with the timeline hidden, for an edit made of slides. The strip on the left (add,
 * delete, drag), the frame in the middle (the editor's own Stage), text, image, colour and duration on the right.
 * Every change is one of B's slide ops through the editor's `run`, so Undo, saving and the Assistant see the same
 * document; "Timeline" switches to the full editor on that document.
 */

import { useEffect, useState } from "react";

import { SLIDE_OP, type ClipDocument } from "@opencmo/clip-doc";
import { activeScene, MAX_SLIDES, SLIDE_LAYERS, SLIDE_SECONDS, SLIDE_TEXT_MAX } from "@opencmo/editor-core";

type Run = (ops: unknown[]) => Promise<unknown>;
type Node = { id?: string; kind?: string; name?: string; start?: number; end?: number; text?: string; fill?: unknown; src?: unknown; children?: Node[]; marks?: { visual?: { op?: string } } };

export type Slide = {
  id: string;
  index: number;
  start: number;
  seconds: number;
  heading: string;
  body: string;
  /** What the Background layer is now: a colour, or an image's library path. */
  background: { color: string } | { src: string } | null;
  /** The Background rect, when it is one: a colour change is a `set_props` on it. */
  rectId: string | null;
};

const r2 = (value: number) => Math.round(value * 100) / 100;

/** The active timeline's slides in play order, read the way `editor-core/ops/slides.ts` writes them. */
export function readSlides(document: ClipDocument): Slide[] {
  const scene = activeScene(document) as unknown as Node;
  return (scene.children ?? [])
    .filter((node) => node.kind === "group" && node.marks?.visual?.op === SLIDE_OP && node.id)
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
    .map((node, index) => {
      const layer = (name: string) => node.children?.find((child) => child.name === name);
      const back = layer(SLIDE_LAYERS.background);
      const background = back?.kind === "rect" && typeof back.fill === "string" ? { color: back.fill } : back?.kind === "image" && typeof back.src === "string" ? { src: back.src } : null;
      return {
        id: node.id!,
        index,
        start: node.start ?? 0,
        seconds: r2((node.end ?? 0) - (node.start ?? 0)),
        heading: layer(SLIDE_LAYERS.heading)?.text ?? "",
        body: layer(SLIDE_LAYERS.body)?.text ?? "",
        background,
        rectId: back?.kind === "rect" ? (back.id ?? null) : null,
      };
    });
}

/** The slide on screen at `seconds`; the last one past the end. */
export function slideAt(slides: Slide[], seconds: number): Slide | null {
  return slides.find((slide) => seconds >= slide.start && seconds < slide.start + slide.seconds) ?? slides.at(-1) ?? null;
}

/**
 * The ops that change a slide's background. A colour on a colour slide is a fill; anything else (colour ↔ image, a new
 * image) re-adds the slide right after itself with the same words and length, then deletes the old one: `add_slide`
 * is the one op that builds an image background with its scrim.
 */
export function backgroundOps(slide: Slide, next: { color: string } | { src: string }): unknown[] {
  if ("color" in next && slide.rectId) return [{ op: "set_props", element_id: slide.rectId, props: { fill: next.color } }];
  return [
    { op: "add_slide", after: slide.id, heading: slide.heading || "Slide", ...(slide.body ? { body: slide.body } : {}), duration: Math.min(SLIDE_SECONDS.max, Math.max(SLIDE_SECONDS.min, slide.seconds)), background: next },
    { op: "delete_slide", slide_id: slide.id },
  ];
}

export function SlideStrip({
  slides,
  current,
  busy,
  run,
  onPick,
  onTimeline,
}: {
  slides: Slide[];
  current: Slide | null;
  busy: boolean;
  run: Run;
  onPick: (slide: Slide) => void;
  onTimeline: () => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const full = slides.length >= MAX_SLIDES;

  // The new slide follows the one on screen, and the playhead moves to it so the panel edits it next.
  const add = () =>
    void run([{ op: "add_slide", ...(current ? { after: current.id } : {}), heading: "New slide" }]).then((next) => {
      if (!next) return;
      const known = new Set(slides.map((slide) => slide.id));
      const added = readSlides(next as ClipDocument).find((slide) => !known.has(slide.id));
      if (added) onPick(added);
    });
  const move = (slide: Slide, to: number) => {
    if (to < 0 || to >= slides.length || to === slide.index) return;
    void run([{ op: "move_slide", slide_id: slide.id, to }]);
  };

  return (
    <section className="ed2-slides-strip" aria-label="Slides" data-testid="slides-strip">
      <div className="ed2-slides-head">
        <b>
          {slides.length} slide{slides.length === 1 ? "" : "s"}
        </b>
        <button type="button" className="ed2-btn" data-testid="slides-timeline" onClick={onTimeline} title="Open the full editor with the timeline">
          Timeline
        </button>
      </div>
      <ol className="ed2-slides-list">
        {slides.map((slide) => (
          <li
            key={slide.id}
            className="ed2-slide-item"
            data-testid="slide-item"
            aria-current={current?.id === slide.id || undefined}
            data-over={over === slide.index || undefined}
            draggable={!busy}
            onDragStart={(event) => {
              setDragging(slide.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", slide.id);
            }}
            onDragOver={(event) => {
              if (!dragging) return;
              event.preventDefault();
              setOver(slide.index);
            }}
            onDragLeave={() => setOver((was) => (was === slide.index ? null : was))}
            onDrop={(event) => {
              event.preventDefault();
              const from = slides.find((item) => item.id === dragging);
              setDragging(null);
              setOver(null);
              if (from) move(from, slide.index);
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
          >
            <button
              type="button"
              className="ed2-slide-thumb"
              style={slide.background && "color" in slide.background ? { background: slide.background.color } : undefined}
              data-image={slide.background && "src" in slide.background ? true : undefined}
              aria-label={`Slide ${slide.index + 1}: ${slide.heading}`}
              onClick={() => onPick(slide)}
            >
              <span className="ed2-slide-n">{slide.index + 1}</span>
              <span className="ed2-slide-text">{slide.heading}</span>
              <span className="ed2-slide-sec">{slide.seconds}s</span>
            </button>
            <span className="ed2-slide-tools">
              <button type="button" className="ed2-icon" aria-label={`Move slide ${slide.index + 1} up`} disabled={busy || slide.index === 0} onClick={() => move(slide, slide.index - 1)}>
                ↑
              </button>
              <button type="button" className="ed2-icon" aria-label={`Move slide ${slide.index + 1} down`} disabled={busy || slide.index === slides.length - 1} onClick={() => move(slide, slide.index + 1)}>
                ↓
              </button>
              <button
                type="button"
                className="ed2-icon"
                aria-label={`Delete slide ${slide.index + 1}`}
                data-testid="slide-delete"
                disabled={busy || slides.length === 1}
                title={slides.length === 1 ? "A slideshow keeps at least one slide." : undefined}
                onClick={() => void run([{ op: "delete_slide", slide_id: slide.id }])}
              >
                ×
              </button>
            </span>
          </li>
        ))}
      </ol>
      <button type="button" className="ed2-btn ed2-slides-add" data-testid="slide-add" disabled={busy || full} title={full ? `A slideshow has at most ${MAX_SLIDES} slides.` : undefined} onClick={add}>
        + Add slide
      </button>
      {slides.length === 0 ? <p className="ed2-muted">No slides yet. Add the first one, or ask the Assistant for a slideshow.</p> : null}
    </section>
  );
}

/** Library images a slide can show behind its words. */
export type SlideImage = { path: string; name: string };

export function SlidePanel({ slide, images, busy, run }: { slide: Slide | null; images: SlideImage[]; busy: boolean; run: Run }) {
  const [heading, setHeading] = useState("");
  const [body, setBody] = useState("");
  const [seconds, setSeconds] = useState("");
  const [tint, setTint] = useState("#000000");
  const shown = slide?.background && "color" in slide.background ? slide.background.color : "#000000";
  useEffect(() => setTint(/^#[0-9a-fA-F]{6}$/.test(shown) ? shown : "#000000"), [shown]);
  useEffect(() => {
    setHeading(slide?.heading ?? "");
    setBody(slide?.body ?? "");
    setSeconds(slide ? String(slide.seconds) : "");
  }, [slide?.id, slide?.heading, slide?.body, slide?.seconds]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!slide) {
    return (
      <aside className="ed2-slides-panel" aria-label="Slide" data-testid="slide-panel">
        <p className="ed2-muted">Pick a slide to change its text, image, colour and length.</p>
      </aside>
    );
  }

  const saveText = () => {
    const nextHeading = heading.trim();
    const nextBody = body.trim();
    if (!nextHeading || (nextHeading === slide.heading && nextBody === slide.body)) return;
    void run([{ op: "set_slide_text", slide_id: slide.id, ...(nextHeading !== slide.heading ? { heading: nextHeading } : {}), ...(nextBody !== slide.body ? { body: nextBody } : {}) }]);
  };
  const saveSeconds = () => {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < SLIDE_SECONDS.min || value > SLIDE_SECONDS.max || value === slide.seconds) return;
    void run([{ op: "set_slide_duration", slide_id: slide.id, seconds: value }]);
  };
  const color = slide.background && "color" in slide.background ? slide.background.color : "#000000";
  const image = slide.background && "src" in slide.background ? slide.background.src : "";
  const long = (text: string, max: number) => (text.trim().length > max ? `Over ${max} characters: it may not fit the frame.` : null);

  return (
    <aside className="ed2-slides-panel" aria-label={`Slide ${slide.index + 1}`} data-testid="slide-panel">
      <h2 className="ed2-slides-title">Slide {slide.index + 1}</h2>
      <label className="ed2-field">
        <span>Heading</span>
        <input
          className="ed2-input"
          data-testid="slide-heading"
          value={heading}
          maxLength={200}
          disabled={busy}
          onChange={(event) => setHeading(event.target.value)}
          onBlur={saveText}
          onKeyDown={(event) => {
            if (event.key === "Enter") saveText();
          }}
        />
        {!heading.trim() ? <small role="status">A slide needs a heading.</small> : long(heading, SLIDE_TEXT_MAX.heading) ? <small role="status">{long(heading, SLIDE_TEXT_MAX.heading)}</small> : null}
      </label>
      <label className="ed2-field">
        <span>Text under it</span>
        <textarea className="ed2-input" data-testid="slide-body" rows={3} value={body} maxLength={600} disabled={busy} onChange={(event) => setBody(event.target.value)} onBlur={saveText} />
        {long(body, SLIDE_TEXT_MAX.body) ? <small role="status">{long(body, SLIDE_TEXT_MAX.body)}</small> : null}
      </label>
      <label className="ed2-field">
        <span>Image behind the text</span>
        <select
          className="ed2-input"
          data-testid="slide-image"
          value={image}
          disabled={busy}
          onChange={(event) => {
            const src = event.target.value;
            void run(backgroundOps(slide, src ? { src } : { color: "#26282C" }));
          }}
        >
          <option value="">No image (colour)</option>
          {images.map((item) => (
            <option key={item.path} value={item.path}>
              {item.name}
            </option>
          ))}
        </select>
        {images.length === 0 ? <small>Add images in the Timeline view's Media tab to use them here.</small> : null}
      </label>
      {!image ? (
        <label className="ed2-field">
          <span>Colour</span>
          <input
            type="color"
            className="ed2-slide-color"
            data-testid="slide-color"
            value={tint}
            disabled={busy}
            // One op when the picker closes, not one per step of a drag across the colours.
            onChange={(event) => setTint(event.target.value)}
            onBlur={() => {
              const next = tint.toUpperCase();
              if (next !== color.toUpperCase()) void run(backgroundOps(slide, { color: next }));
            }}
          />
        </label>
      ) : null}
      <label className="ed2-field">
        <span>
          Seconds on screen ({SLIDE_SECONDS.min}–{SLIDE_SECONDS.max})
        </span>
        <input
          type="number"
          className="ed2-input"
          data-testid="slide-seconds"
          min={SLIDE_SECONDS.min}
          max={SLIDE_SECONDS.max}
          step={0.5}
          value={seconds}
          disabled={busy}
          onChange={(event) => setSeconds(event.target.value)}
          onBlur={saveSeconds}
          onKeyDown={(event) => {
            if (event.key === "Enter") saveSeconds();
          }}
        />
      </label>
    </aside>
  );
}
