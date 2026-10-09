"use client";

/**
 * Vùng canvas: vẽ scene bằng `clip-render` rồi đặt nó lên màn hình theo camera.
 *
 * Renderer tự `setTransform` và xoá canvas nó vẽ, nên nó vẽ vào một canvas PHỤ
 * cỡ scene × `renderScale`, và canvas thấy được chỉ chép canvas phụ đó vào đúng
 * chỗ của camera. Zoom/kéo vì thế không vẽ lại scene, chỉ chép lại.
 *
 * Cuộn = kéo khung; Ctrl/⌘ + cuộn (và pinch trên trackpad, trình duyệt gửi nó
 * dưới dạng ctrl+wheel) = zoom quanh con trỏ; kéo bằng nút giữa hoặc giữ Space
 * = kéo khung.
 */

import { useEffect, useRef, useState } from "react";

import type { Renderer } from "@opencmo/clip-render";

import type { Tool } from "./actions";
import { panBy, zoomAt, type Camera, type Size } from "./camera";

export function Stage({
  renderer,
  scale,
  frame,
  camera,
  redraw,
  onCamera,
  onViewport,
  tool = "move",
  overlay,
  others = [],
}: {
  renderer: Renderer | null;
  /** Tỉ lệ renderer đang vẽ (option `scale` lúc dựng). */
  scale: number;
  frame: number;
  camera: Camera;
  /** Đổi mỗi khi media vừa về thêm khung/ảnh — vẽ lại cùng khung. */
  redraw: number;
  onCamera: (next: Camera) => void;
  onViewport: (size: Size) => void;
  /** Hand (H): nút trái kéo khung như khi giữ Space. */
  tool?: Tool;
  /** Lớp tương tác phủ lên canvas; biết Space có đang giữ không để nhường việc kéo khung. */
  overlay?: (spaceHeld: () => boolean) => React.ReactNode;
  /**
   * Các scene cấp stage khác (công cụ Scene, như fork): vẽ ở khung của chúng,
   * lệch (dx, dy) so với scene đang mở — scene đang mở luôn ở gốc camera.
   */
  others?: { key: string; renderer: Renderer; frame: number; dx: number; dy: number }[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLCanvasElement>(null);
  const scratch = useRef<HTMLCanvasElement | null>(null);
  const otherScratch = useRef(new Map<string, HTMLCanvasElement>());
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const onCameraRef = useRef(onCamera);
  onCameraRef.current = onCamera;
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  // Cỡ vùng canvas → báo lên để camera vừa khung, và đặt cỡ pixel thật.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
      onViewport({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onViewport]);

  // Vẽ scene vào canvas phụ khi khung hay renderer đổi.
  const drawn = useRef<{ renderer: Renderer | null; frame: number; redraw: number }>({
    renderer: null,
    frame: -1,
    redraw: -1,
  });
  useEffect(() => {
    const canvas = view.current;
    const element = box.current;
    if (!canvas || !element) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(element.clientWidth * dpr));
    const height = Math.max(1, Math.round(element.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (renderer) {
      const last = drawn.current;
      if (last.renderer !== renderer || last.frame !== frame || last.redraw !== redraw) {
        scratch.current ??= document.createElement("canvas");
        const off = scratch.current;
        const w = Math.max(1, Math.round(renderer.scene.width * scale));
        const h = Math.max(1, Math.round(renderer.scene.height * scale));
        if (off.width !== w || off.height !== h) {
          off.width = w;
          off.height = h;
        }
        const offCtx = off.getContext("2d");
        try {
          if (offCtx) renderer.render(offCtx as never, frame);
        } catch (error) {
          console.error("[editor] render failed", error);
        }
        drawn.current = { renderer, frame, redraw };
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!renderer || !scratch.current) return;
    const { scale: s, x, y } = camera;
    const w = renderer.scene.width * s * dpr;
    const h = renderer.scene.height * s * dpr;
    ctx.imageSmoothingQuality = "high";
    for (const other of others) {
      let off = otherScratch.current.get(other.key);
      if (!off) {
        off = document.createElement("canvas");
        otherScratch.current.set(other.key, off);
      }
      const ow = Math.max(1, Math.round(other.renderer.scene.width * scale));
      const oh = Math.max(1, Math.round(other.renderer.scene.height * scale));
      if (off.width !== ow || off.height !== oh) {
        off.width = ow;
        off.height = oh;
      }
      try {
        const offCtx = off.getContext("2d");
        if (offCtx) other.renderer.render(offCtx as never, other.frame);
      } catch (error) {
        console.error("[editor] render failed", error);
      }
      const ox = (x + other.dx * s) * dpr;
      const oy = (y + other.dy * s) * dpr;
      ctx.drawImage(off, ox, oy, other.renderer.scene.width * s * dpr, other.renderer.scene.height * s * dpr);
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      ctx.strokeRect(ox - 0.5, oy - 0.5, other.renderer.scene.width * s * dpr + 1, other.renderer.scene.height * s * dpr + 1);
    }
    ctx.drawImage(scratch.current, x * dpr, y * dpr, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x * dpr - 0.5, y * dpr - 0.5, w + 1, h + 1);
  }, [renderer, scale, frame, camera, redraw, size, others]);

  // Cuộn/zoom. `passive: false` vì phải chặn trang tự cuộn và trình duyệt tự zoom.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const current = cameraRef.current;
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025));
        onCameraRef.current(zoomAt(current, factor, event.clientX - rect.left, event.clientY - rect.top));
      } else {
        onCameraRef.current(panBy(current, -event.deltaX, -event.deltaY));
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  // Kéo khung: nút giữa, hoặc nút trái khi đang giữ Space.
  const space = useRef(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === "Space" && !isTyping(event.target)) space.current = true;
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") space.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const drag = useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      ref={box}
      data-testid="editor-stage"
      className="absolute inset-0 overflow-hidden"
      onPointerDown={(event) => {
        if (event.button !== 1 && !(event.button === 0 && (space.current || tool === "hand"))) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const dx = event.clientX - drag.current.x;
        const dy = event.clientY - drag.current.y;
        drag.current = { x: event.clientX, y: event.clientY };
        onCameraRef.current(panBy(cameraRef.current, dx, dy));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
    >
      <canvas ref={view} data-testid="editor-canvas" className="block h-full w-full" />
      {overlay?.(() => space.current)}
    </div>
  );
}

export function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName));
}
