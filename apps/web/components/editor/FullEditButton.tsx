"use client";

/**
 * "Edit full video" (E2-c): mở cả video UPLOAD trong editor thay vì một clip. Lần đầu
 * worker chuẩn bị master (remux, vài giây tới một phút) — nút chờ và báo lỗi tại chỗ.
 * Link YouTube không có nút này: phải tải nguyên video gốc (luật 3).
 */

import { useRef, useState } from "react";

import { api, jsonBody } from "@/components/clipping/api";
import type { FullEdit } from "@/app/api/v1/projects/[id]/full-edit/route";

/** Trần ở RPC `full_edit_max_seconds` — giữ khớp. */
export const FULL_EDIT_MAX_SECONDS = 900;

const POLL_MS = 2000;
const WAIT_MS = 10 * 60_000;

export function FullEditButton({ jobId, onOpen, className = "secondary-button" }: { jobId: string; onOpen: (href: string) => void; className?: string }) {
  const [state, setState] = useState<"idle" | "preparing" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const start = async () => {
    if (running.current) return;
    running.current = true;
    setError(null);
    try {
      const began = Date.now();
      let result = await api<FullEdit>(`/projects/${jobId}/full-edit`, jsonBody({}));
      setState(result.ready ? "idle" : "preparing");
      while (!result.ready) {
        if (Date.now() - began > WAIT_MS) throw new Error("Preparing the video is taking longer than usual. Try again in a few minutes.");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (result.task_id) {
          const task = await api<{ status: string; error: string | null }>(`/projects/${jobId}/full-edit?task=${result.task_id}`);
          if (task.status === "failed" || task.status === "cancelled") throw new Error(task.error ?? "Could not prepare the full video. Please try again.");
          if (task.status !== "done") continue;
        }
        result = await api<FullEdit>(`/projects/${jobId}/full-edit`, jsonBody({}));
      }
      onOpen(`/app/editor/${result.clip_id}`);
    } catch (err) {
      setState("failed");
      setError((err as Error).message);
    } finally {
      running.current = false;
    }
  };

  return (
    <span className="full-edit">
      <button type="button" className={className} data-testid="edit-full-video" disabled={state === "preparing"} onClick={() => void start()}>
        {state === "preparing" ? "Preparing full video…" : "Edit full video"}
      </button>
      {error ? (
        <span className="full-edit-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
