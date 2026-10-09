"use client";

/**
 * Gắn giọng đọc đã về vào voiceover của nó (spec voiceover §4): khi khai báo
 * `generate.voice` của một audio có mark `voiceover` đã thành file trong thư
 * viện, hỏi lại generation để lấy độ dài thật + mốc từng chữ, rồi chạy op
 * `sync_voiceover` — `end` của audio đúng độ dài, phụ đề của giọng có transcript.
 *
 * Tách khỏi `useGenerations`: lượt Generate dùng lại (cùng hash, khác tab) cũng
 * phải gắn được, nên điều kiện là "record đã có mà voiceover chưa `synced`",
 * không phải "vừa sinh xong".
 */

import { useEffect, useRef } from "react";

import { isPartial, type LibraryRecord } from "@opencmo/clip-assets";
import type { ClipDocument } from "@opencmo/clip-doc";
import { activeScene, VOICEOVER_MARK, walk, type VoiceoverMark } from "@opencmo/editor-core";

import { generationMatches } from "../media";
import type { LibraryApi } from "../library/useLibrary";

type Word = { text: string; start: number; end: number };
type View = { status: string; asset: { duration: number | null; words: Word[] | null } | null };

const RETRY_MS = 1500;

export function useVoiceovers({
  document,
  library,
  run,
  notify,
}: {
  document: ClipDocument;
  library: LibraryApi;
  run: (ops: unknown[]) => Promise<ClipDocument | null>;
  notify: (message: string) => void;
}): void {
  const pending = useRef(new Set<string>());
  const runRef = useRef(run);
  runRef.current = run;
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    const waiting: { key: string; src: Record<string, unknown>; start: number }[] = [];
    walk(document, ({ entity, tag }) => {
      if (tag !== "audio") return;
      const mark = (entity.marks as Record<string, unknown> | undefined)?.[VOICEOVER_MARK] as VoiceoverMark | undefined;
      const src = entity.src as Record<string, unknown> | undefined;
      if (!mark || mark.synced || !src || typeof src !== "object" || src.generate !== "voice") return;
      waiting.push({ key: mark.key, src, start: typeof entity.start === "number" ? entity.start : 0 });
    });
    const timers: ReturnType<typeof setTimeout>[] = [];
    const [from, to] = activeScene(document).workarea ?? [0, 0];
    for (const { key, src, start } of waiting) {
      if (pending.current.has(key)) continue;
      const record = libraryRef.current
        .latest()
        .assets.find((item) => !isPartial(item) && generationMatches(src, item as never)) as LibraryRecord | undefined;
      const id = record?.generation?.id;
      if (!id) continue;
      pending.current.add(key);
      void attach(key, id, to - from - start).finally(() => pending.current.delete(key));
    }

    async function attach(key: string, id: string, room: number) {
      const response = await fetch(`/api/v1/generations/${encodeURIComponent(id)}`).catch(() => null);
      const view = response?.ok ? ((await response.json().catch(() => null)) as View | null) : null;
      const duration = view?.asset?.duration;
      if (!duration || duration <= 0) return;
      const words = view?.asset?.words ?? undefined;
      const applied = await runRef.current([{ op: "sync_voiceover", key, duration, ...(words?.length ? { words } : {}) }]);
      // Editor đang bận một lượt sửa khác: thử lại một nhịp sau.
      if (!applied) {
        timers.push(setTimeout(() => void attach(key, id, room), RETRY_MS));
        return;
      }
      // Export dừng ở cuối clip: giọng dài hơn thì mất đuôi mà timeline vẫn vẽ
      // đủ — thấy được trên file xuất ra là đã quá muộn (đo thật: mất 10s cuối).
      const over = duration - room;
      if (room > 0 && over > 1) {
        notifyRef.current(`The voiceover is ${Math.round(over)}s longer than the clip, so its last words will be cut. Shorten the script and generate again.`);
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [document, library.manifest]);
}
