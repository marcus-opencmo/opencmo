"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { Project, ProjectPage } from "@/lib/clipping-types";

import { ApiError, api, jsonBody } from "../api";
import { createBlankEdit } from "@/components/editor/ClipPicker";

import { ProjectLibrary } from "../ProjectLibrary";
import { Notice } from "../ui";
import { useLive } from "../useLive";
import { useShellAccount } from "./WebShell";

const ACTIVE = new Set(["queued", "running"]);


export function LibraryView() {
  const router = useRouter();
  const { userId } = useShellAccount();
  const [projects, setProjects] = useState<Project[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const urlSynced = useRef(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [favoriteBusy, setFavoriteBusy] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState<string | null>(null);
  const request = useRef(0);
  const deletedIds = useRef(new Set<string>());

  const load = useCallback(async (next: { query: string; cursor?: string | null }) => {
    const seq = ++request.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (next.query.trim()) params.set("q", next.query.trim());
      if (next.cursor) params.set("cursor", next.cursor);
      const page = await api<ProjectPage>(`/projects?${params}`);
      if (seq !== request.current) return;
      setProjects((current) =>
        (next.cursor ? [...current, ...page.items] : page.items)
          .filter((item) => !deletedIds.current.has(item.id)),
      );
      setCursor(page.next_cursor);
      setLoaded(true);
    } catch (err) {
      if (seq !== request.current) return;
      setError(err instanceof ApiError ? err.message : "Could not load your projects.");
    } finally {
      if (seq === request.current) setLoading(false);
    }
  }, []);

  // Gõ tới đâu lọc tới đó, nhưng đợi 250ms: mỗi ký tự một request là một câu
  // query keyset trên database cho mỗi lần nhấn phím.
  useEffect(() => {
    const timer = setTimeout(() => void load({ query }), 250);
    return () => clearTimeout(timer);
  }, [query, load]);

  // Ô tìm nằm trên URL (`?q=`): quay lại thư viện vẫn còn đúng kết quả đang xem.
  // Đọc sau khi mount — đọc lúc render thì HTML server và client lệch nhau.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("q");
    if (fromUrl) setQuery(fromUrl);
  }, []);

  // replaceState chứ không phải router.replace: đổi URL không được kéo theo
  // một lượt render lại từ server cho mỗi lần gõ. Bỏ lượt đầu: lúc đó query
  // vẫn rỗng và sẽ xoá mất `?q=` vừa đọc.
  useEffect(() => {
    if (!urlSynced.current) {
      urlSynced.current = true;
      return;
    }
    const url = new URL(window.location.href);
    if (query.trim()) url.searchParams.set("q", query.trim());
    else url.searchParams.delete("q");
    window.history.replaceState(window.history.state, "", url);
  }, [query]);

  // Thẻ đang chạy tự đổi trạng thái: chỉ cập nhật những thẻ đang hiện, không
  // đọc lại cả danh sách (sẽ làm mất các trang đã tải thêm).
  const hasActive = projects.some((item) => ACTIVE.has(item.status));
  const refreshStatuses = useCallback(async () => {
    try {
      const page = await api<ProjectPage>("/projects?limit=24");
      const fresh = new Map(page.items.map((item) => [item.id, item]));
      setProjects((current) => current.map((item) => fresh.get(item.id) ?? item));
    } catch {
      // Chỉ là làm mới nền; lần sau sẽ thử lại.
    }
  }, []);
  useLive("jobs", userId && `user_id=eq.${userId}`, () => void refreshStatuses(), Boolean(userId) && hasActive, true, "library");

  return (
    <>
      {error && <Notice>{error}</Notice>}
      <ProjectLibrary
        projects={projects}
        loaded={loaded}
        loading={loading}
        query={query}
        hasMore={!!cursor}
        busyId={favoriteBusy ?? deleteBusy ?? retryBusy}
        onQuery={(next) => {
          request.current += 1;
          setCursor(null);
          setQuery(next);
        }}
        onLoadMore={() => void load({ query, cursor })}
        onOpen={(project) => router.push(`/app/projects/${project.id}`)}
        onToggleFavorite={(project) => {
          const favorite = !project.favorite;
          setError(null);
          setFavoriteBusy(project.id);
          setProjects((current) =>
            current.map((item) => (item.id === project.id ? { ...item, favorite } : item)),
          );
          void api<Project>(`/projects/${project.id}`, jsonBody({ favorite }, "PATCH"))
            .then((saved) =>
              setProjects((current) =>
                current.map((item) => (item.id === saved.id ? saved : item)),
              ),
            )
            .catch((err) => {
              setProjects((current) =>
                current.map((item) =>
                  item.id === project.id ? { ...item, favorite: project.favorite } : item,
                ),
              );
              setError(err instanceof ApiError ? err.message : "Could not update that project.");
            })
            .finally(() => setFavoriteBusy(null));
        }}
        onRetry={(project) => {
          setError(null);
          setRetryBusy(project.id);
          void api<Project>(`/jobs/${project.id}/retry`, jsonBody({}))
            .then((saved) =>
              setProjects((current) =>
                current.map((item) => (item.id === project.id ? { ...item, ...saved } : item)),
              ),
            )
            .catch((err) => {
              setError(err instanceof ApiError ? err.message : "Could not retry that project.");
            })
            .finally(() => setRetryBusy(null));
        }}
        onDelete={(project) => {
          // Xác nhận đã nằm trên thẻ (bấm Delete hai lần), không dùng window.confirm.
          setError(null);
          setDeleteBusy(project.id);
          void api<{ deleted: boolean }>(`/projects/${project.id}`, { method: "DELETE" })
            .then((result) => {
              if (!result.deleted) throw new Error("Could not delete that project.");
              deletedIds.current.add(project.id);
              setProjects((current) => current.filter((item) => item.id !== project.id));
            })
            .catch((err) => {
              setError(err instanceof ApiError ? err.message : "Could not delete that project.");
            })
            .finally(() => setDeleteBusy(null));
        }}
        onCreate={() => router.push("/app/editor?panel=clips")}
        onBlank={() => {
          void createBlankEdit("9:16").then(
            (id) => router.push(`/app/editor/${id}`),
            (err: unknown) => setError(err instanceof Error ? err.message : "Could not start a new project."),
          );
        }}
      />
    </>
  );
}
