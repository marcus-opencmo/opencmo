"use client";

/**
 * Chọn giọng ngay ở ô chat (người dùng 02/10: muốn thấy danh sách giọng và nghe
 * thử, không phải gõ tên giọng rồi chờ 5 credit mới biết nó nghe thế nào).
 *
 * ▶ phát mẫu tĩnh `/voices/<Tên>.mp3` (`scripts/build-voice-previews.mts`):
 * không gọi server, không tốn credit. Chọn một giọng thì nó đi kèm câu lệnh
 * (`attachments.voice`) — agent dùng đúng giọng đó.
 */

import { useEffect, useMemo, useRef, useState } from "react";


import { liveModels, loadEnabledModels } from "../generate/GeneratePanel";

/** Giọng của các model voice đang bật trên server; rỗng khi chưa bật model nào. */
function useVoices(): string[] {
  const [enabled, setEnabled] = useState<Set<string> | null>(null);
  useEffect(() => {
    void loadEnabledModels().then(setEnabled);
  }, []);
  return useMemo(
    () => [...new Set(liveModels().filter((model) => model.kind === "voice" && enabled?.has(model.id)).flatMap((model) => model.limits.voices ?? []))],
    [enabled],
  );
}

export function VoicePicker({ value, onChange, disabled }: { value: string | null; onChange: (voice: string | null) => void; disabled?: boolean }) {
  const voices = useVoices();
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // Đóng danh sách thì dừng mẫu đang phát; bấm ra ngoài thì đóng.
  useEffect(() => {
    if (!open) {
      audio.current?.pause();
      setPlaying(null);
      return;
    }
    const outside = (event: PointerEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => () => audio.current?.pause(), []);

  if (!voices.length) return null;

  const preview = (voice: string) => {
    const el = (audio.current ??= new Audio());
    if (playing === voice) {
      el.pause();
      setPlaying(null);
      return;
    }
    el.pause();
    el.src = `/voices/${encodeURIComponent(voice)}.mp3`;
    el.onended = () => setPlaying(null);
    el.onerror = () => setPlaying(null);
    setPlaying(voice);
    void el.play().catch(() => setPlaying(null));
  };

  return (
    <div className="ed2-asst-voice" ref={box}>
      <button
        type="button"
        className={`ed2-asst-chip${value ? " is-on" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="assistant-voice"
        disabled={disabled}
        onClick={() => setOpen((state) => !state)}
      >
        {value ? `✓ Voice: ${value}` : "+ Voice"}
      </button>
      {open ? (
        <div className="ed2-asst-voice-list" role="listbox" aria-label="Voices" onKeyDown={(event) => event.key === "Escape" && setOpen(false)}>
          {voices.map((voice) => (
            <div key={voice} className={`ed2-asst-voice-row${voice === value ? " is-on" : ""}`}>
              <button
                type="button"
                className="ed2-asst-voice-play"
                aria-label={playing === voice ? `Stop ${voice}` : `Listen to ${voice}`}
                title={playing === voice ? "Stop" : "Listen"}
                data-testid={`assistant-voice-play-${voice}`}
                onClick={() => preview(voice)}
              >
                {playing === voice ? "■" : "▶"}
              </button>
              <button
                type="button"
                role="option"
                aria-selected={voice === value}
                className="ed2-asst-voice-name"
                data-testid={`assistant-voice-pick-${voice}`}
                onClick={() => {
                  onChange(voice === value ? null : voice);
                  setOpen(false);
                }}
              >
                {voice}
                {voice === value ? <span aria-hidden> ✓</span> : null}
              </button>
            </div>
          ))}
          {value ? (
            <button type="button" className="ed2-link ed2-asst-voice-clear" onClick={() => (onChange(null), setOpen(false))}>
              No voice preference
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
