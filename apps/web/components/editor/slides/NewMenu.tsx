"use client";

/**
 * "New" (P5 C1): a New video (an empty edit) or a New slideshow (an edit made of slides, opened in the Slides view).
 * A disclosure, not a menu role: two buttons a keyboard and a screen reader already know.
 */

import { useEffect, useRef, useState } from "react";

import { slidesHref } from "@/components/cards/slides";
import { Button } from "@/components/ui";

import { createBlankEdit } from "../ClipPicker";

export function NewMenu({ label = "New", onOpen, onError }: { label?: string; onOpen: (href: string) => void; onError: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const start = (kind: "video" | "slideshow") => {
    setBusy(true);
    void createBlankEdit("9:16", kind).then(
      (id) => onOpen(kind === "slideshow" ? slidesHref(id) : `/app/editor/${id}`),
      (err: unknown) => {
        setBusy(false);
        onError(err instanceof Error ? err.message : "Could not start a new edit.");
      },
    );
  };

  return (
    <div className="v2-new" ref={root}>
      <Button variant="primary" data-testid="studio-new" aria-expanded={open} aria-controls="v2-new-choices" disabled={busy} onClick={() => setOpen((was) => !was)}>
        {label} <span aria-hidden="true">▾</span>
      </Button>
      {open ? (
        <div id="v2-new-choices" className="v2-new-choices">
          <button type="button" data-testid="new-video" onClick={() => start("video")}>
            <b>New video</b>
            <span>An empty edit: bring your media, or ask the Assistant.</span>
          </button>
          <button type="button" data-testid="new-slideshow" onClick={() => start("slideshow")}>
            <b>New slideshow</b>
            <span>Slides with text and images, exported as an MP4 and a PNG set.</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
