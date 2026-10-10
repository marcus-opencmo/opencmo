"use client";

/**
 * Một project trên web: tiến trình, lỗi, hoặc kết quả.
 *
 * `useLive` nghe hàng `jobs` của đúng project này và gọi lại
 * `GET /projects/[id]`. Polling 5 giây vẫn chạy như lưới an toàn vì Realtime có
 * thể bỏ lỡ một event dù channel còn kết nối; subscription `clips` dùng chung
 * lần đọc của `jobs` nên không mở timer thứ hai.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { FULL_EDIT_MAX_SECONDS, FullEditButton } from "@/components/editor/FullEditButton";
import { useRouter } from "next/navigation";

import type { Project } from "@/lib/clipping-types";

import { ApiError, api, jsonBody } from "../api";
import { PageSkeleton } from "../Skeleton";
import { ProcessingView, stageLabel } from "../ProcessingView";
import { ProjectAssistant } from "./ProjectAssistant";
import { ProjectResults } from "../ProjectResults";
import { CLIP_LENGTH_OPTIONS } from "../ProjectSettings";
import { clock } from "../ClipResultRow";
import { Notice, Toast } from "../ui";
import { useLive } from "../useLive";

const TERMINAL = new Set(["done", "failed", "cancelled"]);

type ZipTask = { id: string; status: string; error: string | null; url: string | null };

export function ProjectView({ projectId, briefId = null }: { projectId: string; briefId?: string | null }) {
  // A video brief from the CMO (approved in Approvals): its text is prefilled in the assistant.
  const [brief, setBrief] = useState<string | null>(null);
  useEffect(() => {
    if (!briefId) return;
    let live = true;
    api<{ prompt: string; project_id: string }>(`/cmo/video-briefs/${briefId}`)
      .then((found) => {
        if (live && found.project_id === projectId) setBrief(found.prompt);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [briefId, projectId]);
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [focusClip, setFocusClip] = useState<string | null>(null);
  const [zipTask, setZipTask] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);
  const request = useRef(0);
  const reading = useRef(false);
  const actionPending = useRef(false);

  const load = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const seq = ++request.current;
    try {
      const next = await api<Project>(`/projects/${encodeURIComponent(projectId)}`);
      if (seq !== request.current) return;
      setProject(next);
      setMissing(false);
      setLoadError(null);
    } catch (err) {
      if (seq !== request.current) return;
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else setLoadError(err instanceof Error ? err.message : "Could not open this project.");
    } finally {
      reading.current = false;
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Job đổi trạng thái/stage, hoặc clip đầu tiên xuất hiện.
  const live = project === null || !TERMINAL.has(project.status);
  useLive("jobs", `id=eq.${projectId}`, () => void load(), live);
  useLive("clips", `job_id=eq.${projectId}`, () => void load(), live, false);

  // Tiến độ trên tiêu đề tab: người dùng chuyển tab khác trong lúc chờ vẫn thấy
  // "(2/5) Rendering…" mà không phải quay lại. Trả tiêu đề cũ khi xong hoặc rời trang.
  const activeTitle =
    project && !TERMINAL.has(project.status)
      ? `(${project.clips.length}/${Math.max(project.clips_requested, project.clips.length)}) ${stageLabel(project)}`
      : null;
  useEffect(() => {
    if (!activeTitle) return;
    const original = document.title;
    document.title = `${activeTitle} · OpenCMO`;
    return () => {
      document.title = original;
    };
  }, [activeTitle]);

  // Lỗi mạng giữ task để lần đọc sau tiếp tục thay vì tạo ZIP trùng.
  const checkZip = useCallback(async () => {
    if (!zipTask) return;
    try {
      const task = await api<ZipTask>(`/tasks/${zipTask}`);
      setZipError(null);
      if (task.status === "done" && task.url) {
        setZipTask(null);
        window.location.href = task.url;
      } else if (["failed", "cancelled"].includes(task.status)) {
        setZipTask(null);
        setZipError(task.error ?? "Could not pack those clips. Select Download again to retry.");
      } else if (task.status === "done") {
        setZipError("Your ZIP is ready, but its download link is unavailable. Retry checking the download.");
      }
    } catch (err) {
      setZipError(err instanceof Error ? err.message : "Could not check your download. We will keep trying.");
    }
  }, [zipTask]);
  useLive("tasks", zipTask && `id=eq.${zipTask}`, () => void checkZip());
  useEffect(() => { void checkZip(); }, [checkZip]);

  async function downloadZip(clipIds: string[], variant: "original" | "edited") {
    await run(async () => {
      setZipError(null);
      const task = await api<ZipTask>(
        `/projects/${projectId}/exports.zip`,
        jsonBody({ clip_ids: clipIds, request_id: crypto.randomUUID(), ...(variant === "original" ? { variant } : {}) }),
      );
      if (task.status === "done" && task.url) window.location.href = task.url;
      else if (["failed", "cancelled"].includes(task.status)) setZipError(task.error ?? "Could not pack those clips. Please try again.");
      else setZipTask(task.id);
    });
  }

  async function run(action: () => Promise<void>) {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn’t work. Please try again.");
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }

  if (missing) {
    return (
      <section className="job-detail">
        <div className="empty-state">
          <p>This project is no longer in your library.</p>
          <button type="button" className="primary-button" onClick={() => router.push("/app/editor?panel=clips")}>
            Create new clips
          </button>
        </div>
      </section>
    );
  }

  if (!project) {
    return (
      <section className="job-detail">
        {loadError ? <Notice>{loadError}<button type="button" className="secondary-button" onClick={() => void load()}>Retry loading project</button></Notice> : <PageSkeleton variant="project" />}
      </section>
    );
  }

  return (
    <section className="job-detail">
      {/* Breadcrumb thay nút quay lại: nói rõ đang đứng ở đâu, không chỉ nói
          đường ra. */}
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/app/projects">My projects</Link>
        <span aria-hidden="true">/</span>
        <b>{project.title || project.source_name || "Your video"}</b>
      </nav>
      {error && <Notice>{error}</Notice>}
      {loadError && <Notice>{loadError} Your last loaded clips are still available. <button type="button" className="secondary-button" onClick={() => void load()}>Refresh project</button></Notice>}
      {zipError && <Notice>{zipError}{zipTask && <button type="button" className="secondary-button" onClick={() => void checkZip()}>Retry download check</button>}</Notice>}

      <div className="project-head">
        <div className="project-head-text">
          {renaming !== null ? (
            <form
              className="rename-form"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  setProject(
                    await api<Project>(
                      `/projects/${project.id}`,
                      jsonBody({ title: renaming.trim() }, "PATCH"),
                    ),
                  );
                  setRenaming(null);
                  setToast("Title updated.");
                });
              }}
            >
              <input
                aria-label="Project title"
                value={renaming}
                maxLength={120}
                autoFocus
                onChange={(event) => setRenaming(event.target.value)}
              />
              <button className="primary-button" disabled={busy || !renaming.trim()}>
                Save
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setRenaming(null)}
              >
                Cancel
              </button>
            </form>
          ) : (
            <div className="project-title-row">
              <h1>{project.title || "Your video"}</h1>
              <button
                type="button"
                className="text-button"
                onClick={() => setRenaming(project.title || project.source_name)}
              >
                Rename
              </button>
            </div>
          )}

          <p className="source-detail">
            {project.source_name}
            {project.duration ? ` · ${clock(project.duration)}` : ""}
            {` · ${project.clips_requested} ${project.clips_requested === 1 ? "clip" : "clips"}`}
            {` · ${
              CLIP_LENGTH_OPTIONS.find((o) => o.value === project.settings.clip_length)?.label ?? ""
            }`}
          </p>
        </div>

        {/* E2-c: video upload đã xử lý xong mở được nguyên file trong editor. */}
        {project.status === "done" && !/^https?:\/\//i.test(project.source_name) && (project.duration ?? 0) > 0 && (project.duration ?? 0) <= FULL_EDIT_MAX_SECONDS ? (
          <div className="project-actions">
            <FullEditButton jobId={project.id} onOpen={(href) => router.push(href)} />
          </div>
        ) : null}
      </div>

      {(project.status === "queued" || project.status === "running") && (
        <ProcessingView
          project={project}
          busy={busy}
          onCancel={() =>
            void run(async () => {
              setProject(
                await api<Project>(`/projects/${project.id}/cancel`, jsonBody({})),
              );
              setToast("Processing cancelled.");
            })
          }
        />
      )}

      {(project.status === "failed" || project.status === "cancelled") && (
        <div
          className={`processing-panel ${project.status === "failed" ? "failed-panel" : ""}`}
        >
          <h2>
            {project.status === "failed"
              ? "We couldn’t finish this video"
              : "Processing was cancelled"}
          </h2>
          {project.error && <p>{project.error}</p>}
          <p>{project.clips.length ? "Your completed clips are still available below. Retry to finish remaining clips or prepare their editing tools." : "Try again, or use a different public link or upload the video file."}</p>
          <div className="panel-actions">
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setProject(await api<Project>(`/jobs/${project.id}/retry`, jsonBody({})));
                  setToast("Processing this video again.");
                })
              }
            >
              {project.status === "failed" ? "Retry video" : "Process again"}
            </button>
            <button type="button" className="secondary-button" onClick={() => router.push("/app/editor?panel=clips")}>Use another video</button>
          </div>
        </div>
      )}

      {(project.status === "done" || project.clips.length > 0) && (
        <ProjectResults
          key={project.id}
          project={project}
          apiFn={api}
          focusClipId={focusClip}
          onFocusClip={setFocusClip}
          onEditClip={(clipId) =>
            router.push(`/app/editor/${clipId}`)
          }
          zipBusy={busy || zipTask !== null}
          onDownloadOriginals={(clipIds) => void downloadZip(clipIds, "original")}
          onDownloadEdits={(clipIds) => void downloadZip(clipIds, "edited")}
          onRefresh={() => void load()}

        />
      )}

      {project.clips.length > 0 && <ProjectAssistant jobId={project.id} brief={brief} onChanged={() => void load()} />}

      <Toast message={toast} onDone={() => setToast(null)} />
    </section>
  );
}
