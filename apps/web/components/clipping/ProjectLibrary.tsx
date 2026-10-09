"use client";

import { useEffect, useRef, useState } from "react";

import { Mascot } from "@/components/brand/Brand";
import { Icon } from "@/components/icons";

import type { Project } from "@/lib/clipping-types";

import { PageSkeleton } from "./Skeleton";
import { stageLabel } from "./ProcessingView";

export function projectHref(projectId: string, clipId?: string | null, edit = false) {
  const base = `/app/projects/${encodeURIComponent(projectId)}`;
  if (!clipId) return base;
  return edit ? `/app/editor/${encodeURIComponent(clipId)}` : `${base}?clip=${encodeURIComponent(clipId)}`;
}

function clock(seconds: number) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${String(m).padStart(2, "0")}:${s}`;
}

function summary(project: Project) {
  if (project.status === "done") {
    const n = project.clip_count ?? project.clips.length;
    return n ? `${n} ${n === 1 ? "clip" : "clips"} ready` : "No usable moments found";
  }
  return stageLabel(project);
}

export function FavoriteButton({
  favorite,
  label,
  disabled,
  onToggle,
}: {
  favorite: boolean;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="favorite-button"
      aria-pressed={favorite}
      aria-label={favorite ? `Remove ${label} from favorites` : `Add ${label} to favorites`}
      title={favorite ? "Remove from favorites" : "Add to favorites"}
      disabled={disabled}
      onClick={onToggle}
    >
      <span aria-hidden="true">{favorite ? "★" : "☆"}</span>
    </button>
  );
}

export function ProjectLibrary({
  projects,
  loaded,
  loading,
  query,
  hasMore,
  busyId,
  onQuery,
  onLoadMore,
  onOpen,
  onToggleFavorite,
  onDelete,
  onRetry,
  onCreate,
  onBlank,
}: {
  projects: Project[];
  loaded: boolean;
  loading: boolean;
  query: string;
  hasMore: boolean;
  /** Thẻ đang có thao tác dở — CHỈ thẻ đó bị khoá, không phải cả thư viện. */
  busyId: string | null;
  onQuery: (query: string) => void;
  onLoadMore: () => void;
  onOpen: (project: Project) => void;
  onToggleFavorite: (project: Project) => void;
  onDelete: (project: Project) => void;
  /** Chạy lại job lỗi ngay từ thẻ, không phải mở project ra mới thấy nút. */
  onRetry?: (project: Project) => void;
  onCreate: () => void;
  /** Project trống (New project): mở editor với một khung 9:16 trống. */
  onBlank: () => void;
}) {
  // Cuộn tới cuối thì tự tải trang sau; nút "Load more" vẫn còn cho bàn phím
  // và cho trình duyệt không có IntersectionObserver.
  const more = useRef<HTMLButtonElement>(null);
  const latest = useRef({ loading, onLoadMore });
  latest.current = { loading, onLoadMore };
  // Xoá bằng hai lần bấm trên đúng thẻ đó; tự huỷ sau 3 giây.
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(null), 3000);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  useEffect(() => {
    const target = more.current;
    if (!hasMore || !target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !latest.current.loading) {
          latest.current.onLoadMore();
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore]);

  return (
    <section className="projects-view">
      <div className="projects-heading">
        <div><h1>Projects</h1></div>
        <label className="projects-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            data-project-search
            aria-keyshortcuts="/"
            aria-label="Search projects"
            placeholder="Search by title or file name"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
          <kbd aria-hidden="true">/</kbd>
        </label>
        <div className="projects-actions">
          <button type="button" className="secondary-button" data-testid="projects-new-clips" onClick={onCreate}>
            Clips from a video
          </button>
          <button type="button" className="primary-button" data-testid="projects-new" onClick={onBlank}>
            <Icon name="plus" size={16} /> New project
          </button>
        </div>
      </div>

      {!loaded ? (
        <PageSkeleton variant="library" />
      ) : projects.length === 0 ? (
        <div className="empty-state library-empty-state">
          {!query && <Mascot className="empty-mascot" />}
          <p>{query ? "No projects match your search." : "No projects yet."}</p>
          {query ? (
            <button type="button" className="secondary-button" onClick={() => onQuery("")}>
              Clear search
            </button>
          ) : (
            <div className="projects-actions">
              <button type="button" className="secondary-button" onClick={onCreate}>
                Create clips
              </button>
              <button type="button" className="primary-button" onClick={onBlank}>
                New project
              </button>
            </div>
          )}
        </div>
      ) : (
        <ul className="project-list">
          {/* Ô đầu luôn là lối tạo mới: người vào thư viện phần lớn là để làm
              thêm clip, không phải để ngắm cái đã có. */}
          <li>
            <button type="button" className="card-new" onClick={onCreate}>
              <span className="card-new-plus">
                <Icon name="plus" size={22} />
              </span>
              <b>New clips</b>
              <small>Upload a video you own, or open it in the editor.</small>
            </button>
          </li>
          {projects.map((project) => {
            const title = project.title || project.source_name;
            const busy = busyId === project.id;
            // Rê chuột vào thẻ thì clip đầu tự phát không tiếng — xem trước mà
            // không phải mở project; bấm thì cả thẻ là link.
            const preview = (event: React.MouseEvent<HTMLLIElement>, play: boolean) => {
              const video = event.currentTarget.querySelector("video");
              if (!video) return;
              if (play) void video.play().catch(() => undefined);
              else video.pause();
            };
            return (
              <li
                key={project.id}
                className={`project-item is-${project.status}`}
                onMouseEnter={(event) => preview(event, true)}
                onMouseLeave={(event) => preview(event, false)}
              >
                <div className="project-thumbnail">
                  {project.thumbnail_url ? (
                    <video
                      src={`${project.thumbnail_url}#t=0.1`}
                      muted
                      loop
                      playsInline
                      preload="metadata"
                      aria-label={`Preview ${title}`}
                    />
                  ) : (
                    <div className="project-thumbnail-placeholder">
                      <span aria-hidden="true">▶</span>
                      {/* Trạng thái đã nằm trên badge ngay dưới; lặp lại ở đây
                          chỉ làm thẻ trông như bị lỗi. */}
                      <small>No preview yet</small>
                    </div>
                  )}
                  {project.duration ? <span className="project-duration">{clock(project.duration)}</span> : null}
                  <span className="project-status-badge">
                    <span className={`job-dot ${project.status}`} aria-hidden="true" />
                    {summary(project)}
                  </span>
                </div>
                <div className="project-card-footer">
                  <a
                    className="project-row"
                    href={projectHref(project.id)}
                    onClick={(event) => {
                      event.preventDefault();
                      onOpen(project);
                    }}
                  >
                    <span className="project-row-text">
                      <strong>{title}</strong>
                      <small>
                        <time dateTime={project.created_at}>
                          {new Date(project.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </time>
                      </small>
                    </span>
                  </a>
                  {project.status === "failed" && onRetry && (
                    <button
                      type="button"
                      className="card-retry"
                      disabled={busy}
                      onClick={() => onRetry(project)}
                    >
                      {busy ? "Retrying…" : "Retry"}
                    </button>
                  )}
                  <FavoriteButton
                    favorite={project.favorite}
                    label={title}
                    disabled={busy}
                    onToggle={() => onToggleFavorite(project)}
                  />
                  <button
                    type="button"
                    className="delete-project-button"
                    aria-label={confirming === project.id ? `Confirm deleting ${title}` : "Delete project"}
                    title="Delete project"
                    data-confirming={confirming === project.id || undefined}
                    disabled={busy}
                    onClick={() => {
                      if (confirming !== project.id) {
                        setConfirming(project.id);
                        return;
                      }
                      setConfirming(null);
                      onDelete(project);
                    }}
                  >
                    {confirming === project.id ? "Confirm delete" : "Delete"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {hasMore && (
        <button
          ref={more}
          type="button"
          className="secondary-button load-more"
          disabled={loading}
          onClick={onLoadMore}
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
