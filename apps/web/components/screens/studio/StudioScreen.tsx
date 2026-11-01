"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, api } from "@/components/clipping/api";
import { NewMenu } from "@/components/editor/slides/NewMenu";
import { useShellState } from "@/components/shell-v2/ShellState";
import { Button, ButtonLink, EmptyState, SampleTag, Tabs } from "@/components/ui";
import type { Project } from "@/lib/clipping-types";
import { STUDIO_KINDS, type StudioScreen as Data, type TeamStep } from "@/lib/screens/studio";

import { ErrorNote, PageHeader, Panel, Screen, SkeletonBlocks } from "../parts";
import { useTabParam } from "../useTabParam";
import { useScreen } from "../useScreen";
import { StudioCard, type CardActions } from "./StudioCard";
import { StudioDrawer } from "./StudioDrawer";
import { cutShorts, markFinished, type EditState } from "./finish";
import { SORTS, projectCard, screenCard, sortCards, type Card, type Sort } from "./model";
import { useProjects } from "./useProjects";

type Kind = (typeof STUDIO_KINDS)[number];
const TABS: { id: "all" | Kind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "video", label: "Videos" },
  { id: "short", label: "Shorts" },
  { id: "slideshow", label: "Slideshows" },
  { id: "post_image", label: "Post images" },
  { id: "upload", label: "Your uploads" },
];
type Tab = (typeof TABS)[number]["id"];

export function StudioScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const [tab, setTab] = useTabParam<Tab>("kind", TABS.map((t) => t.id), "all");
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [favorites, setFavorites] = useState(false);
  const [sort, setSort] = useState<Sort>("edited");
  const [itemId, setItemId] = useState<string | null>(params.get("item"));
  const [error, setError] = useState<string | null>(null);
  const projects = useProjects(query);
  const [screen, reloadScreen] = useScreen("studio");
  const { toast } = useShellState();
  /** The edit a Mark finished or Cut shorts call is running for. */
  const [finishing, setFinishing] = useState<string | null>(null);

  // The search box lives in the URL (`?q=`), so coming back to Studio shows the same results.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (query.trim()) url.searchParams.set("q", query.trim());
    else url.searchParams.delete("q");
    window.history.replaceState(window.history.state, "", url);
  }, [query]);

  const openItem = useCallback((id: string | null) => {
    setItemId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("item", id);
    else url.searchParams.delete("item");
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const sampleItems = screen.status === "ready" && !screen.live.items;
  // Sample edit states would put buttons for edits that do not exist on real uploads.
  const editStates = useMemo(
    () => new Map<string, EditState>(screen.status === "ready" && screen.live.editStates ? screen.data.editStates.map((e) => [e.clipId, e]) : []),
    [screen],
  );

  const finish = useCallback(
    async (clipId: string, run: () => Promise<unknown>, done: string) => {
      if (finishing) return;
      if (sampleItems && !editStates.has(clipId)) {
        toast(`${done} (sample, nothing was sent).`);
        return;
      }
      setFinishing(clipId);
      setError(null);
      try {
        await run();
        toast(done);
        reloadScreen();
      } catch (err) {
        // A stale hash or an edit that is not finished: the server's sentence says what to do.
        setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
        reloadScreen();
      } finally {
        setFinishing(null);
      }
    },
    [finishing, sampleItems, editStates, toast, reloadScreen],
  );
  const cards = useMemo(() => {
    const uploads = projects.projects.map(projectCard);
    const ids = new Set(uploads.map((c) => c.id));
    const generated =
      screen.status === "ready"
        ? screen.data.items
            // Uploads are read live from the projects API; the screens route's sample uploads would be duplicates.
            .filter((item) => !(sampleItems && item.kind === "upload") && !(item.projectId && ids.has(item.projectId)))
            .map(screenCard)
        : [];
    return [...uploads, ...generated];
  }, [projects.projects, screen, sampleItems]);

  const needle = query.trim().toLowerCase();
  const visible = sortCards(
    cards.filter(
      (c) =>
        (tab === "all" || c.kind === tab) &&
        (!favorites || c.favorite) &&
        (!needle || c.project || c.title.toLowerCase().includes(needle)),
    ),
    sort,
  );
  const count = (id: Tab) => cards.filter((c) => id === "all" || c.kind === id).length;
  const selected = itemId ? (cards.find((c) => c.id === itemId) ?? null) : null;

  const actions: CardActions = {
    open: (card) => openItem(card.id),
    openInEditor: (card) => {
      if (card.editorHref) {
        router.push(card.editorHref);
        return;
      }
      if (!card.project) return;
      // The list carries no clip ids (too heavy); read the one upload to find its edit.
      void api<Project>(`/projects/${encodeURIComponent(card.project.id)}`)
        .then((project) => {
          const clip = project.clips.find((c) => c.id);
          if (clip?.id) router.push(`/app/editor/${encodeURIComponent(clip.id)}`);
          else openItem(card.id);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not open the editor."));
    },
    toggleFavorite: (card) => card.project && void projects.toggleFavorite(card.project),
    rename: (card, title) => card.project && void projects.rename(card.project, title),
    retry: (card) => card.project && void projects.retry(card.project),
    cancel: (card) => card.project && void projects.cancel(card.project),
    remove: (card) => {
      if (!card.project) return;
      void projects.remove(card.project);
      if (itemId === card.id) openItem(null);
    },
    markFinished: (clipId, documentHash) => void finish(clipId, () => markFinished(clipId, documentHash), "Marked finished. Shorts can be cut from it"),
    cutShorts: (clipId) => void finish(clipId, () => cutShorts(clipId), "Cutting 3 shorts. The batch card comes to your Dashboard"),
  };

  return (
    <Screen label="Studio">
      <PageHeader
        numeral="III"
        eyebrow="Studio"
        title="Videos, shorts, slides."
        sub="Everything here opens in the editor. Shorts are cut only from edits you marked finished."
        actions={
          <>
            <ButtonLink href="/app/editor?panel=upload" variant="secondary">
              Upload your video
            </ButtonLink>
            <NewMenu label="New in the editor" onOpen={(href) => router.push(href)} onError={setError} />
          </>
        }
      />
      <Tabs<Tab> label="Kind" idBase="studio-kind" panel={false} items={TABS.map((t) => ({ id: t.id, label: `${t.label} · ${count(t.id)}` }))} value={tab} onChange={setTab} />
      <div className="scr-studio-tools">
        <label className="scr-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            data-project-search
            aria-label="Search videos, shorts, uploads"
            placeholder="Search videos, shorts, uploads"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="button" className="scr-pill" aria-pressed={favorites} onClick={() => setFavorites((on) => !on)}>
          <span aria-hidden="true">★</span> Favorites
        </button>
        <label className="scr-sort">
          <span className="scr-small scr-muted">Sort</span>
          <select className="v2-input" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(error || projects.error) && <ErrorNote>{error ?? projects.error}</ErrorNote>}
      {sampleItems && cards.some((c) => !c.project) && (
        <p className="scr-tiny scr-muted">
          <SampleTag /> Generated videos, shorts and slides below are sample data; your uploads are real.
        </p>
      )}

      <div className="scr-split">
        <div className="scr-main">
          {!projects.loaded && screen.status === "loading" ? (
            <SkeletonBlocks rows={2} />
          ) : visible.length === 0 ? (
            <EmptyState
              title={needle || favorites ? "Nothing matches." : "Nothing here yet."}
              action={
                needle || favorites ? (
                  <Button variant="secondary" onClick={() => { setQuery(""); setFavorites(false); }}>
                    Clear filters
                  </Button>
                ) : (
                  <ButtonLink href="/app/editor?panel=upload" variant="primary">
                    Upload your video
                  </ButtonLink>
                )
              }
            >
              {needle || favorites ? "Clear the search or the favorites filter to see everything." : "Upload a video you made, or start a new edit."}
            </EmptyState>
          ) : (
            <div className="scr-grid">
              {visible.map((card) => (
                <StudioCard key={card.id} card={card} busy={projects.busyId === card.id || (!!finishing && finishing === card.clipId)} actions={actions} />
              ))}
            </div>
          )}
          {projects.hasMore && (
            <Button variant="secondary" disabled={projects.loading} onClick={projects.loadMore}>
              {projects.loading ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
        {screen.status === "ready" && screen.data.team && <TeamPanel team={screen.data.team} sample={!screen.live.team} />}
      </div>

      <StudioDrawer
        card={selected}
        missing={itemId && !selected && projects.loaded && screen.status !== "loading" ? itemId : null}
        busy={!!selected && projects.busyId === selected.id}
        actions={actions}
        onClose={() => openItem(null)}
        onProject={projects.replace}
        editStates={editStates}
        finishing={finishing}
      />
    </Screen>
  );
}

function TeamPanel({ team, sample }: { team: NonNullable<Data["team"]>; sample: boolean }) {
  return (
    <Panel id="studio-video-team-now" className="scr-side" title={<>Video team · now {sample && <SampleTag />}</>} sub={team.title}>
      <TeamSteps steps={team.steps} />
    </Panel>
  );
}

/** The Video team's steps on one video: Studio's team panel and, compact, under a video order on Brain. */
export function TeamSteps({ steps, compact = false }: { steps: TeamStep[]; compact?: boolean }) {
  return (
    <ol className={compact ? "scr-team is-compact" : "scr-team"}>
      {steps.map((step, i) => (
        <li key={step.label} className={`is-${step.state}`}>
          <span className="scr-team-mark" aria-hidden="true">
            {step.state === "done" ? "✓" : step.state === "running" ? "" : i + 1}
          </span>
          <span>{step.label}</span>
          <span className="scr-sr-only">{step.state === "done" ? "done" : step.state === "running" ? "in progress" : "to do"}</span>
        </li>
      ))}
    </ol>
  );
}
