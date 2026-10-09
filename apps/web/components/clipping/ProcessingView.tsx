"use client";

/**
 * Màn xử lý.
 *
 * Trước đây đây là một panel toàn chữ: một dòng trạng thái và một đồng hồ đếm.
 * Đúng nhưng vô hình — người dùng nhìn hai phút không thấy gì đổi và kết luận
 * máy treo. Giờ nó hiện ảnh bìa video nguồn và một lưới ô theo ĐÚNG tỉ lệ khung
 * sắp nhận, điền dần khi từng clip được công bố (`publish_job_clip` đã công bố
 * tuần tự từ trước, ta chỉ chưa vẽ ra).
 *
 * Vẫn KHÔNG có thanh phần trăm. Worker không ghi tiến trình từng bước vào
 * database, nên mọi con số % ở đây đều là bịa — xem ghi chú ở `Elapsed.tsx`.
 * Cái đếm được thật là số clip đã xong trên tổng số clip đã đặt.
 */

import { useState } from "react";

import { Elapsed } from "@/components/Elapsed";
import type { Project } from "@/lib/clipping-types";

import { youtubeId } from "./web/YouTubePlayer";

/** Trạng thái thật từ worker; không suy đoán phần trăm hoặc ETA. */
export const STAGE_NAMES: Record<string, string> = {
  queued: "Waiting for a worker",
  probe: "Reading your video…",
  transcribe: "Creating captions…",
  select: "Finding your best moments…",
  download: "Preparing your chosen moments…",
  render: "Rendering your clips…",
  reframe: "Framing your clips…",
  prepare_editor: "Preparing optional editing…",
  done: "Ready",
  failed: "Needs attention",
  cancelled: "Cancelled",
};

const WORKING = "Making your clips…";

/**
 * Các bước của pipeline, sáng dần theo `project.stage` — thứ worker ghi thật.
 *
 * Thay đường đua mascot (30/09, giao diện Lapis & Marble): ảnh động nền sage
 * lạc tông với app sáng, và vị trí nhân vật không mang thông tin gì. Ở đây mỗi
 * bước ứng với một stage có thật, nên nó nói đúng máy đang làm gì mà vẫn không
 * bịa phần trăm. `download` nằm chung bước với `select`: nó chỉ tải đúng các
 * đoạn vừa chọn.
 */
const STEPS: { label: string; stages: string[] }[] = [
  { label: "Read", stages: ["probe"] },
  { label: "Transcribe", stages: ["transcribe"] },
  { label: "Find moments", stages: ["select", "download"] },
  { label: "Frame", stages: ["reframe"] },
  { label: "Render", stages: ["render", "prepare_editor"] },
];

function StageSteps({ project }: { project: Project }) {
  const current = project.status === "queued"
    ? -1
    : STEPS.findIndex((step) => step.stages.includes(project.stage));
  return (
    <ol className="stage-steps" aria-hidden="true">
      {STEPS.map((step, index) => (
        <li
          key={step.label}
          className={index < current ? "is-done" : index === current ? "is-current" : undefined}
        >
          <span className="stage-step-mark" />
          {step.label}
        </li>
      ))}
    </ol>
  );
}

export function stageLabel(project: Pick<Project, "status" | "stage">): string {
  if (["done", "failed", "cancelled", "queued"].includes(project.status)) {
    return STAGE_NAMES[project.status];
  }
  return STAGE_NAMES[project.stage] ?? (project.status === "running" ? WORKING : "Processing");
}

const ASPECT_RATIO: Record<string, string> = {
  "9:16": "9 / 16",
  "1:1": "1 / 1",
  "16:9": "16 / 9",
};

/** Ảnh bìa YouTube. Upload và Vimeo không có ảnh nào lấy được mà không tải video. */
function SourceThumb({ project }: { project: Project }) {
  const [failed, setFailed] = useState(false);
  const id = youtubeId(project.source_name);

  if (!id || failed) {
    return (
      <div className="processing-thumb is-empty" aria-hidden="true">
        <span>{project.source_name.slice(0, 40)}</span>
      </div>
    );
  }
  return (
    <div className="processing-thumb">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`}
        alt=""
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function ClipTile({
  clip,
  ratio,
}: {
  clip: Project["clips"][number] | null;
  ratio: string;
}) {
  if (!clip) {
    return <div className="clip-tile is-waiting" style={{ aspectRatio: ratio }} />;
  }
  return (
    <div className="clip-tile is-ready" style={{ aspectRatio: ratio }}>
      {/* Tắt tiếng và không điều khiển: đây là bằng chứng "đã xong", không phải
          chỗ để xem. Người dùng bấm xem ở danh sách kết quả bên dưới. */}
      <video src={`${clip.preview_url}#t=0.1`} muted playsInline preload="metadata" />
      <span>{clip.moment.hook || `Clip ${clip.index + 1}`}</span>
    </div>
  );
}

export function ProcessingView({
  project,
  busy,
  onCancel,
}: {
  project: Project;
  busy: boolean;
  onCancel: () => void;
}) {
  const queued = project.status === "queued";
  const full = project.settings.mode === "full";
  const ratio = ASPECT_RATIO[project.settings.aspect] ?? "9 / 16";
  const total = Math.max(project.clips_requested, project.clips.length);
  const ready = [...project.clips].sort((a, b) => a.index - b.index);
  const tiles = Array.from({ length: total }, (_, index) => ready[index] ?? null);

  return (
    <div className="processing-panel" role="status" aria-live="polite">
      <div className="processing-head">
        <SourceThumb project={project} />
        <div className="processing-status">
          <h2>{stageLabel(project)}</h2>
          <p className="processing-count">
            {full
              ? "Downloading your video at its original length."
              : `${project.clips.length} of ${total} ${total === 1 ? "clip" : "clips"} ready`}
          </p>
          <Elapsed since={project.attempt_started_at ?? project.created_at} />
        </div>
      </div>

      {!full && <StageSteps project={project} />}

      {!full && (
        <div className="clip-tiles" aria-hidden="true">
          {tiles.map((clip, index) => (
            <ClipTile key={clip?.id ?? `waiting-${index}`} clip={clip} ratio={ratio} />
          ))}
        </div>
      )}

      <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
        {queued ? "Remove from queue" : "Cancel processing"}
      </button>
    </div>
  );
}
