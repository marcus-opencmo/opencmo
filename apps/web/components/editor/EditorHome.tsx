"use client";

/**
 * Mục "Editor" trên rail (G1, Marcus 04/10): vào THẲNG editor — bản sửa gần nhất, hoặc một
 * bản trống 9:16 khi chưa có gì. Không còn màn chọn khung: khung đổi bằng FrameBar trong
 * editor. Danh sách các bản sửa nằm ở ô chọn trên thanh trên của editor.
 *
 * Chỉ tạo bản trống khi danh sách đọc được và RỖNG — lỗi mạng mà cũng tạo thì mỗi lần
 * tải lại trang đẻ thêm một bản "Untitled edit".
 */

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import type { EditorClip } from "@/app/api/v1/editor/clips/route";

import { createBlankEdit } from "./ClipPicker";

/** Bản nên mở: sửa gần nhất (API đã xếp `edited_at` mới nhất đầu), rồi bản trống chưa mở. */
export function pickEdit(clips: EditorClip[]): EditorClip | null {
  return clips.find((clip) => clip.edited_at) ?? clips.find((clip) => clip.kind === "blank") ?? null;
}

export function EditorHome() {
  const search = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const open = useCallback(async () => {
    setError(null);
    // Giữ tham số như `?panel=clips` (từ /app/video cũ) khi chuyển vào bản sửa.
    const query = search.toString();
    // Chuyển hẳn trang (không qua router client): trang này chỉ để chuyển hướng, và e2e
    // G1-c thấy `router.replace` đôi khi treo transition ở "Opening the editor…" khi vào lại
    // `/app/editor?panel=clips` từ một bản sửa đang mở.
    const go = (id: string) => window.location.replace(`/app/editor/${id}${query ? `?${query}` : ""}`);
    try {
      const response = await fetch("/api/v1/editor/clips");
      if (!response.ok) throw new Error("Could not open the editor. Check your connection and try again.");
      const { items } = (await response.json()) as { items: EditorClip[] };
      const latest = pickEdit(items);
      go(latest ? latest.clip_id : await createBlankEdit("9:16"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [search]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void open();
  }, [open]);

  return (
    <div className="editor-gate" data-testid="editor-home" aria-busy={!error}>
      {error ? (
        <>
          <h1>The editor did not open</h1>
          <p role="alert">{error}</p>
          <div className="editor-gate-link">
            <button type="button" className="primary-button" onClick={() => void open()}>
              Try again
            </button>
          </div>
        </>
      ) : (
        <p>Opening the editor…</p>
      )}
    </div>
  );
}
