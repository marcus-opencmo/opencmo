"use client";

/**
 * Trình phát YouTube nhúng, đủ để CHỌN đoạn — không phải để xem hết video.
 *
 * Vì sao nhúng iframe thay vì chờ server: dán link là thấy video ngay, 0 giây,
 * 0 đồng băng thông, 0 byte storage. Đường cũ bắt người dùng chờ hết
 * transcribe + LLM chọn rồi mới thấy bất cứ thứ gì — và đó là toàn bộ lý do
 * flow cũ bị bỏ.
 *
 * Vì sao dùng IFrame Player API chứ không phải thẻ `<iframe>` trần: thanh chọn
 * đoạn cần `getDuration()` để vẽ, và `seekTo()` để người dùng NHÌN THẤY chỗ
 * mình đang cắt. Không có hai thứ đó thì thanh bar chỉ là một ô nhập số.
 *
 * CSP phải cho phép `frame-src` và `script-src` của YouTube — xem `next.config.ts`.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const API_SRC = "https://www.youtube.com/iframe_api";

type YtPlayer = {
  getDuration: () => number;
  getCurrentTime: () => number;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  getPlayerState: () => number;
  destroy: () => void;
};

type YtWindow = Window & {
  YT?: { Player: new (el: HTMLElement, options: unknown) => YtPlayer; loading?: number };
  onYouTubeIframeAPIReady?: () => void;
};

/**
 * Nhận id video từ mọi kiểu link YouTube người dùng dán thật:
 * `watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, và link kèm `&list=…`.
 */
export function youtubeId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const valid = (id: string | undefined | null) =>
    id && /^[\w-]{11}$/.test(id) ? id : null;

  if (host === "youtu.be") return valid(url.pathname.slice(1).split("/")[0]);
  if (!["youtube.com", "m.youtube.com", "youtube-nocookie.com"].includes(host)) return null;
  if (url.pathname === "/watch") return valid(url.searchParams.get("v"));
  const match = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]+)/);
  return valid(match?.[1]);
}

/** Nạp `iframe_api` đúng một lần cho cả trang. */
function loadApi(): Promise<void> {
  const w = window as YtWindow;
  if (w.YT?.Player) return Promise.resolve();
  return new Promise((resolve, reject) => {
    // Callback toàn cục là hợp đồng của YouTube, không phải lựa chọn của ta:
    // script nạp xong sẽ gọi đúng cái tên này.
    const previous = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    if (document.querySelector(`script[src="${API_SRC}"]`)) return;
    const tag = document.createElement("script");
    tag.src = API_SRC;
    tag.async = true;
    tag.onerror = () => reject(new Error("Could not load the YouTube player."));
    document.head.appendChild(tag);
  });
}

export type PlayerHandle = {
  /** 0 khi player chưa sẵn sàng — thanh bar dùng nó để biết khi nào vẽ được. */
  duration: number;
  /** Vị trí đầu đọc, cập nhật 4 lần/giây khi đang phát. */
  time: number;
  ready: boolean;
  error: string | null;
  seek: (seconds: number) => void;
  play: () => void;
  pause: () => void;
  playing: boolean;
};

export function useYouTubePlayer(videoId: string | null): PlayerHandle & {
  mountRef: (node: HTMLDivElement | null) => void;
} {
  const player = useRef<YtPlayer | null>(null);
  const node = useRef<HTMLDivElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountRef = useCallback((next: HTMLDivElement | null) => {
    node.current = next;
  }, []);

  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;
    setReady(false);
    setDuration(0);
    setTime(0);
    setError(null);

    void loadApi()
      .then(() => {
        if (cancelled || !node.current) return;
        const w = window as YtWindow;
        const host = document.createElement("div");
        node.current.replaceChildren(host);
        player.current = new w.YT!.Player(host, {
          videoId,
          // `nocookie` và `rel: 0`: người dùng đang chọn đoạn, không phải đang
          // duyệt đề xuất của YouTube.
          host: "https://www.youtube-nocookie.com",
          playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
          events: {
            onReady: (event: { target: YtPlayer }) => {
              if (cancelled) return;
              setDuration(event.target.getDuration());
              setReady(true);
            },
            onStateChange: (event: { data: number }) => {
              if (!cancelled) setPlaying(event.data === 1);
            },
            onError: () => {
              if (!cancelled) {
                setError(
                  "This video can't be played here. It may be private, " +
                    "age-restricted, or blocked from embedding.",
                );
              }
            },
          },
        });
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
      try {
        player.current?.destroy();
      } catch {
        // Player đã bị gỡ cùng DOM — không có gì để dọn.
      }
      player.current = null;
    };
  }, [videoId]);

  // 4 lần/giây: đủ mượt cho một đầu đọc rộng 2px, và rẻ. `setInterval` chứ
  // không phải `requestAnimationFrame` vì tab ẩn thì dừng luôn là đúng.
  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => {
      const current = player.current?.getCurrentTime();
      if (typeof current === "number") setTime(current);
      // Duration của livestream/video dài đôi khi tới muộn hơn `onReady`.
      const total = player.current?.getDuration();
      if (typeof total === "number" && total > 0) setDuration(total);
    }, 250);
    return () => window.clearInterval(id);
  }, [ready]);

  const seek = useCallback((seconds: number) => {
    player.current?.seekTo(Math.max(0, seconds), true);
    setTime(Math.max(0, seconds));
  }, []);

  return {
    duration,
    time,
    ready,
    error,
    playing,
    seek,
    play: useCallback(() => player.current?.playVideo(), []),
    pause: useCallback(() => player.current?.pauseVideo(), []),
    mountRef,
  };
}
