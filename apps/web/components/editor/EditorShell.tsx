"use client";

/**
 * Shell React của editor (spec editor-rewrite B2; mặc định cho mọi người từ C2).
 *
 * Document là nguồn sự thật: mọi lượt sửa là `applyOps` của editor-core trên
 * document trong tab, rồi `DocumentSession` lưu nó qua `PUT /editor/document`
 * với khoá lạc quan. Preview vẽ chính document đó bằng `clip-render` — cùng mã
 * với export trên server, nên thứ thấy trên canvas là thứ file xuất ra.
 *
 * Phủ kín màn hình (fixed) thay vì nằm trong khung của workspace: editor cần
 * từng pixel, và rail bên trái của app không có việc gì ở đây.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { isPartial, type LibraryRecord } from "@opencmo/clip-assets";
import { DocumentInvalidError, type ClipDocument } from "@opencmo/clip-doc";
import { createRenderer, type Renderer } from "@opencmo/clip-render";
import { activeScene, applyOps, cutPoints, speechSources, EXPLAINER_MODEL, frameAspect, keyframesOf, MOTION_CLIP_MODEL, isRow, MASTER_SRC, readCaptionState, readFrame, readLayout, stamp, subtitleCues, timesOf, toSrt, toVtt, walk, type Frame, type OpContext, type Transcript } from "@opencmo/editor-core";

import { ApiError, api, jsonBody } from "@/components/clipping/api";
import { useShellAccount } from "@/components/clipping/web/WebShell";
import { useOptionalShellState } from "@/components/shell-v2/ShellState";
import type { RenderTask } from "@/lib/api/tasks";
import { DocumentSession, SaveConflict, type SaveTransport, type TransactOptions } from "@/lib/editor/session";
import { UI_V2 } from "@/lib/screens/flag";

import { fitCamera, renderScale, zoomAt, type Camera, type Size } from "./camera";
import { FrameBar } from "./FrameBar";
import { BrowserMedia, libraryRecord, loadFonts, type EditorMedia, type Manifest } from "./media";
import { Playback } from "./playback";
import { isTyping, Stage } from "./Stage";
import { createActions, type Tool } from "./actions";
import { CanvasOverlay } from "./canvas/Overlay";
import { matchShortcut, shortcutLabel, type ActionName } from "./shortcuts";
import { ContextMenu, DropdownMenu, type MenuItem } from "./menus/Menu";
import { ApplyBrandDialog, ApplyStyleDialog, HistoryDialog, ShortcutsDialog } from "./menus/dialogs";
import { TopBar, type ExportState } from "./TopBar";

import { Inspector } from "./inspector/Inspector";
import { variantsOf } from "./inspector/variants";
import { BackgroundPanel } from "./generate/BackgroundPanel";
import { EditVideoPanel } from "./generate/EditVideoPanel";
import { ASSET_DRAG, LibraryPanel } from "./library/LibraryPanel";
import { useAutoTranscripts } from "./library/useAutoTranscripts";
import { TranscriptPanel } from "./transcript/TranscriptPanel";
import { UploadPanel } from "./upload/UploadPanel";
import { AssistantPanel } from "./assistant/AssistantPanel";
import { AssistantClient } from "./assistant/client";
import { capture, grab, inspectColor, waveform, withoutText, type InspectColorInput } from "./assistant/capture";
import { ClipPicker, createBlankEdit } from "./ClipPicker";
import { GuidesMenu, GuidesOverlay, useGuides } from "./Guides";
import { priceOf, type AiModel } from "@opencmo/editor-core/generate";
import { liveModel, liveModels, storedImages, GeneratePanel, useEnabledModels, type EditSource } from "./generate/GeneratePanel";
import { useExplainers } from "./generate/useExplainers";
import { useVoiceovers } from "./generate/useVoiceovers";
import { VisualsPanel, type SelectedVisual } from "./visuals/VisualsPanel";
import { continuationsOf } from "./generate/chain";
import { aiStateOf, ownDeclarations, pendingGenerations, resolve as resolveGeneration, useGenerations } from "./generate/useGenerations";
import { useLibrary } from "./library/useLibrary";
import { gridFor, layoutKey, MIN, PRESETS, splitterFor, useEditorLayout, type PanelName } from "./layout";
import { PanelToggles } from "./PanelToggles";
import { Splitter } from "./Splitter";
import { Soundboard } from "./soundboard/Soundboard";
import { SlidePanel, SlideStrip, readSlides, slideAt } from "./slides/SlidesView";
import { Timeline } from "./timeline/Timeline";
import { studioItemHref } from "@/components/screens/studio/href";

/** Trần chờ một lượt export: worker có trần 30 phút cho exporter, cộng xếp hàng. */
const EXPORT_WAIT_MS = 40 * 60_000;
/** Số lượt poll lỗi mạng liền nhau trước khi báo người dùng (~10 giây). */
const EXPORT_MAX_MISSES = 5;

type ProjectPayload = {
  version: number;
  document: ClipDocument;
  document_hash: string;
  manifest: Manifest;
  media: EditorMedia;
};

type Ready = { session: DocumentSession; media: EditorMedia; manifest: Manifest };

function saveTransport(clipId: string): SaveTransport {
  return {
    async save(expectedVersion, document, manifest) {
      try {
        return await api<{ version: number; document_hash: string }>(
          "/editor/document",
          jsonBody({ clip_id: clipId, expected_version: expectedVersion, document, ...(manifest === undefined ? {} : { manifest }) }, "PUT"),
        );
      } catch (error) {
        // Chỉ P0409 là xung đột phiên bản (mang `current`). P0001 cũng ra 409
        // nhưng là lỗi thường — coi nó là "đổi ở tab khác" thì autosave dừng hẳn
        // với một lý do sai.
        const detail = error instanceof ApiError ? error.detail : null;
        if (error instanceof ApiError && error.status === 409 && detail && typeof detail === "object" && "current" in detail) {
          const current = (error.detail as { current?: { version?: number; document?: ClipDocument } } | null)
            ?.current;
          throw new SaveConflict(
            current?.document && typeof current.version === "number"
              ? { version: current.version, document: current.document }
              : null,
          );
        }
        throw error;
      }
    },
  };
}

export function EditorShell({ projectId, clipId }: { projectId: string; clipId: string }) {
  const [ready, setReady] = useState<Ready | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let session: DocumentSession | null = null;
    void (async () => {
      try {
        const project = await api<ProjectPayload>(`/editor/project?clip_id=${encodeURIComponent(clipId)}`);
        if (cancelled) return;
        session = new DocumentSession(
          { document: project.document, version: project.version, documentHash: project.document_hash, manifest: project.manifest ?? undefined },
          saveTransport(clipId),
        );
        // Timeline và op gọi phần tử theo `id`. Project sinh trước khi có id
        // (bộ sinh không đặt) nhận id một lần ở đây và lưu như một lượt thường,
        // không thành bước Undo.
        const stamped = structuredClone(project.document);
        if (stamp(stamped) > 0) session.commit(stamped, { history: false });
        setReady({ session, media: project.media, manifest: project.manifest });
      } catch (error) {
        if (!cancelled) setFailure((error as Error).message || "Could not open this clip.");
      }
    })();
    return () => {
      cancelled = true;
      session?.dispose();
    };
  }, [clipId]);

  if (failure) {
    return (
      <div className="ed2 ed2-center" role="alert">
        <p>{failure}</p>
        <a className="ed2-link" href={studioItemHref(projectId)}>
          Back to project
        </a>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="ed2 ed2-center" data-testid="editor-loading">
        <p className="ed2-muted">Opening the editor…</p>
      </div>
    );
  }
  return <Workspace projectId={projectId} clipId={clipId} {...ready} />;
}

function Workspace({
  projectId,
  clipId,
  session,
  media: editorMedia,
}: Ready & { projectId: string; clipId: string }) {
  const router = useRouter();
  const { credits, plan, userId, refreshAccount } = useShellAccount();
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  // Đang kéo trên timeline thì canvas và timeline vẽ bản xem trước; thả tay mới commit.
  const [preview, setPreview] = useState<ClipDocument | null>(null);
  // Mỗi lần ghi thật tăng số này: bản xem trước tính xong muộn hơn thì bỏ.
  const previewSeq = useRef(0);
  const doc = preview ?? state.document;
  const [selection, setSelection] = useState<string[]>([]);
  // "Copy style" remembers one element; "Paste style" runs `copy_settings` from it onto the selection.
  const [styleSource, setStyleSource] = useState<string | null>(null);
  const [solo, setSolo] = useState<string | null>(null);
  // Lớp Assistant vừa đổi (học Palmier §A6): nháy trên timeline ~2,5 giây.
  const [flash, setFlash] = useState<string[]>([]);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashLayers = useCallback((ids: string[]) => {
    setFlash(ids);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash([]), 2500);
  }, []);
  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  // Media báo "vừa có thêm khung/ảnh/độ dài" → vẽ lại (và dựng lại renderer nếu cần).
  const [tick, setTick] = useState(0);
  const media = useMemo(
    () => new BrowserMedia(clipId, editorMedia, () => setTick((value) => value + 1)),
    [clipId, editorMedia],
  );
  useEffect(() => () => media.dispose(), [media]);

  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    media.setManifest(state.manifest as Manifest);
    let live = true;
    // The committed document, not the drag preview: a preview only moves or trims what is already
    // loaded, and re-running preload on every pointermove was wasted work.
    void Promise.all([loadFonts(), media.preload(state.document)]).then(() => {
      if (live) setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [media, state.manifest, state.document]);

  // Camera: vừa khung cho tới khi người dùng tự zoom/kéo.
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [camera, setCameraState] = useState<Camera>({ scale: 0.25, x: 0, y: 0 });
  const [guides, setGuides] = useGuides();
  const moved = useRef(false);
  const setCamera = useCallback((next: Camera) => {
    moved.current = true;
    setCameraState(next);
  }, []);

  const frameInfo: Frame | null = useMemo(() => readFrame(doc), [doc]);
  const layoutRanges = useMemo(() => readLayout(doc), [doc]);
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const scale = renderScale(camera, dpr);
  const generation = media.generation;

  const renderer: Renderer | null = useMemo(() => {
    if (!loaded) return null;
    try {
      return createRenderer(doc, media, { scale });
    } catch (error) {
      console.error("[editor] could not build the renderer", error);
      return null;
    }
    // `generation` đổi khi độ dài/transcript về: cây phải dựng lại.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, media, scale, loaded, generation]);

  // A small (≤ 256 px) frame at the playhead for the Adjust tab scopes (E3). Built from the committed
  // document: only the main renderer follows a drag preview, so the scopes catch up on release.
  const sampleRenderer = useMemo(() => {
    if (!loaded || typeof OffscreenCanvas === "undefined") return null;
    try {
      const probe = activeScene(state.document) as unknown as { width: number; height: number };
      return createRenderer(state.document, media, { scale: 256 / Math.max(probe.width, probe.height) });
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.document, media, loaded, generation]);
  const sampleFrame = useCallback(
    (at: number): ImageData | null => {
      if (!sampleRenderer) return null;
      const width = Math.max(1, Math.round(sampleRenderer.scene.width * (256 / Math.max(sampleRenderer.scene.width, sampleRenderer.scene.height))));
      const height = Math.max(1, Math.round(sampleRenderer.scene.height * (256 / Math.max(sampleRenderer.scene.width, sampleRenderer.scene.height))));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      sampleRenderer.render(ctx as never, at);
      return ctx.getImageData(0, 0, width, height);
    },
    [sampleRenderer],
  );

  // Other stage-level scenes (Scene tool), drawn beside the open one at their first frame (or saved
  // playhead); click a scene's name to open it. Built from the committed document so a drag preview
  // doesn't rebuild one renderer per scene on every step.
  const otherScenes = useMemo(() => {
    if (!loaded) return [];
    const committed = state.document;
    const active = activeScene(committed) as unknown as { id?: string; x?: number; y?: number };
    return committed.stage.children
      .filter((node) => node.kind === "scene" && node !== (active as unknown))
      .flatMap((node) => {
        const scene = node as unknown as { id?: string; x?: number; y?: number; playhead?: number; name?: string; width: number; height: number };
        try {
          return [
            {
              key: scene.id ?? "",
              id: scene.id ?? "",
              name: scene.name ?? "Scene",
              width: scene.width,
              height: scene.height,
              renderer: createRenderer(committed, media, { scale, scene: scene.id }),
              frame: Math.round((scene.playhead ?? 0) * 30),
              dx: (scene.x ?? 0) - (active.x ?? 0),
              dy: (scene.y ?? 0) - (active.y ?? 0),
            },
          ];
        } catch {
          return [];
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.document, media, scale, loaded, generation]);

  const sceneWidth = renderer?.scene.width ?? 0;
  const sceneHeight = renderer?.scene.height ?? 0;
  const fit = useCallback(() => {
    if (!sceneWidth || !viewport.width) return;
    moved.current = false;
    setCameraState(fitCamera({ width: sceneWidth, height: sceneHeight }, viewport));
  }, [sceneWidth, sceneHeight, viewport]);
  // Đổi scene đang mở (bấm tên scene, công cụ Scene): khung nhìn đứng yên như
  // fork — camera dời đúng bằng độ lệch góc hai scene, không vừa lại.
  const activeNow = activeScene(doc) as unknown as { id?: string; x?: number; y?: number };
  const lastActive = useRef<{ id?: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const now = { id: activeNow.id, x: activeNow.x ?? 0, y: activeNow.y ?? 0 };
    const before = lastActive.current;
    lastActive.current = now;
    if (!before || before.id === now.id) return;
    moved.current = true;
    setCameraState((current) => ({
      ...current,
      x: current.x + (now.x - before.x) * current.scale,
      y: current.y + (now.y - before.y) * current.scale,
    }));
  }, [activeNow.id, activeNow.x, activeNow.y]);
  useEffect(() => {
    if (!moved.current) fit();
  }, [fit]);
  // Khung CỦA CÙNG scene đổi cỡ (9:16 → 1:1) thì luôn vừa lại, kể cả khi đã zoom
  // tay. Đổi sang scene khác cỡ không phải là khung đổi cỡ.
  const sized = useRef<{ id?: string; width: number; height: number } | null>(null);
  useEffect(() => {
    if (!sceneWidth) return;
    const before = sized.current;
    sized.current = { id: activeNow.id, width: sceneWidth, height: sceneHeight };
    if (before && before.id !== activeNow.id) return;
    moved.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneWidth, sceneHeight]);

  // Playhead + phát.
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const playback = useMemo(() => new Playback(media, setFrame, setPlaying), [media]);
  useEffect(() => () => playback.dispose(), [playback]);
  useEffect(() => {
    playback.renderer = renderer;
    if (renderer) playback.seek(playback.frame);
  }, [playback, renderer]);
  useEffect(() => {
    playback.solo = solo;
  }, [playback, solo]);

  // Op: một lượt sửa = một commit = một bước Undo.
  const [busy, setBusy] = useState(false);
  // Tab của panel Media (Palmier: Media / Index…). Assistant là panel riêng (layout.ts).
  const [leftTab, setLeftTab] = useState<"media" | "transcript" | "upload">("media");
  // `?panel=upload` (old links say `?panel=clips`: the rail, `/app/video`): open the Upload tab,
  // then drop the parameter from the URL.
  const search = useSearchParams();
  const pathname = usePathname();
  useEffect(() => {
    const panel = search.get("panel");
    if (panel !== "upload" && panel !== "clips") return;
    openUpload();
    router.replace(pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, pathname, router]);
  // Slides view (P5 C1): `?view=slides` (New slideshow, Open in Slides) or an edit already made of slides.
  const slides = useMemo(() => readSlides(state.document), [state.document]);
  const [slidesView, setSlidesView] = useState(() => search.get("view") === "slides" || readSlides(session.current).length > 0);
  // The slide picked in the strip, by id: right after `add_slide` the renderer still has the old length, so a seek to
  // the new slide is clamped and the playhead alone would point at the one before it. Playing follows the playhead.
  const [pickedSlide, setPickedSlide] = useState<string | null>(null);
  const currentSlide = slidesView ? ((!playing && slides.find((slide) => slide.id === pickedSlide)) || slideAt(slides, frame / 30)) : null;
  const layout = useEditorLayout();
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // The Upload tab lives in the Media panel: show the panel first if it is hidden.
  const openUpload = () => {
    if (!layoutRef.current.visible.media) layoutRef.current.toggle("media");
    setLeftTab("upload");
  };
  // Assistant đang sửa clip: khoá mềm canvas (CNV-09) — sửa tay giữa chừng sẽ va với bài của nó.
  const [assistantBusy, setAssistantBusy] = useState(false);
  // A request the editor writes into the Assistant's box for the user to finish and send.
  const [assistantPrefill, setAssistantPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const opContext = useCallback(
    (): OpContext => ({
      master: editorMedia.master ? { width: editorMedia.master.width, height: editorMedia.master.height } : null,
      media,
      viewport: viewport.width ? viewport : undefined,
      // Transcript master, bản đã sửa (theo hash) hay file trong thư viện: cùng
      // đường đọc với preview.
      readTranscript: (path) => media.readTranscript(path) as Promise<Transcript>,
      saveTranscript: async (transcript) => {
        const { hash } = await api<{ hash: string }>(
          "/editor/transcript",
          jsonBody({ clip_id: clipId, transcript }),
        );
        return `assets/transcripts/${hash}.json`;
      },
    }),
    [clipId, editorMedia, viewport, media],
  );
  // Edits are queued in the session, never dropped: `busy` only drives the spinner and buttons.
  const running = useRef(0);
  const run = useCallback(
    async (ops: unknown[], options: TransactOptions = {}): Promise<ClipDocument | null> => {
      running.current++;
      setBusy(true);
      setNotice(null);
      // The real write replaces every preview (a canvas drag may end with a different op than it previewed).
      previewSeq.current++;
      setPreview(null);
      try {
        return await session.transact(async (latest) => (await applyOps(latest, ops, opContext())).document, options);
      } catch (error) {
        if (error instanceof DocumentInvalidError) {
          console.error("[editor] op produced an invalid document", ops, error);
          setNotice("This change would break the project, so it was not applied.");
          return null;
        }
        setNotice((error as Error).message || "This change could not be applied.");
        return null;
      } finally {
        running.current--;
        setBusy(running.current > 0);
      }
    },
    [opContext, session],
  );

  const library = useLibrary({
    session,
    manifestState: state.manifest,
    clipId,
    projectId: editorMedia.project_id,
    context: opContext,
    notify: setNotice,
    onLocalBytes: () => media.retryMissing(),
  });
  // Library files transcribe themselves; a ready transcript links to the videos that play the file.
  const transcripts = useAutoTranscripts({ document: state.document, manifest: library.manifest, clipId, run });
  const hasSpeech = useMemo(() => speechSources(state.document).length > 0, [state.document]);
  // Generate (B8): khai báo `generate.*` trong document → file thật trong thư viện.
  const generating = useMemo(() => pendingGenerations(state.document, library.manifest), [state.document, library.manifest]);
  const { retry: retryGeneration } = useGenerations({
    document: state.document,
    library,
    clipId,
    projectId: editorMedia.project_id,
    notify: setNotice,
    onCredits: refreshAccount,
  });
  // Voiceover: giọng về thì gắn độ dài thật + phụ đề của giọng.
  useVoiceovers({ document: state.document, library, run, notify: setNotice });
  useExplainers({ document: state.document, library, run });
  const enabledModels = useEnabledModels();
  const [generateOpen, setGenerateOpen] = useState(false);
  const [backgroundRange, setBackgroundRange] = useState<{ start: number; end: number } | null>(null);
  const [editRange, setEditRange] = useState<{ start: number; end: number } | null>(null);
  // Gieo sẵn ô Generate từ menu chuột phải; `key` mount lại panel để nó nhận giá trị mới.
  const [generateInitial, setGenerateInitial] = useState<{ key: number; kind: "video"; firstFrame?: string; edit?: EditSource } | null>(null);
  const [visualsOpen, setVisualsOpen] = useState(false);
  const generate = async (ops: unknown[]) => {
    const before = new Set<string>();
    walk(session.current, ({ entity }) => typeof entity.id === "string" && before.add(entity.id));
    const after = await run(ops);
    if (!after) return;
    // Select the new elements, not the B-roll row they were placed into: the AI menu (Regenerate,
    // variants) reads the generation off the selected element.
    type Child = { id?: string; children?: Child[] };
    const added = (children: Child[]): string[] =>
      children.flatMap((child) => (isRow(child) ? added(child.children ?? []) : child.id && !before.has(child.id) ? [child.id] : []));
    setSelection(added((activeScene(after) as unknown as Child).children ?? []));
  };
  /** Chèn asset rồi chọn node vừa chèn. */
  const insertAssets = async (records: LibraryRecord[], options: { at?: { x: number; y: number }; start: number }) => {
    let last: string | null = null;
    for (const record of records) last = (await library.insert(record, options)) ?? last;
    if (last) setSelection([last]);
  };
  /**
   * Tool `save_frame` của Assistant: vẽ một frame KHÔNG chữ (AI transition, video nối
   * tiếp — model sinh vẽ lại chữ nó thấy), nhập vào thư mục Frames rồi chờ bản trên
   * Storage để `generate_media` đọc được. Hết giờ chờ vẫn trả đường dẫn, kèm `saved: false`.
   */
  const saveFrame = async (input: { time: number; name?: string }) => {
    const at = playback.frame;
    playback.pause();
    let shot: Awaited<ReturnType<typeof capture>>;
    try {
      shot = await capture(withoutText(session.current), media, { times: [input.time], separate: true, grid: false, edge: 1280 }, (next) =>
        playback.seek(next),
      );
    } finally {
      playback.seek(at);
    }
    const base64 = shot.images?.[0];
    if (!base64) return { error: "The frame could not be drawn." };
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const stem = (input.name ?? `frame-${input.time.toFixed(1)}s`).replace(/[^\w.-]+/g, "-").slice(0, 60);
    const [record] = await library.importFiles([new File([bytes], `${stem}.jpg`, { type: "image/jpeg" })], "Frames");
    if (!record) return { error: "The frame could not be saved to your media." };
    const started = Date.now();
    for (;;) {
      const current = library.latest().assets.find((item) => item.id === record.id) as { path: string; cloud?: { state?: string; mediaId?: string } } | undefined;
      if (current?.cloud?.state === "synced" && current.cloud.mediaId) return { images: [base64], data: { path: current.path, saved: true } };
      if (!current || current.cloud?.state === "failed" || Date.now() - started > 45_000) {
        return { images: [base64], data: { path: current?.path ?? record.path, saved: false } };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
  /** Thứ thả vào: asset kéo từ thư viện, hoặc file kéo từ máy (nhập trước). Đọc NGAY — dataTransfer mất sau await. */
  const dropped = async (event: React.DragEvent): Promise<LibraryRecord[]> => {
    const ids = event.dataTransfer.getData(ASSET_DRAG).split(",").filter(Boolean);
    const fileList = [...event.dataTransfer.files];
    const records = ids
      .map((id) => library.manifest.assets.find((record) => record.id === id))
      .filter((record): record is LibraryRecord => !!record && !isPartial(record));
    if (fileList.length) records.push(...(await library.importFiles(fileList, "")));
    return records;
  };

  // Inspector: mỗi ô ghi bằng op; kéo nhãn số là bản xem trước, thả tay mới commit.
  const edit = useCallback(
    (ops: unknown[], options: { preview?: boolean } = {}) => {
      if (!options.preview) {
        previewSeq.current++;
        setPreview(null);
        void run(ops);
        return;
      }
      const seq = ++previewSeq.current;
      void applyOps(session.current, ops, opContext()).then(
        (applied) => seq === previewSeq.current && setPreview(applied.document),
        () => undefined,
      );
    },
    [opContext, run, session],
  );
  /** Mọi phần tử có id → nó, tên thẻ, và node sở hữu nó (cha của node; node của thành phần phụ). */
  const elements = useMemo(() => {
    type Item = { entity: Record<string, unknown> & { id?: string }; tag: string; owner: (Record<string, unknown> & { id?: string }) | null };
    const map = new Map<string, Item>();
    const holder = new Map<object, object | null>();
    walk(doc, ({ entity, tag, parent }) => {
      holder.set(entity, parent);
      // Node: chủ là cha gần nhất. Thành phần phụ: node gần nhất bao nó.
      let owner = parent;
      while (owner && tag !== (entity.kind as string) && (owner as { kind?: unknown }).kind === undefined) {
        owner = holder.get(owner) as typeof owner;
      }
      if (typeof entity.id === "string") map.set(entity.id, { entity, tag, owner: owner as Item["owner"] });
    });
    return map;
  }, [doc]);
  const times = useMemo(
    () => timesOf(doc, { media }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, media, generation],
  );
  // Phần tử đã chọn biến mất (xoá, Undo) thì bỏ khỏi lựa chọn.
  useEffect(() => {
    if (selection.some((id) => !elements.has(id))) setSelection((current) => current.filter((id) => elements.has(id)));
  }, [elements, selection]);

  const changeFrame = (next: Partial<Frame>) => {
    if (!frameInfo) return;
    const target = { ...frameInfo, ...next };
    if (target.width === frameInfo.width && target.height === frameInfo.height && target.mode === frameInfo.mode) return;
    // Chỉ đổi cỡ: set_project_settings (chạy cả trên timeline không có video chính); đổi Fill/Fit: set_frame.
    if (target.mode === frameInfo.mode) void run([{ op: "set_project_settings", width: target.width, height: target.height }]);
    else void run([{ op: "set_frame", width: target.width, height: target.height, mode: target.mode }]);
  };

  // Công cụ canvas (V H F T R). Space giữ trên canvas mượn tạm Hand.
  const [tool, setTool] = useState<Tool>("move");
  // Menu dự án (B7c): hộp thoại đang mở, ẩn UI / ẩn timeline, menu chuột phải.
  const [dialog, setDialog] = useState<"history" | "style" | "brand" | "shortcuts" | null>(null);
  const [hideUI, setHideUI] = useState(false);
  // Inside the v2 three-column shell (null under the classic shell): the Assistant moves to its column 2.
  const shell = useOptionalShellState();
  const clipAssistantSlot = shell?.clipAssistantSlot ?? null;
  const [hideTimeline, setHideTimeline] = useState(false);
  const [contextAt, setContextAt] = useState<{ x: number; y: number } | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const actions = createActions({
    document: state.document,
    selection,
    setSelection,
    run,
    undo: () => session.undo(),
    redo: () => session.redo(),
    playback,
    renderer,
    split: () => split(),
    exportClip: () => void startExport(),
    camera: {
      zoom: (factor) => zoom(factor),
      actual: () => zoom(1 / camera.scale),
      fit,
      fitBox: (box) => {
        const width = Math.max(1, box.maxX - box.minX);
        const height = Math.max(1, box.maxY - box.minY);
        const next = Math.min(8, (Math.min(viewport.width / width, viewport.height / height) || 1) * 0.8);
        setCamera({
          scale: next,
          x: viewport.width / 2 - ((box.minX + box.maxX) / 2) * next,
          y: viewport.height / 2 - ((box.minY + box.maxY) / 2) * next,
        });
      },
    },
    tool,
    setTool,
    back: () => void back(),
    importFiles: () => importInput.current?.click(),
  });
  const actionsRef = useRef(actions);
  const assistantBusyRef = useRef(assistantBusy);
  assistantBusyRef.current = assistantBusy;
  const assistantClient = useMemo(() => new AssistantClient(clipId, session), [clipId, session]);
  actionsRef.current = actions;

  // Phím tắt (KBD-01…19): một bảng, cùng lệnh với menu. Space: nhấn nhanh là
  // phát/dừng; giữ trên canvas là kéo khung (Stage), nhả mà khung không đổi
  // thì vẫn là phát/dừng — như fork.
  const spaceAt = useRef<{ camera: Camera } | null>(null);
  const cameraNow = useRef(camera);
  cameraNow.current = camera;
  useEffect(() => {
    const overStage = () => !!document.querySelector('[data-testid="editor-stage"]:hover');
    const down = (event: KeyboardEvent) => {
      if (isTyping(event.target) || assistantBusyRef.current) return;
      const arrange = layoutKey(event, layoutRef.current.maximized !== null);
      if (arrange) {
        event.preventDefault();
        if (arrange === "maximize") layoutRef.current.toggleMaximize(layoutRef.current.focused);
        else if (arrange === "restore") layoutRef.current.setMaximized(null);
        else layoutRef.current.setPreset(arrange.preset);
        return;
      }
      if (event.code === "Space" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        if (event.repeat) return;
        if (overStage()) spaceAt.current = { camera: cameraNow.current };
        else playback.toggle();
        return;
      }
      const name = matchShortcut(event);
      if (!name) return;
      event.preventDefault();
      if (event.repeat && !name.startsWith("nudge") && !name.startsWith("frame") && !name.startsWith("second")) return;
      actionsRef.current[name]();
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !spaceAt.current) return;
      const before = spaceAt.current.camera;
      spaceAt.current = null;
      const now = cameraNow.current;
      if (before.x === now.x && before.y === now.y && before.scale === now.scale) playback.toggle();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [playback]);

  // Còn bản chưa lưu thì hỏi trước khi rời trang.
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      const status = session.getState().status;
      if (status !== "saved") event.preventDefault();
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [session]);

  // Mọi lối ra khỏi editor (Back, New project, Buy credits, Account) đều
  // flush trước: autosave có debounce, rời trang ngay thì mất lần sửa cuối.
  const leave = async (href: string) => {
    playback.pause();
    try {
      await session.flush();
    } catch {
      if (!window.confirm("Some changes are not saved. Leave anyway?")) return;
    }
    router.push(href);
  };
  const back = () => leave(studioItemHref(projectId));

  const copyUserId = async () => {
    if (!userId) return;
    try {
      await navigator.clipboard.writeText(userId);
      setNotice("User ID copied.");
    } catch {
      setNotice("Could not copy the user ID.");
    }
  };

  const loadLatest = async () => {
    try {
      const latest = await api<{ version: number; document: ClipDocument; document_hash: string }>(
        `/editor/document?clip_id=${encodeURIComponent(clipId)}`,
      );
      session.adopt(latest.document, latest.version, latest.document_hash);
    } catch (error) {
      setNotice((error as Error).message);
    }
  };

  // Export: lưu → chụp revision → task `render_document` → chờ link tải.
  const [exportState, setExportState] = useState<ExportState>({ phase: "idle" });
  const polling = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (polling.current) clearTimeout(polling.current);
  }, []);
  // Ref chứ không phải state: Ctrl+E và menu File ▸ Export gọi thẳng hàm này,
  // không qua nút đã bị disable, và hai lần bấm trong cùng một render cùng đọc
  // state cũ — mỗi lần là một task render tốn tiền.
  const exportBusy = useRef(false);
  // Task export đang chạy: nút Cancel trên thanh trên (E2-d2) huỷ đúng task này.
  const exportTask = useRef<string | null>(null);
  const cancelExport = async () => {
    const id = exportTask.current;
    if (!id) return;
    await api(`/tasks/${encodeURIComponent(id)}/cancel`, jsonBody({})).catch((error: Error) => setNotice(error.message));
  };
  // `frame`: bản theo khung của nền tảng khác (học Palmier §C4) — server đổi khung trên bản sao.
  const startExport = async (frame?: "4:5" | "1:1" | "16:9") => {
    if (exportBusy.current) return;
    exportBusy.current = true;
    if (polling.current) clearTimeout(polling.current);
    const finish = (state: ExportState) => {
      exportBusy.current = false;
      setExportState(state);
    };
    setExportState({ phase: "preparing" });
    try {
      // The preview leaves a piece that is still generating empty, but the export worker cannot:
      // it would fail after the upload with a library error. Say what to wait for instead.
      if (generating.length) {
        throw new Error(
          `${generating.length} AI ${generating.length === 1 ? "piece is" : "pieces are"} still generating (${generating.map((item) => item.label).join(", ")}). Export when ${generating.length === 1 ? "it is" : "they are"} ready.`,
        );
      }
      await session.flush();
      const hash = session.getState().documentHash;
      if (!hash) throw new Error("Could not save your changes. Try again.");
      const revision = await api<{ id: string }>("/editor/revision", jsonBody({ clip_id: clipId, document_hash: hash, ...(frame ? { frame } : {}) }));
      const started = await api<{ task_id: string; status: string }>(
        `/clips/${encodeURIComponent(clipId)}/exports`,
        jsonBody({ mode: "document", revision_id: revision.id, request_id: crypto.randomUUID() }),
      );
      exportTask.current = started.task_id;
      setExportState({ phase: started.status === "running" ? "running" : "queued" });
      const deadline = Date.now() + EXPORT_WAIT_MS;
      let misses = 0;
      const poll = async () => {
        try {
          const task = await api<RenderTask>(`/tasks/${encodeURIComponent(started.task_id)}`);
          misses = 0;
          if (task.status === "done") {
            // Link về route ký lại mỗi lần bấm: URL ký sẵn chỉ sống 5 phút.
            finish({ phase: "done", url: `/api/v1/tasks/${encodeURIComponent(started.task_id)}/file` });
            refreshAccount();
            return;
          }
          if (task.status === "cancelled") {
            finish({ phase: "idle" });
            setNotice("Export cancelled.");
            return;
          }
          if (task.status === "failed") {
            finish({ phase: "failed", error: task.error ?? "The export failed. Try again." });
            refreshAccount();
            return;
          }
          setExportState(task.status === "running" ? { phase: "running", progress: task.progress } : { phase: "queued" });
        } catch {
          // Mạng chập chờn: đọc lại lượt sau, task vẫn chạy trên server. Lỗi liền
          // nhiều lượt thì nói ra, đừng quay mãi.
          if (++misses >= EXPORT_MAX_MISSES) {
            finish({ phase: "failed", error: "Lost connection while exporting. Check your internet and try again." });
            return;
          }
        }
        if (Date.now() > deadline) {
          finish({
            phase: "failed",
            error: "The export is taking longer than expected. Try again in a few minutes.",
          });
          return;
        }
        polling.current = setTimeout(poll, 2000);
      };
      polling.current = setTimeout(poll, 1000);
    } catch (error) {
      finish({ phase: "failed", error: (error as Error).message || "Could not start the export." });
    }
  };

  // Tách ở playhead: clip đang chọn, không chọn gì thì mọi clip dưới playhead.
  const split = () =>
    void run([
      { op: "split_elements", ...(selection.length ? { element_ids: selection } : {}), at: playback.frame / 30 },
    ]);


  const zoom = (factor: number) =>
    setCamera(zoomAt(camera, factor, viewport.width / 2, viewport.height / 2));

  /** Khung đang xem ra PNG đúng cỡ scene (File ▸ Export ▸ Export current frame as image). */
  const exportFrameImage = async () => {
    try {
      const full = createRenderer(state.document, media);
      // Video đã tua tới khung này cho preview; bản vẽ cỡ thật dùng lại đúng thẻ đó.
      await media.preload(state.document);
      const canvas = document.createElement("canvas");
      canvas.width = full.scene.width;
      canvas.height = full.scene.height;
      full.render(canvas.getContext("2d") as never, playback.frame);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("The frame could not be drawn.");
      download(blob, `${String(full.scene.name ?? "frame").replace(/[^\w.-]+/g, "-")}-${playback.frame}.png`);
    } catch (error) {
      setNotice(`Could not export this frame. ${(error as Error).message}`);
    }
  };
  /** Export ▸ Subtitles (học Palmier §C8): đọc chữ renderer hiện từng frame, tải ở trình duyệt. */
  const exportSubtitles = async (format: "srt" | "vtt") => {
    try {
      await media.preload(state.document);
      const cues = subtitleCues(createRenderer(state.document, media));
      if (!cues.length) throw new Error("This clip has no captions on screen.");
      const body = format === "srt" ? toSrt(cues) : toVtt(cues);
      const scene = activeScene(state.document);
      download(new Blob([body], { type: format === "srt" ? "application/x-subrip" : "text/vtt" }), `${String(scene?.name ?? "captions").replace(/[^\w.-]+/g, "-")}.${format}`);
    } catch (error) {
      setNotice(`Could not export subtitles. ${(error as Error).message}`);
    }
  };
  /** File ▸ Asset ▸ Download all assets: mỗi file một lượt tải. */
  const downloadAssets = async () => {
    const records = library.manifest.assets.filter((record) => !isPartial(record));
    if (!records.length) return setNotice("No assets to download.");
    for (const record of records) {
      const blob = await media.bytesOf(record.path).catch(() => null);
      if (blob) download(blob, record.path.split("/").pop() ?? "asset");
    }
  };
  // A copied style whose element was deleted since cannot be pasted.
  const styleFrom = useMemo(() => {
    if (!styleSource) return null;
    let found = false;
    walk(state.document, ({ entity }) => {
      if (entity.id === styleSource) found = true;
    });
    return found ? styleSource : null;
  }, [state.document, styleSource]);
  /** File ▸ Asset ▸ Remove unused media: record không element nào trỏ tới. */
  const removeUnused = () => {
    const used = new Set<string>();
    walk(state.document, ({ entity }) => {
      if (typeof entity.src === "string") used.add(entity.src);
    });
    const unused = library.manifest.assets.filter(
      (record) => !isPartial(record) && !used.has(record.path) && !used.has((record as { source?: string }).source ?? ""),
    );
    if (!unused.length) return setNotice("No unused media found.");
    if (!window.confirm(`Remove ${unused.length} unused ${unused.length === 1 ? "file" : "files"} from the library?`)) return;
    library.remove(unused.map((record) => record.id));
  };

  const item = (label: string, action: ActionName, testid?: string): MenuItem => ({
    label,
    shortcut: shortcutLabel(action),
    disabled: !actions.enabled(action),
    onSelect: () => actions[action](),
    testid,
  });
  const scenes = state.document.stage.children.filter((node) => node.kind === "scene");
  const activeId = (activeScene(state.document) as unknown as { id?: string }).id;
  // Đúng các mục DS gắn vào menu (checklist §4): File, Edit, View, Tool,
  // Credits, Help, Account; thêm Version history, Apply caption style của
  // OpenCMO. Object/Text/Timeline/Preferences của DS không được mount ở đâu.
  const projectMenu: MenuItem[] = [
    item("Back", "back", "menu-back"),
    { kind: "separator" },
    {
      label: "New project",
      testid: "menu-new-project",
      onSelect: () => void createBlankEdit("9:16").then((id) => leave(`/app/editor/${id}`), (error: Error) => setNotice(error.message)),
    },
    { label: "Upload a video…", onSelect: () => openUpload(), testid: "menu-upload" },
    { kind: "separator" },
    {
      kind: "sub",
      label: "File",
      testid: "menu-file",
      items: [
        item("Import from computer…", "import", "menu-import"),
        {
          kind: "sub",
          label: "Asset",
          items: [
            { label: "Download all assets…", onSelect: () => void downloadAssets() },
            { kind: "separator" },
            { label: "Remove unused media…", onSelect: removeUnused, testid: "menu-remove-unused" },
          ],
        },
        {
          kind: "sub",
          label: "Export",
          testid: "menu-export",
          items: [
            item("Export scene…", "export"),
            { label: "Export current frame as image", onSelect: () => void exportFrameImage(), testid: "menu-export-frame" },
            { kind: "separator" },
            { label: "Export a 1:1 copy (feed)", onSelect: () => void startExport("1:1"), testid: "menu-export-square" },
            { label: "Export a 4:5 copy (feed)", onSelect: () => void startExport("4:5"), testid: "menu-export-portrait" },
            { label: "Export a 16:9 copy (YouTube)", onSelect: () => void startExport("16:9"), testid: "menu-export-wide" },
            { kind: "separator" },
            { label: "Download subtitles (.srt)", onSelect: () => void exportSubtitles("srt"), testid: "menu-export-srt" },
            { label: "Download subtitles (.vtt)", onSelect: () => void exportSubtitles("vtt"), testid: "menu-export-vtt" },
          ],
        },
        {
          kind: "sub",
          label: "Export specific scene",
          items: scenes.map((scene) => ({
            label: scene.name ?? "Scene",
            // Export chạy trên scene đang mở; scene khác phải mở trước.
            disabled: scene.id !== activeId,
            onSelect: () => void startExport(),
          })),
        },
      ],
    },
    {
      kind: "sub",
      label: "Edit",
      testid: "menu-edit",
      items: [
        item("Undo", "undo"),
        item("Redo", "redo"),
        { kind: "separator" },
        item("Copy", "copy"),
        item("Paste", "paste"),
        item("Duplicate", "duplicate", "menu-duplicate"),
        item("Delete", "delete"),
        { kind: "separator" },
        item("Show/Hide", "toggleHidden"),
        { kind: "separator" },
        item("Select all", "selectAll"),
        item("Select parent", "selectParent"),
        item("Select children", "selectChildren"),
        item("Deselect", "deselect"),
      ],
    },
    {
      kind: "sub",
      label: "View",
      items: [
        item("Zoom in", "zoomIn"),
        item("Zoom out", "zoomOut"),
        item("Zoom to 100%", "zoomActual"),
        item("Zoom to fit", "zoomFit"),
        item("Zoom to selection", "zoomSelection"),
        { kind: "separator" },
        { label: layout.visible.agent ? "Hide Assistant" : "Show Assistant", onSelect: () => layout.toggle("agent"), testid: "menu-toggle-agent" },
        { label: layout.visible.media ? "Hide Media panel" : "Show Media panel", onSelect: () => layout.toggle("media"), testid: "menu-toggle-media" },
        { label: layout.visible.inspector ? "Hide Inspector" : "Show Inspector", onSelect: () => layout.toggle("inspector"), testid: "menu-toggle-inspector" },
        { label: layout.maximized ? "Restore panels" : "Maximize focused panel", shortcut: "`", onSelect: () => layout.toggleMaximize(layout.focused), testid: "menu-maximize" },
        {
          kind: "sub",
          label: "Layout",
          testid: "menu-layout",
          items: PRESETS.map((preset) => ({
            label: `${preset.id === layout.preset ? "✓ " : ""}${preset.label}`,
            shortcut: `${shortcutLabel("undo")?.includes("⌘") ? "⌥" : "Alt+"}${preset.key}`,
            onSelect: () => layout.setPreset(preset.id),
            testid: `menu-layout-${preset.id}`,
          })),
        },
        { kind: "separator" },
        { label: "Toggle UI", onSelect: () => setHideUI((value) => !value), testid: "menu-toggle-ui" },
        { label: "Toggle timeline", onSelect: () => setHideTimeline((value) => !value), testid: "menu-toggle-timeline" },
      ],
    },
    {
      kind: "sub",
      label: "Tool",
      items: [item("Scene", "toolScene"), item("Text", "toolText"), item("Rectangle", "toolRect")],
    },
    { kind: "separator" },
    { label: "Version history…", onSelect: () => setDialog("history"), testid: "menu-history" },
    { label: "Apply caption style to all clips…", onSelect: () => setDialog("style"), testid: "menu-apply-style" },
    { label: "Apply brand kit…", onSelect: () => setDialog("brand"), testid: "menu-apply-brand" },
    { kind: "separator" },
    {
      kind: "sub",
      label: "Credits",
      testid: "menu-credits",
      items: [
        // Dòng thông tin, không bấm được — như khối Usage của DS.
        {
          label: credits === null ? "Balance unavailable" : `${credits.toLocaleString("en-US")} credits left`,
          disabled: true,
          onSelect: () => undefined,
          testid: "menu-credits-balance",
        },
        { label: plan ? `Plan: ${plan[0].toUpperCase()}${plan.slice(1)}` : "Plan: Free", disabled: true, onSelect: () => undefined },
        { kind: "separator" },
        { label: "Buy credits", onSelect: () => void leave("/app/billing"), testid: "menu-buy-credits" },
      ],
    },
    {
      kind: "sub",
      label: "Help",
      testid: "menu-help",
      items: [
        { label: "Keyboard shortcuts", onSelect: () => setDialog("shortcuts"), testid: "menu-shortcuts" },
        { label: "Copy user ID", disabled: !userId, onSelect: () => void copyUserId(), testid: "menu-copy-user-id" },
      ],
    },
    { label: "Account", onSelect: () => void leave("/app/settings"), testid: "menu-account" },
  ];
  // Menu chuột phải của cả app, như fork.
  // J/L-cut (E1): chỗ cắt của video chính trong nửa giây quanh đầu phát.
  const playheadClip = playback.frame / 30 - (activeScene(session.current).workarea?.[0] ?? 0);
  const nearCut = cutPoints(session.current).find((point) => Math.abs(point.at - playheadClip) <= 0.5);
  const roll = (seconds: number) => void run([{ op: "set_audio_roll", at: nearCut!.at, seconds }]);
  // AI transition (G1, "Create AI Transition" của Palmier): cùng công thức guide `broll` của
  // Assistant — khung sạch ở T±0,05 s, video first+last, phủ 1,2 s quanh chỗ cắt, `fit` để
  // cả video chạy hết và đáp đúng khung sau, tắt tiếng. Giá nằm trên mục menu.
  const transitionModel = liveModels().find(
    (model) => model.kind === "video" && model.limits.firstFrame && model.limits.lastFrame && enabledModels?.has(model.id),
  );
  const transitionSpec = transitionModel
    ? (() => {
        const scene = activeScene(session.current) as unknown as { width: number; height: number };
        const ratio = scene.width > scene.height ? "16:9" : scene.width < scene.height ? "9:16" : "1:1";
        const ratios = transitionModel.limits.aspectRatios ?? ["16:9"];
        return {
          prompt: TRANSITION_PROMPT,
          aspectRatio: ratios.includes(ratio) ? ratio : ratios[0]!,
          duration: transitionModel.limits.durations?.[0] ?? 5,
        };
      })()
    : null;
  // Extend (G2): khung cuối của clip video → đoạn sinh tiếp bắt đầu đúng khung đó, đặt ngay
  // sau clip. Chạy với mọi model nhận frame đầu (extend gốc của Veo chỉ nhận video Veo vừa sinh,
  // hết hạn sau 2 ngày); chuyển động không liền tuyệt đối như extend gốc.
  const extendVideo = async (plan: ExtendPlan) => {
    const offset = activeScene(session.current).workarea?.[0] ?? 0;
    const end = plan.end - offset;
    setNotice("Saving the last frame of the clip…");
    const shot = await saveFrame({ time: Math.max(0, end - 0.05), name: "extend-from" });
    const frame = "data" in shot ? shot.data : undefined;
    if (!frame?.saved) {
      setNotice("Could not save the last frame of this clip. Check your connection and try again.");
      return;
    }
    setNotice(null);
    await generate([
      {
        op: "add_generated",
        kind: "video",
        model: plan.model.id,
        prompt: plan.prompt,
        seed: Math.floor(Math.random() * 2_147_483_647),
        aspect_ratio: plan.aspectRatio,
        duration: plan.duration,
        start: end,
        ...(plan.muted ? { muted: true } : {}),
        start_frame: frame.path,
      },
    ]);
  };
  const aiTransition = async (at: number) => {
    if (!transitionModel || !transitionSpec) return;
    setNotice("Saving the frames on each side of the cut…");
    const before = await saveFrame({ time: Math.max(0, at - 0.05), name: "before-cut" });
    const after = await saveFrame({ time: at + 0.05, name: "after-cut" });
    const first = "data" in before ? before.data : undefined;
    const last = "data" in after ? after.data : undefined;
    if (!first?.saved || !last?.saved) {
      setNotice("Could not save the frames around this cut. Check your connection and try again.");
      return;
    }
    setNotice(null);
    await generate([
      {
        op: "add_generated",
        kind: "video",
        model: transitionModel.id,
        prompt: transitionSpec.prompt,
        seed: Math.floor(Math.random() * 2_147_483_647),
        aspect_ratio: transitionSpec.aspectRatio,
        duration: transitionSpec.duration,
        start: Math.max(0, at - 0.6),
        length: 1.2,
        fit: true,
        muted: true,
        start_frame: first.path,
        end_frame: last.path,
      },
    ]);
  };
  const aiItems = aiMenuItems({
    document: session.current,
    selection,
    manifest: library.latest(),
    enabled: enabledModels,
    regenerate: (id) => {
      const seed = Math.floor(Math.random() * 2_147_483_647);
      const continuations = continuationsOf(session.current, id, seed).map(({ element_id, after }) => ({ element_id, after }));
      void run([{ op: "regenerate", element_id: id, seed, ...(continuations.length ? { continuations } : {}) }]);
    },
    pickVariant: (id, seed) => void run([{ op: "pick_variant", element_id: id, seed }]),
    replaceBackground: () => {
      const at = Math.round((playback.frame / 30) * 100) / 100;
      setBackgroundRange({ start: at, end: at + 5 });
    },
    editOwnVideo: () => {
      const at = Math.round((playback.frame / 30) * 100) / 100;
      setEditRange({ start: at, end: at + 5 });
    },
    enhance: (id, resolution) => void run([{ op: "enhance_generated", element_id: id, resolution }]),
    animate: (path) => {
      setGenerateInitial((current) => ({ key: (current?.key ?? 0) + 1, kind: "video", firstFrame: path }));
      setGenerateOpen(true);
    },
    extend: (plan) => void extendVideo(plan),
    redoKeyframe: (text) => {
      setAssistantPrefill({ text, nonce: Date.now() });
      if (shell?.clipAssistantSlot) shell.focusChat();
      else if (!layout.visible.agent) layout.toggle("agent");
    },
    editVideo: (edit) => {
      setGenerateInitial((current) => ({ key: (current?.key ?? 0) + 1, kind: "video", edit }));
      setGenerateOpen(true);
    },
    // Upscale (G4): bản nét hơn đè đúng chỗ đoạn gốc, tắt tiếng (tiếng gốc vẫn phát bên dưới).
    upscale: (source, model, resolution) =>
      void generate([
        {
          op: "add_generated",
          kind: "video",
          model: model.id,
          prompt: UPSCALE_PROMPT,
          seed: Math.floor(Math.random() * 2_147_483_647),
          aspect_ratio: (model.limits.aspectRatios ?? []).includes(source.aspect) ? source.aspect : model.limits.aspectRatios?.[0],
          duration: source.seconds,
          resolution,
          source_video: source.path,
          source_start: source.start,
          start: source.at,
          length: source.seconds,
          muted: true,
        },
      ]),
  });
  const contextMenu: MenuItem[] = [
    ...(aiItems.length ? [...aiItems, { kind: "separator" } satisfies MenuItem] : []),
    ...(nearCut
      ? ([
          {
            kind: "sub",
            label: nearCut.roll ? `Shape this cut (${nearCut.roll > 0 ? "L" : "J"}-cut ${Math.abs(nearCut.roll)}s)` : "Shape this cut",
            testid: "cut-shape",
            items: [
              { label: "J-cut: next sound starts 0.5s early", onSelect: () => roll(-0.5), testid: "cut-j" },
              { label: "L-cut: sound carries 0.5s over", onSelect: () => roll(0.5), testid: "cut-l" },
              { label: "Straight cut", disabled: !nearCut.roll, onSelect: () => roll(0), testid: "cut-straight" },
              ...(transitionModel && transitionSpec
                ? ([
                    { kind: "separator" },
                    {
                      label: `AI transition · ${priceOf(transitionModel, transitionSpec as never)} credits`,
                      onSelect: () => void aiTransition(nearCut.at),
                      testid: "cut-ai-transition",
                    },
                  ] satisfies MenuItem[])
                : []),
            ],
          },
          { kind: "separator" },
        ] satisfies MenuItem[])
      : []),
    item("Undo", "undo"),
    item("Redo", "redo"),
    { kind: "separator" },
    item("Cut", "cut"),
    item("Copy", "copy"),
    item("Paste", "paste"),
    { kind: "separator" },
    { label: "Copy style", disabled: selection.length !== 1, onSelect: () => setStyleSource(selection[0] ?? null), testid: "menu-copy-style" },
    {
      label: "Paste style",
      disabled: !styleFrom || !selection.length || selection.every((id) => id === styleFrom),
      onSelect: () => {
        if (!styleFrom) return;
        const targets = selection.filter((id) => id !== styleFrom);
        // `copy_settings` takes 50 targets per op: one batch of ops is still one undo step.
        const ops = Array.from({ length: Math.ceil(targets.length / 50) }, (_, index) => ({ op: "copy_settings", from_id: styleFrom, to_ids: targets.slice(index * 50, index * 50 + 50) }));
        void run(ops);
      },
      testid: "menu-paste-style",
    },
    ...(selection.length >= 2
      ? ([
          {
            kind: "sub",
            label: "Animate one by one",
            testid: "menu-stagger",
            items: (["fade", "slideUp", "pop", "grow"] as const).map((type) => ({
              label: { fade: "Fade in", slideUp: "Slide up", pop: "Pop", grow: "Grow" }[type],
              onSelect: () => void run([{ op: "stagger", element_ids: selection.slice(0, 40), type, step: 0.15 }]),
              testid: `menu-stagger-${type}`,
            })),
          },
        ] satisfies MenuItem[])
      : []),
    { kind: "separator" },
    item("Put on one row", "oneRow", "menu-one-row"),
    item("Select all", "selectAll"),
    { kind: "separator" },
    {
      label: "Fullscreen",
      shortcut: "F11",
      onSelect: () => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => undefined),
    },
    { label: "Reload", shortcut: shortcutLabel("undo")?.includes("⌘") ? "⌘R" : "Ctrl+R", onSelect: () => window.location.reload() },
  ];

  // Bố cục Palmier (layout.ts): mỗi panel một ô lưới, bấm vào là "đang chọn" (phím ` phóng to nó).
  const grid = gridFor(layout, hideTimeline || slidesView);
  const panel = (name: PanelName) => ({
    "data-panel": name,
    "data-focused": layout.focused === name ? "" : undefined,
    "data-maximized": layout.maximized === name ? "" : undefined,
    onPointerDownCapture: () => layout.setFocused(name),
    style: { gridArea: name },
  });
  const splitter = (name: PanelName) => {
    const at = splitterFor(layout.preset, name);
    if (!at || layout.maximized) return null;
    // Vertical chỉ còn Media ở hàng trên: Media lấy hết phần còn lại, kéo không có nghĩa.
    if (layout.preset === "vertical" && name === "media" && !layout.visible.inspector) return null;
    return (
      <Splitter
        edge={at.edge}
        size={layout.sizes[at.key]}
        min={MIN[at.key]}
        onResize={(size, persist) => layout.resize(at.key, size, persist)}
        onReset={() => layout.reset(at.key)}
        label={`Resize ${name}`}
        testid={`split-${name}`}
      />
    );
  };

  const assistant = (
    <AssistantPanel
            client={assistantClient}
            busy={assistantBusy}
            onBusy={(next) => {
              setAssistantBusy(next);
              // Lượt Assistant vừa kết toán: header phải trừ đúng số nó tiêu.
              if (!next) refreshAccount();
            }}
            notify={setNotice}
            onTouched={flashLayers}
            speech={hasSpeech}
            prefill={assistantPrefill}
            runTool={async (request) => {
              const input = (request.input ?? {}) as Record<string, unknown>;
              if (request.name === "media_waveform") {
                return waveform(media, input, "assets/master.mp4", readCaptionState(session.current)?.window ?? null);
              }
              if (request.name === "media_grab") {
                const path = String(input.path ?? "");
                const record = library.manifest.assets.find((item) => item.path === path);
                return grab(media, input as { path: string }, record?.type ?? null);
              }
              if (request.name === "save_frame") return saveFrame(input as { time: number; name?: string });
              if (request.name !== "capture" && request.name !== "inspect_color") return { error: "This editor cannot run that tool." };
              const at = playback.frame;
              playback.pause();
              try {
                if (request.name === "inspect_color") {
                  const playhead = Math.max(0, at / 30 - (activeScene(session.current).workarea?.[0] ?? 0));
                  return await inspectColor(session.current, media, input as InspectColorInput, playhead, (next) => playback.seek(next));
                }
                return await capture(session.current, media, input, (next) => playback.seek(next));
              } finally {
                playback.seek(at);
              }
            }}
            context={{
              // Giây trên timeline BẢN XUẤT (từ đầu vùng làm việc) — cùng thang với `capture`.
              playhead: () => Math.max(0, playback.frame / 30 - (activeScene(session.current).workarea?.[0] ?? 0)),
              selection: () => selection,
              frame: async () => {
                const shot = await capture(session.current, media, {
                  times: [Math.max(0, playback.frame / 30 - (activeScene(session.current).workarea?.[0] ?? 0))],
                  separate: true,
                  // Ảnh người dùng đính kèm: giữ đúng như họ thấy, không kẻ lưới.
                  grid: false,
                }, () => undefined);
                return shot.images?.[0] ?? "";
              },
            }}
          />
  );

  return (
    <div
      className="ed2"
      data-testid="editor-v2"
      data-preset={layout.preset}
      onContextMenu={(event) => {
        if (isTyping(event.target)) return;
        event.preventDefault();
        setContextAt({ x: event.clientX, y: event.clientY });
      }}
    >
      <input
        ref={importInput}
        type="file"
        multiple
        hidden
        accept="video/*,image/*,audio/*,.srt,.vtt,.json"
        onChange={(event) => {
          const chosen = [...(event.target.files ?? [])];
          event.target.value = "";
          if (chosen.length) void library.importFiles(chosen, "");
        }}
      />
      {contextAt ? <ContextMenu at={contextAt} items={contextMenu} onClose={() => setContextAt(null)} /> : null}
      {dialog === "history" ? (
        <HistoryDialog session={session} clipId={clipId} onClose={() => setDialog(null)} notify={setNotice} run={(ops) => run(ops)} />
      ) : null}
      {dialog === "shortcuts" ? <ShortcutsDialog onClose={() => setDialog(null)} /> : null}
      {dialog === "brand" ? (
        <ApplyBrandDialog clipId={clipId} projectId={editorMedia.project_id} onApply={(ops) => run(ops)} onClose={() => setDialog(null)} notify={setNotice} />
      ) : null}
      {dialog === "style" ? (
        <ApplyStyleDialog
          document={state.document}
          clipId={clipId}
          projectId={editorMedia.project_id}
          onClose={() => setDialog(null)}
          notify={setNotice}
        />
      ) : null}
      <TopBar
        menu={
          <DropdownMenu label="Project menu" items={projectMenu} testid="project-menu">
            ☰
          </DropdownMenu>
        }
        credits={credits}
        status={state.status}
        error={state.error}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
        exportState={exportState}
        generating={generating}
        onBack={() => void back()}
        panels={<PanelToggles layout={layout} altLabel={shortcutLabel("undo")?.includes("⌘") ? "⌥" : "Alt+"} />}
        picker={<ClipPicker clipId={clipId} projectId={projectId} onOpen={(href) => void leave(href)} />}
        onUndo={() => session.undo()}
        onRedo={() => session.redo()}
        onRetry={() => void session.flush().catch(() => undefined)}
        onLoadLatest={() => void loadLatest()}
        onExport={() => void startExport()}
        onCancelExport={() => void cancelExport()}
        finish={UI_V2 ? { clipId, documentHash: state.documentHash } : undefined}
      />
      <div className="ed2-body" ref={layout.bodyRef}>
      {/* In the v2 shell the Assistant is column 2 of the frame; here it would be a second chat beside it. */}
      {clipAssistantSlot ? createPortal(<div className="ed2-agent is-shell">{assistant}</div>, clipAssistantSlot) : null}
      <aside
        className="ed2-agent"
        {...panel("agent")}
        style={layout.maximized === "agent" ? undefined : { width: layout.agentWidth }}
        hidden={Boolean(clipAssistantSlot) || hideUI || !layout.visible.agent || (layout.maximized !== null && layout.maximized !== "agent")}
        aria-label="Assistant"
      >
        {layout.maximized ? null : (
          <Splitter
            edge="right"
            size={layout.agentWidth}
            min={MIN.agent}
            onResize={(size, persist) => layout.resize("agent", size, persist)}
            onReset={() => layout.reset("agent")}
            label="Resize Assistant"
            testid="split-agent"
          />
        )}
        {clipAssistantSlot ? null : assistant}
      </aside>
      <div
        className="ed2-area"
        data-testid="editor-area"
        data-max={layout.maximized ?? undefined}
        hidden={layout.maximized === "agent"}
        style={{ gridTemplateAreas: grid.areas, gridTemplateColumns: grid.columns, gridTemplateRows: grid.rows }}
      >
      {/* Hidden, not unmounted: an upload in flight lives in the Upload tab's state. */}
      <section className="ed2-left" {...panel("media")} hidden={hideUI || !layout.visible.media} aria-label={slidesView ? "Slides" : "Media"}>
        {splitter("media")}
        {slidesView ? (
          <SlideStrip
            slides={slides}
            current={currentSlide}
            busy={busy}
            run={run}
            onPick={(slide) => {
              setPickedSlide(slide.id);
              playback.seek(Math.round(slide.start * 30));
            }}
            onTimeline={() => setSlidesView(false)}
          />
        ) : null}
        <div className="ed2-left-tabs" role="tablist" hidden={slidesView}>
          {(["media", "transcript", "upload"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              className="ed2-tab"
              aria-selected={leftTab === tab}
              data-testid={`tab-${tab}`}
              onClick={() => setLeftTab(tab)}
            >
              {tab === "media" ? "Media" : tab === "transcript" ? "Transcript" : "Upload"}
            </button>
          ))}
        </div>
        {slidesView ? null : leftTab === "media" ? (
          <LibraryPanel
            library={library}
            transcriptOf={transcripts.statusOf}
            onInsert={(record) => void insertAssets([record], { start: playback.frame / 30 })}
          />
        ) : leftTab === "transcript" ? (
          <TranscriptPanel
            doc={state.document}
            context={opContext}
            busy={busy}
            run={run}
            onSeek={(seconds) => playback.seek(Math.round(seconds * 30))}
            selection={selection}
          />
        ) : null}
        <UploadPanel
          hidden={slidesView || leftTab !== "upload"}
          frame={sceneWidth && sceneHeight ? frameAspect(sceneWidth, sceneHeight) : "9:16"}
          onOpen={(id) => void leave(`/app/editor/${id}`)}
        />
      </section>
      <main
        className="ed2-main"
        {...panel("preview")}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          // Canvas: tâm của thứ thả nằm đúng chỗ thả (toạ độ scene), bắt đầu ở playhead.
          const box = event.currentTarget.getBoundingClientRect();
          const at = {
            x: (event.clientX - box.left - camera.x) / camera.scale,
            y: (event.clientY - box.top - camera.y) / camera.scale,
          };
          void dropped(event).then((records) => insertAssets(records, { at, start: playback.frame / 30 }));
        }}
      >
        {splitter("preview")}
        <Stage
          renderer={renderer}
          scale={scale}
          frame={frame}
          camera={camera}
          redraw={tick}
          onCamera={setCamera}
          onViewport={setViewport}
          tool={tool}
          others={otherScenes}
          overlay={(spaceHeld) => (
            <>
              <GuidesOverlay guides={guides} camera={camera} width={sceneWidth} height={sceneHeight} />
              <CanvasOverlay
                doc={doc}
                renderer={renderer}
                frame={frame}
                camera={camera}
                tool={tool}
                selection={selection}
                onSelect={setSelection}
                onTool={setTool}
                edit={edit}
                run={run}
                spaceHeld={spaceHeld}
                others={otherScenes}
                pending={(entity) => {
                  // Media sinh ra chưa về: nhãn trên hộp thay vì một ô trống; hỏng thì nói hỏng.
                  const state = aiStateOf(entity, library.manifest, aiLabel(entity));
                  if (!state) return null;
                  return state.state === "error" ? "Generation failed" : state.label;
                }}
              />
            </>
          )}
        />
        {visualsOpen ? (
          <VisualsPanel
            busy={busy}
            playhead={() => Math.max(0, playback.frame / 30 - (activeScene(session.current).workarea?.[0] ?? 0))}
            selected={selectedVisual(session.current, selection)}
            onRun={(ops) => void run(ops)}
            onClose={() => setVisualsOpen(false)}
          />
        ) : null}
        {generateOpen && enabledModels?.size ? (
          <GeneratePanel
            enabled={enabledModels}
            busy={busy}
            playhead={() => Math.max(0, playback.frame / 30 - (activeScene(session.current).workarea?.[0] ?? 0))}
            clipSeconds={(([from, to]) => to - from)(activeScene(session.current).workarea ?? [0, 0])}
            onGenerate={(ops) => void generate(ops)}
            onClose={() => setGenerateOpen(false)}
            images={storedImages(library.latest())}
            key={generateInitial?.key ?? 0}
            initial={generateInitial ?? undefined}
          />
        ) : null}
        {backgroundRange ? (
          <BackgroundPanel
            enabled={enabledModels}
            range={backgroundRange}
            aspect={frameAspect(Number(activeScene(session.current).width), Number(activeScene(session.current).height))}
            busy={busy}
            onApply={(ops) => void generate(ops)}
            onClose={() => setBackgroundRange(null)}
          />
        ) : null}
        {editRange ? (
          <EditVideoPanel
            enabled={enabledModels}
            range={editRange}
            aspect={frameAspect(Number(activeScene(session.current).width), Number(activeScene(session.current).height))}
            busy={busy}
            onApply={(ops) => void generate(ops)}
            onClose={() => setEditRange(null)}
          />
        ) : null}
        <div className="ed2-tools" role="toolbar" aria-label="Tools">
          {slides.length > 0 && !slidesView ? (
            <button type="button" className="ed2-chip" title="Edit slide by slide, timeline hidden" data-testid="tool-slides" onClick={() => setSlidesView(true)}>
              ▤ Slides
            </button>
          ) : null}
          <button
            type="button"
            className="ed2-chip"
            aria-pressed={visualsOpen}
            title="Arrows, diagrams, charts, graphs and 3D"
            data-testid="tool-visuals"
            onClick={() => setVisualsOpen((open) => !open)}
          >
            ◆ Visuals
          </button>
          {enabledModels?.size ? (
            <button
              type="button"
              className="ed2-chip"
              aria-pressed={generateOpen}
              title="Generate media"
              data-testid="tool-generate"
              onClick={() => setGenerateOpen((open) => !open)}
            >
              ✦ Generate
            </button>
          ) : null}
          {(
            [
              ["move", "Move", "V", "↖"],
              ["hand", "Hand", "H", "✋"],
              ["scene", "Scene", "F", "#"],
              ["rect", "Rectangle", "R", "▭"],
              ["text", "Text", "T", "T"],
            ] as const
          ).map(([name, label, key, icon]) => (
            <button
              key={name}
              type="button"
              className="ed2-chip"
              aria-pressed={tool === name}
              title={`${label} (${key})`}
              aria-label={label}
              data-testid={`tool-${name}`}
              onClick={() => setTool(name)}
            >
              {icon}
            </button>
          ))}
        </div>
        <FrameBar
          frame={frameInfo}
          busy={busy}
          onChange={changeFrame}
          layouts={layoutRanges}
          duration={(activeScene(doc).workarea as [number, number] | undefined)?.[1] ?? null}
          playhead={() => Math.max(0, playback.frame / 30 - (activeScene(session.current).workarea?.[0] ?? 0))}
          onLayout={(op) => void run([op])}
          fps={(activeScene(doc) as { fps?: number }).fps ?? 30}
          onSettings={(settings) => void run([{ op: "set_project_settings", ...settings }])}
        />
        <div className="ed2-zoom" role="group" aria-label="Zoom">
          <GuidesMenu guides={guides} onChange={setGuides} />
          <button type="button" className="ed2-icon" aria-label="Zoom out" onClick={() => zoom(1 / 1.25)}>
            −
          </button>
          <span className="ed2-time" data-testid="zoom-level">
            {Math.round(camera.scale * 100)}%
          </span>
          <button type="button" className="ed2-icon" aria-label="Zoom in" onClick={() => zoom(1.25)}>
            +
          </button>
          <button type="button" className="ed2-btn" data-testid="zoom-fit" onClick={fit}>
            Fit
          </button>
        </div>
        {notice ? (
          <div className="ed2-notice" role="alert">
            {notice}
          </div>
        ) : null}
        {!renderer ? <div className="ed2-center ed2-overlay ed2-muted">Loading media…</div> : null}
        {assistantBusy ? (
          <div className="ed2-lock" data-testid="assistant-lock">
            <span>Assistant is editing…</span>
          </div>
        ) : null}
      </main>
      {hideUI || !layout.visible.inspector ? null : slidesView ? (
      <div className="ed2-insp-wrap" {...panel("inspector")}>
      {splitter("inspector")}
      <SlidePanel
        slide={currentSlide}
        images={library.manifest.assets.filter((item) => item.type === "IMAGE").map((item) => ({ path: item.path, name: item.path.split("/").pop() ?? item.path }))}
        busy={busy}
        run={run}
      />
      </div>
      ) : (
      <div className="ed2-insp-wrap" {...panel("inspector")}>
      {splitter("inspector")}
      <Inspector
        doc={doc}
        scene={activeScene(doc) as unknown as Record<string, unknown>}
        selection={selection}
        byId={elements}
        times={times}
        frame={frame}
        edit={edit}
        select={setSelection}
        manifest={library.manifest as unknown as Manifest}
        sample={sampleFrame}
        clipId={clipId}
      />
      </div>
      )}
      {hideTimeline || slidesView ? null : (
      <div className="ed2-tl-wrap" {...panel("timeline")}>
      {splitter("timeline")}
      <Timeline
        doc={doc}
        base={() => session.current}
        media={media}
        generation={generation}
        frame={frame}
        playing={playing}
        onSeek={(next) => playback.seek(next)}
        onToggle={() => playback.toggle()}
        context={opContext}
        run={run}
        onPreview={setPreview}
        selection={selection}
        onSelect={setSelection}
        solo={solo}
        onSolo={setSolo}
        onSplit={split}
        flash={flash}
        aiState={(entity) => aiStateOf(entity, library.manifest, aiLabel(entity))}
        onRetry={(entity) => void retryGeneration(entity)}
        onDropMedia={(event, dropFrame) =>
          // Timeline: bắt đầu đúng chỗ thả, đặt giữa khung.
          void dropped(event).then((records) => insertAssets(records, { start: dropFrame / 30 }))
        }
      />
      <Soundboard doc={doc} renderer={renderer} times={times} frame={frame} playing={playing} media={media} edit={edit} />
      </div>
      )}
      </div>
      </div>
    </div>
  );
}

/**
 * Mục AI của menu chuột phải (G1, học "AI Edit" của Palmier) cho MỘT phần tử đang chọn:
 * - Regenerate: phần tử có nguồn `generate.*`; nhãn mang giá để người dùng thấy trước khi trả.
 * - Animate this image: ảnh đã lên Storage → mở ô Generate tab Video, ảnh làm frame đầu.
 */
function aiMenuItems({
  document,
  selection,
  manifest,
  enabled,
  regenerate,
  pickVariant,
  replaceBackground,
  editOwnVideo,
  enhance,
  animate,
  extend,
  redoKeyframe,
  editVideo,
  upscale,
}: {
  document: ClipDocument;
  selection: string[];
  manifest: Manifest;
  enabled: Set<string> | null;
  regenerate: (id: string) => void;
  pickVariant: (id: string, seed: number) => void;
  replaceBackground: () => void;
  editOwnVideo: () => void;
  enhance: (id: string, resolution: string) => void;
  animate: (path: string) => void;
  extend: (plan: ExtendPlan) => void;
  /** Opens the Assistant with a `redo_keyframe` request for the user to finish. */
  redoKeyframe: (text: string) => void;
  editVideo: (edit: EditSource) => void;
  upscale: (source: EditSource, model: AiModel, resolution: string) => void;
}): MenuItem[] {
  if (selection.length !== 1) return [];
  let entity: Record<string, unknown> | null = null;
  let parent: Record<string, unknown> | null = null;
  walk(document, ({ entity: item, parent: holder }) => {
    if (item.id !== selection[0]) return;
    entity = item;
    parent = holder;
  });
  if (!entity) return [];
  const found: Record<string, unknown> = entity;
  const items: MenuItem[] = [];
  // A long-take shot: its keyframes are redone through the Assistant, which prices the shots on them.
  const scene = parent as Record<string, unknown> | null;
  const keyframes = scene?.kind === "sequence" ? keyframesOf(document, String(scene.id)) : null;
  keyframes?.forEach((keyframe, index) => {
    if (!keyframe.shots.some((shot) => shot.id === found.id)) return;
    items.push({
      label: `Redo keyframe ${index + 1}…`,
      onSelect: () =>
        redoKeyframe(`Redo keyframe ${index + 1} of the scene "${String(scene!.name ?? "Sequence")}" (redo_keyframe, scene_id ${String(scene!.id)}, index ${index}). New look: `),
      testid: `ai-redo-keyframe-${index}`,
    });
  });
  const declarations = ownDeclarations(found);
  // Rendered from code (3D Studio, explainers, motion clips): a new seed would pay for the same picture again.
  if (declarations.length && declarations.every((declaration) => !RENDERED_FROM_CODE.has(String(declaration.model)))) {
    // Giá theo catalog máy chủ (G5); model đã tắt thì không mời sinh lại.
    // Shots continuing this one are made again from its new last frame: same price, counted here.
    const following = continuationsOf(document, String(found.id), 0).map((link) => link.declaration);
    const priced = [...declarations, ...following].map((declaration) => {
      const resolved = resolveGeneration(declaration);
      const model = liveModel(resolved.model);
      return model ? priceOf(model, resolved.spec as never) : null;
    });
    if (priced.every((value) => value !== null)) {
      const price = priced.reduce<number>((sum, value) => sum + value!, 0);
      const chain = following.length ? ` (and the ${following.length === 1 ? "shot" : `${following.length} shots`} after it)` : "";
      items.push({ label: `Regenerate${chain} · ${price} ${price === 1 ? "credit" : "credits"}`, onSelect: () => regenerate(String(found.id)), testid: "ai-regenerate" });
    }
    // Same numbering as the Inspector's Variants row, so "variant 2" means one thing.
    const variants = variantsOf(found);
    variants?.all.forEach((declaration, index) => {
      if (declaration === variants.shown) return;
      items.push({ label: `Show variant ${index + 1}`, onSelect: () => pickVariant(String(found.id), Number(declaration.seed)), testid: `ai-variant-${declaration.seed}` });
    });
    // Nháp → bản đẹp (G4): video AI còn độ phân giải cao hơn để nâng; cùng prompt, seed, frame.
    const video = declarations.find((declaration) => declaration.generate === "video");
    const videoModel = video ? liveModel(String(video.model)) : undefined;
    const ladder = videoModel?.limits.resolutions ?? [];
    const current = ladder.indexOf(String(video?.resolution ?? ladder[0] ?? ""));
    if (video && videoModel && current >= 0) {
      for (const resolution of ladder.slice(current + 1)) {
        const spec = { ...resolveGeneration(video).spec, resolution };
        const cost = priceOf(videoModel, spec as never);
        items.push({ label: `Enhance to ${resolution} · ${cost} credits`, onSelect: () => enhance(String(found.id), resolution), testid: `ai-enhance-${resolution}` });
      }
    }
  }
  const canAnimate = liveModels().some((model) => model.kind === "video" && model.limits.firstFrame && enabled?.has(model.id));
  const path = canAnimate ? imagePathOf(found, manifest) : null;
  if (path && storedImages(manifest).some((image) => image.path === path)) {
    items.push({ label: "Animate this image", onSelect: () => animate(path), testid: "ai-animate" });
  }
  const editModel = liveModels().find((model) => model.limits.sourceVideo && !model.limits.upscale && !model.limits.removeBackground && enabled?.has(model.id));
  const edit = editModel ? videoSourceOf(found, manifest, editModel) : null;
  if (edit) items.push({ label: "Edit with AI…", onSelect: () => editVideo(edit), testid: "ai-edit-video" });
  const upscaleModel = liveModels().find((model) => model.limits.upscale && enabled?.has(model.id));
  const small = upscaleModel ? videoSourceOf(found, manifest, upscaleModel) : null;
  if (upscaleModel && small) {
    for (const resolution of upscaleModel.limits.resolutions ?? []) {
      const price = priceOf(upscaleModel, { prompt: UPSCALE_PROMPT, aspectRatio: small.aspect, duration: small.seconds, resolution } as never);
      items.push({
        label: `Upscale to ${resolution === "2160p" ? "4K" : resolution} · ${price} credits`,
        onSelect: () => upscale(small, upscaleModel, resolution),
        testid: `ai-upscale-${resolution}`,
      });
    }
  }
  // The speaker's own video: cut them out with AI and put a new place behind them.
  if (found.kind === "video" && found.src === MASTER_SRC && liveModels().some((model) => model.limits.removeBackground && enabled?.has(model.id))) {
    items.push({ label: "Replace background…", onSelect: replaceBackground, testid: "ai-replace-background" });
  }
  // The speaker's own video: redraw a range of it with words (`edit_video`).
  if (found.kind === "video" && found.src === MASTER_SRC && liveModels().some((model) => model.limits.clipVideo && enabled?.has(model.id))) {
    items.push({ label: "Edit with AI…", onSelect: editOwnVideo, testid: "ai-edit-own-video" });
  }
  const plan = extendPlanOf(found, document, enabled);
  if (plan) {
    const price = priceOf(plan.model, { prompt: plan.prompt, aspectRatio: plan.aspectRatio, duration: plan.duration } as never);
    items.push({ label: `Extend · ${price} credits`, onSelect: () => extend(plan), testid: "ai-extend" });
  }
  return items;
}

/** Lời cố định của upscale: model không đọc lời, nhưng spec luôn mang `prompt`. */
const UPSCALE_PROMPT = "Upscale";

/**
 * Đoạn video model video-vào-video (G2 sửa, G4 upscale) xử lý được: clip video của thư viện (đã
 * lên Storage), không phải video chính, độ dài trên timeline nằm trong `durations` của model.
 */
function videoSourceOf(entity: Record<string, unknown>, manifest: Manifest, model: AiModel): EditSource | null {
  const allowed = model.limits.durations ?? [];
  if (!allowed.length) return null;
  const paint = ((entity.paints as { type?: string; src?: unknown }[] | undefined) ?? []).find((item) => item.type === "video");
  const src = entity.kind === "video" ? entity.src : paint?.src;
  if (!src || src === "assets/master.mp4" || typeof entity.end !== "number") return null;
  const record = (typeof src === "string"
    ? (manifest?.assets ?? []).find((item) => (item as { path?: string }).path === src)
    : libraryRecord(manifest, src as never)) as { path?: string; type?: string; state?: string; cloud?: { mediaId?: string } } | undefined | null;
  if (!record?.path || record.type !== "VIDEO" || record.state || !record.cloud?.mediaId) return null;
  const at = typeof entity.start === "number" ? entity.start : 0;
  const seconds = Math.round(Math.min(allowed[allowed.length - 1]!, entity.end - at));
  if (!allowed.includes(seconds)) return null;
  const width = Number(entity.width ?? 0);
  const height = Number(entity.height ?? 0);
  return {
    path: record.path,
    name: record.path.split("/").pop() ?? record.path,
    start: typeof entity.sourceIn === "number" ? entity.sourceIn : 0,
    seconds,
    at,
    aspect: width > height ? "16:9" : width < height ? "9:16" : "1:1",
  };
}

type ExtendPlan = { model: AiModel; prompt: string; aspectRatio: string; duration: number; end: number; muted: boolean };

const EXTEND_PROMPT = "Continue this shot naturally from the first frame: the same scene, the same camera direction, no cuts, no text.";

/**
 * Clip video kéo dài được: video người dùng (không phải video chính) hay video AI đã có thời
 * điểm kết thúc. Model: chính model của clip AI nếu nó nhận frame đầu, không thì model video
 * đầu tiên đang bật nhận frame đầu; độ dài ngắn nhất (rẻ nhất).
 */
function extendPlanOf(entity: Record<string, unknown>, document: ClipDocument, enabled: Set<string> | null): ExtendPlan | null {
  const paint = ((entity.paints as { type?: string; src?: unknown }[] | undefined) ?? []).find((item) => item.type === "video");
  const src = entity.kind === "video" ? entity.src : paint?.src;
  if (!src || src === "assets/master.mp4" || typeof entity.end !== "number") return null;
  const declaration = src && typeof src === "object" && (src as { generate?: string }).generate === "video" ? (src as Record<string, unknown>) : null;
  const usable = (model: AiModel | undefined): model is AiModel => !!model && model.kind === "video" && !!model.limits.firstFrame && !!enabled?.has(model.id);
  const own = declaration ? liveModel(String(declaration.model)) : undefined;
  const model = usable(own) ? own : liveModels().find((entry) => usable(entry) && !entry.limits.scene);
  if (!model) return null;
  const scene = activeScene(document) as unknown as { width: number; height: number };
  const sceneRatio = scene.width > scene.height ? "16:9" : scene.width < scene.height ? "9:16" : "1:1";
  const ratios = model.limits.aspectRatios ?? ["16:9"];
  const wanted = typeof declaration?.aspectRatio === "string" ? declaration.aspectRatio : sceneRatio;
  const prompt = declaration ? `${String(declaration.prompt)}\n\n${EXTEND_PROMPT}` : EXTEND_PROMPT;
  return {
    model,
    prompt: prompt.slice(0, model.limits.maxPromptChars),
    aspectRatio: ratios.includes(wanted) ? wanted : ratios[0]!,
    duration: model.limits.durations?.[0] ?? 5,
    end: entity.end,
    muted: entity.muted === true,
  };
}

/** Đường dẫn thư viện của ảnh mà phần tử đang hiện: `image`, paint ảnh, hay ảnh AI đã về. */
function imagePathOf(entity: Record<string, unknown>, manifest: Manifest): string | null {
  const sources: unknown[] = [];
  if (entity.kind === "image") sources.push(entity.src);
  for (const paint of (entity.paints as { type?: string; src?: unknown }[] | undefined) ?? []) if (paint.type === "image") sources.push(paint.src);
  for (const src of sources) {
    if (typeof src === "string") return src;
    if (src && typeof src === "object") {
      const record = libraryRecord(manifest, src as never) as { path?: string } | null;
      if (record?.path) return record.path;
    }
  }
  return null;
}

/** Prompt cố định của AI transition: model chỉ cần nối hai khung, không kể chuyện mới. */
const TRANSITION_PROMPT =
  "One continuous camera move that starts exactly on the first picture and ends exactly on the second picture. Smooth, natural motion, no cuts, no new people or objects, no text.";

/** Models whose layers are rendered from code: no paid Regenerate, a rendering label instead of "Generating…". */
const RENDERED_FROM_CODE: ReadonlySet<string> = new Set([EXPLAINER_MODEL, MOTION_CLIP_MODEL]);

/** The waiting label of an AI layer: explainers and motion clips render, the rest generate. */
function aiLabel(entity: Record<string, unknown>): string {
  const models = ownDeclarations(entity).map((declaration) => declaration.model);
  if (models.includes(EXPLAINER_MODEL)) return "Rendering explainer…";
  return models.includes(MOTION_CLIP_MODEL) ? "Rendering animation…" : "Generating…";
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Visual đang chọn (group có mark `visual`, hoặc một phần tử bên trong nó):
 * bảng Visuals mở ở chế độ sửa.
 */
function selectedVisual(document: ClipDocument, selection: string[]): SelectedVisual | null {
  const id = selection[0];
  if (!id) return null;
  let found: SelectedVisual | null = null;
  walk(document, ({ entity, tag, parent }) => {
    if (found) return;
    const holder = tag === "group" && entity.id === id ? entity : parent && tag !== "group" && entity.id === id ? parent : null;
    const mark = (holder?.marks as { visual?: { op?: string; input?: Record<string, unknown> } } | undefined)?.visual;
    if (holder?.id && mark?.op) found = { id: String(holder.id), op: mark.op, input: mark.input ?? {} };
  });
  return found;
}
