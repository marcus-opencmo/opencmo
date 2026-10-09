"use client";

/**
 * Trang Brand Kit (spec brand-kit BK5): tạo/sửa/xoá kit, đặt mặc định, upload
 * logo, nhập/xuất file `.opencmo-brand.json`, và xem trước.
 *
 * Bản xem trước KHÔNG phải ảnh minh hoạ: nó dựng một document mẫu, chạy đúng op
 * `apply_brand` + `add_chart` của editor-core rồi vẽ bằng `clip-render` — nên
 * clip thật mang kit này trông đúng như ở đây.
 *
 * Logo: đổi mọi định dạng (SVG, JPG, WebP) sang PNG ngay trong trình duyệt rồi
 * upload thẳng vào bucket `brand` (Storage RLS chỉ cho thư mục của mình) — file
 * không đi qua Next.js, và server không bao giờ lưu SVG.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { ClipDocument } from "@opencmo/clip-doc";
import { createRenderer, FONTS, type MediaHost, type Transcript } from "@opencmo/clip-render";
import {
  applyOps,
  BRAND_ASPECTS,
  BRAND_SRC_PREFIX,
  BrandKitSchema,
  brandFrame,
  DEFAULT_BRAND,
  LOGO_CORNERS,
  type BrandKit,
  type OpContext,
} from "@opencmo/editor-core";

import { CaptionStylePicker } from "@/components/brand/CaptionStylePicker";
import { loadFonts } from "@/components/editor/media";
import { createClient } from "@/lib/supabase/client";

import { ApiError, api, jsonBody } from "../api";
import { Skeleton } from "../Skeleton";
import { Notice } from "../ui";
import { useShellAccount } from "./WebShell";

type KitRow = { id: string; name: string; kit: BrandKit; is_default: boolean };
type Draft = { id: string | null; name: string; kit: BrandKit };

const FONT_NAMES = Object.keys(FONTS);
const COLOR_FIELDS: { key: keyof BrandKit["colors"]; label: string; hint: string }[] = [
  { key: "accent", label: "Accent", hint: "Highlights, arrows, the spoken word in captions" },
  { key: "primary", label: "Primary", hint: "Main shapes and 3D objects" },
  { key: "secondary", label: "Secondary", hint: "Second series in charts" },
  { key: "text", label: "Text", hint: "Text on visuals" },
  { key: "background", label: "Background", hint: "Panels behind visuals and 3D scenes" },
];
const EXPORT_FORMAT = "opencmo-brand";
const MAX_LOGO_SIDE = 1024;
const MAX_EMBEDDED_LOGO = 1024 * 1024;

// ------------------------------------------------------------------ xem trước

const SAMPLE: Transcript = [
  {
    text: "Grow your audience in thirty days",
    words: ["Grow", "your", "audience", "in", "thirty", "days"].map((text, index) => ({ text, start: 0.3 + index * 0.35, end: 0.6 + index * 0.35 })),
  },
];
const SAMPLE_SRC = "assets/transcript.json";

function sampleDocument(kit: BrandKit): ClipDocument {
  const { width, height } = brandFrame(kit.layout.aspect);
  return {
    version: 1,
    stage: {
      children: [
        {
          kind: "scene",
          id: "preview",
          width,
          height,
          fill: "#1F2530",
          workarea: [0, 6],
          active: true,
          children: [
            // Nền giả khung người nói: dải tối dần, để thấy chữ và logo nổi lên thế nào trên video.
            { kind: "rect", x: 0, y: 0, width, height, paints: [{ type: "linearGradient", rotation: 90, stops: [{ offset: 0, color: "#3A4250" }, { offset: 1, color: "#11151C" }] }] },
            { kind: "text", text: "The hook goes here", x: width * 0.08, y: height * 0.1, width: width * 0.84, height: height * 0.08, fontFamily: "Inter", fontWeight: 800, fontSize: Math.round(width * 0.075), color: "#FFFFFF", textAlign: "center", textBaseline: "middle", start: 0, end: 6 },
            { kind: "captions", src: SAMPLE_SRC, preset: "classic", verticalAlign: "bottom", start: 0, sourceIn: 0, sourceOut: 6 },
          ],
        },
      ],
    },
  } as unknown as ClipDocument;
}

const PREVIEW_CTX = {
  master: { width: 1920, height: 1080 },
  readTranscript: async () => SAMPLE,
  saveTranscript: async () => "x",
} as unknown as OpContext;

/** Ảnh mà bản xem trước cần: logo đã upload (qua route ký URL). */
function previewHost(images: Map<string, ImageBitmap | "failed">, onLoad: () => void): MediaHost {
  return {
    image(src) {
      if (typeof src !== "string" || !src.startsWith(BRAND_SRC_PREFIX)) return null;
      const found = images.get(src);
      if (found) return found;
      images.set(src, "failed");
      void fetch(`/api/v1/brand-kits/logo?object=${encodeURIComponent(src.slice(BRAND_SRC_PREFIX.length))}`)
        .then((response) => (response.ok ? response.blob() : Promise.reject(new Error("logo"))))
        .then(createImageBitmap)
        .then((bitmap) => {
          images.set(src, bitmap);
          onLoad();
        })
        .catch(() => undefined);
      return null;
    },
    video: () => null,
    duration: () => null,
    transcript: (src) => (src === SAMPLE_SRC ? SAMPLE : null),
  };
}

function BrandPreview({ kit }: { kit: BrandKit }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const images = useRef(new Map<string, ImageBitmap | "failed">());
  const [tick, setTick] = useState(0);
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    void loadFonts().then(() => setFontsReady(true));
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      const { document } = await applyOps(
        sampleDocument(kit),
        [
          { op: "apply_brand", kit, frame: false },
          { op: "add_chart", start: 0, end: 6, type: "bar", title: "Monthly signups", region: { x: 0.08, y: 0.24, width: 0.84, height: 0.3 }, data: [{ label: "Jan", value: 12 }, { label: "Feb", value: 19 }, { label: "Mar", value: 31 }] },
        ],
        PREVIEW_CTX,
      ).catch(() => ({ document: null }));
      const target = canvas.current;
      if (!live || !document || !target) return;
      const scale = 360 / Math.max(document.stage.children[0]!.kind === "scene" ? (document.stage.children[0] as { height: number }).height : 1920, 1);
      const renderer = createRenderer(document, previewHost(images.current, () => setTick((value) => value + 1)), { scale });
      target.width = Math.round(renderer.scene.width! * scale);
      target.height = Math.round(renderer.scene.height! * scale);
      const ctx = target.getContext("2d");
      if (ctx) renderer.render(ctx as never, 60);
    })();
    return () => {
      live = false;
    };
  }, [kit, tick, fontsReady]);

  return <canvas ref={canvas} className="brand-preview" data-testid="brand-preview" aria-label="Preview of a clip with this brand kit" />;
}

// ------------------------------------------------------------------ logo

/** Mọi ảnh (SVG/JPG/WebP/PNG) → PNG ≤ 1024 px cạnh dài, vẽ bằng canvas của trình duyệt. */
async function toPng(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const natural = { width: image.naturalWidth || 512, height: image.naturalHeight || 512 };
    const scale = Math.min(1, MAX_LOGO_SIDE / Math.max(natural.width, natural.height));
    const width = Math.max(16, Math.round(natural.width * scale));
    const height = Math.max(16, Math.round(natural.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("That image could not be read.");
    return { blob, width, height };
  } catch {
    throw new Error("That image could not be read. Try a PNG, JPG, WebP or SVG file.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadLogo(userId: string, blob: Blob): Promise<string> {
  if (blob.size > 2 * 1024 * 1024) throw new Error("Logos must be under 2 MB.");
  const object = `${userId}/logo-${crypto.randomUUID()}.png`;
  const { error } = await createClient().storage.from("brand").upload(object, blob, { contentType: "image/png", upsert: false });
  if (error) throw new Error("The logo could not be uploaded. Please try again.");
  return object;
}

const dataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("read"));
    reader.readAsDataURL(blob);
  });

// ------------------------------------------------------------------ trang

export function BrandView() {
  const { userId } = useShellAccount();
  const [kits, setKits] = useState<KitRow[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);

  const reload = async (select?: string) => {
    const { kits: list } = await api<{ kits: KitRow[] }>("/brand-kits");
    setKits(list);
    const pick = list.find((row) => row.id === select) ?? list.find((row) => row.is_default) ?? list[0];
    setDraft((current) => (select || !current ? (pick ? { id: pick.id, name: pick.name, kit: pick.kit } : null) : current));
  };

  useEffect(() => {
    reload().catch((err) => setError(err instanceof ApiError ? err.message : "Could not load your brand kits."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const valid = useMemo(() => (draft ? BrandKitSchema.safeParse(draft.kit) : null), [draft]);

  // Có thay đổi chưa lưu: so bản nháp với hàng đã lưu. Kit mới (chưa có id) thì
  // luôn là chưa lưu. Dùng để đổi nhãn nút Save và chặn rời trang nhầm.
  const saved = draft?.id ? kits?.find((row) => row.id === draft.id) : undefined;
  const dirty = !!draft && (!saved || saved.name !== draft.name || JSON.stringify(saved.kit) !== JSON.stringify(draft.kit));
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = (change: (kit: BrandKit) => BrandKit) => setDraft((current) => (current ? { ...current, kit: change(current.kit) } : current));

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : `Could not ${label}.`);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run("save the brand kit", async () => {
      if (!draft) return;
      const body = jsonBody({ name: draft.name, kit: draft.kit }, draft.id ? "PUT" : "POST");
      const row = await api<KitRow>(draft.id ? `/brand-kits/${draft.id}` : "/brand-kits", body);
      await reload(row.id);
      setNotice("Saved. New clips will use your default brand kit.");
    });

  const onLogo = (file: File | undefined) =>
    run("upload the logo", async () => {
      if (!file || !userId) return;
      const png = await toPng(file);
      const object = await uploadLogo(userId, png.blob);
      update((kit) => ({ ...kit, logo: { object, width: png.width, height: png.height, corner: kit.logo?.corner ?? "top-right", size: kit.logo?.size ?? 0.18, opacity: kit.logo?.opacity ?? 1 } }));
    });

  const exportKit = () =>
    run("export the brand kit", async () => {
      if (!draft) return;
      let logoData: string | undefined;
      if (draft.kit.logo) {
        const response = await fetch(`/api/v1/brand-kits/logo?object=${encodeURIComponent(draft.kit.logo.object)}`);
        const blob = response.ok ? await response.blob() : null;
        if (blob && blob.size <= MAX_EMBEDDED_LOGO) logoData = await dataUrl(blob);
      }
      const file = new Blob([JSON.stringify({ format: EXPORT_FORMAT, version: 1, name: draft.name, kit: draft.kit, ...(logoData ? { logoData } : {}) }, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(file);
      link.download = `${draft.name.replace(/[^\w.-]+/g, "-").toLowerCase() || "brand"}.opencmo-brand.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });

  const importKit = (file: File | undefined) =>
    run("import the brand kit", async () => {
      if (!file) return;
      if (file.size > 3 * 1024 * 1024) throw new Error("That file is too large to be a brand kit.");
      let parsed: { format?: unknown; name?: unknown; kit?: unknown; logoData?: unknown };
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error("That file is not a brand kit.");
      }
      if (parsed.format !== EXPORT_FORMAT) throw new Error("That file is not an OpenCMO brand kit.");
      const raw = { ...(parsed.kit as Record<string, unknown>) };
      // Logo nhúng: upload lại vào thư mục của người nhập (đường dẫn cũ là của người khác).
      if (typeof parsed.logoData === "string" && parsed.logoData.startsWith("data:image/png;base64,") && raw.logo && userId) {
        // Giải base64 tại chỗ: CSP `connect-src` không mở `data:`, `fetch(dataUrl)` bị chặn.
        const bytes = Uint8Array.from(atob(parsed.logoData.slice("data:image/png;base64,".length)), (char) => char.charCodeAt(0));
        const blob = new Blob([bytes], { type: "image/png" });
        raw.logo = { ...(raw.logo as Record<string, unknown>), object: await uploadLogo(userId, blob) };
      } else {
        raw.logo = null;
      }
      const kit = BrandKitSchema.safeParse(raw);
      if (!kit.success) throw new Error("This brand kit uses settings OpenCMO does not support.");
      const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim().slice(0, 50) : "Imported brand";
      const taken = new Set((kits ?? []).map((row) => row.name.toLowerCase()));
      setDraft({ id: null, name: taken.has(name.toLowerCase()) ? `${name} (imported)` : name, kit: kit.data });
      setNotice("Imported. Review it, then save.");
    });

  if (!kits) {
    return (
      <section className="brand-view">
        <h1 className="brand-title">Brand kit</h1>
        {error ? (
          <Notice>{error}</Notice>
        ) : (
          <div className="brand-loading" aria-label="Loading your brand kits">
            <Skeleton height={36} width={320} radius="var(--ds-radius-pill)" />
            <Skeleton height={320} radius="var(--ds-radius-panel)" />
          </div>
        )}
      </section>
    );
  }

  const swatches = (kit: BrandKit) => [kit.colors.accent, kit.colors.primary, kit.colors.secondary, kit.colors.background];
  const isDefault = !!draft?.id && !!kits.find((row) => row.id === draft.id)?.is_default;

  return (
    <section className="brand-view" data-testid="brand-view">
      <header className="brand-head">
        <h1 className="brand-title">Brand kit</h1>
        <p className="brand-lead">Set your colors, fonts, captions and logo once. New clips, visuals and 3D scenes use your default kit, so they come out on brand.</p>
      </header>
      {error ? <Notice>{error}</Notice> : null}
      {notice ? <p className="brand-notice" role="status">{notice}</p> : null}

      <div className="brand-kits" role="list">
        {kits.map((row) => (
          <button
            key={row.id}
            type="button"
            role="listitem"
            className="brand-kit-chip"
            aria-pressed={draft?.id === row.id}
            data-testid={`brand-kit-${row.name}`}
            onClick={() => {
              setConfirmDelete(false);
              setDraft({ id: row.id, name: row.name, kit: row.kit });
            }}
          >
            <span className="brand-swatches" aria-hidden>
              {swatches(row.kit).map((color, index) => (
                <i key={index} style={{ background: color }} />
              ))}
            </span>
            <span>{row.name}</span>
            {row.is_default ? <em>Default</em> : null}
          </button>
        ))}
        <button type="button" className="brand-kit-new" data-testid="brand-new" onClick={() => setDraft({ id: null, name: kits.length ? "New brand" : "My brand", kit: DEFAULT_BRAND })}>
          + New brand kit
        </button>
        <button type="button" className="text-button" data-testid="brand-import" onClick={() => importInput.current?.click()}>
          Import file
        </button>
        <input ref={importInput} type="file" accept=".json,application/json" hidden data-testid="brand-import-file" onChange={(event) => void importKit(event.target.files?.[0])} />
      </div>

      {draft ? (
        <div className="brand-editor">
          <div className="brand-form">
            <section className="brand-sec">
              <label className="brand-eyebrow" htmlFor="brand-name">
                Name
              </label>
              <input id="brand-name" className="brand-name" value={draft.name} maxLength={60} data-testid="brand-name" onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </section>

            <section className="brand-sec">
              <h2>Colors</h2>
              {COLOR_FIELDS.map((field) => (
                <div key={field.key} className="brand-color">
                  <label className="brand-color-well" style={{ background: draft.kit.colors[field.key] }}>
                    <input type="color" value={draft.kit.colors[field.key]} aria-label={`${field.label} color`} data-testid={`brand-color-${field.key}`} onChange={(event) => update((kit) => ({ ...kit, colors: { ...kit.colors, [field.key]: event.target.value.toUpperCase() } }))} />
                  </label>
                  <span className="brand-color-text">
                    <b>{field.label}</b>
                    <small>{field.hint}</small>
                  </span>
                  <input
                    className="brand-hex"
                    value={draft.kit.colors[field.key]}
                    maxLength={7}
                    aria-label={`${field.label} hex`}
                    onChange={(event) => update((kit) => ({ ...kit, colors: { ...kit.colors, [field.key]: event.target.value } }))}
                  />
                </div>
              ))}
            </section>

            <section className="brand-sec">
              <h2>Fonts</h2>
              <div className="brand-fonts">
                {(["heading", "body"] as const).map((which) => (
                  <label key={which} className="brand-font">
                    <span>{which === "heading" ? "Headings" : "Body"}</span>
                    <select value={draft.kit.fonts[which]} data-testid={`brand-font-${which}`} style={{ fontFamily: draft.kit.fonts[which] }} onChange={(event) => update((kit) => ({ ...kit, fonts: { ...kit.fonts, [which]: event.target.value as BrandKit["fonts"]["heading"] } }))}>
                      {FONT_NAMES.map((name) => (
                        <option key={name} value={name} style={{ fontFamily: name }}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <span className="brand-font-sample" style={{ fontFamily: draft.kit.fonts[which], fontWeight: which === "heading" ? 800 : 500 }}>
                      {which === "heading" ? "The hook goes here" : "Captions and chart labels"}
                    </span>
                  </label>
                ))}
              </div>
            </section>

            <section className="brand-sec">
              <h2>Captions</h2>
              <CaptionStylePicker
                value={draft.kit.captions.preset}
                accent={draft.kit.colors.accent}
                testId="brand-caption-style"
                onChange={(preset) => update((kit) => ({ ...kit, captions: { ...kit.captions, preset } }))}
              />
              <div className="brand-row">
                <div className="brand-inline">
                  Position
                  <Segmented
                    label="Caption position"
                    value={draft.kit.captions.position ?? "bottom"}
                    options={[["top", "Top"], ["center", "Center"], ["bottom", "Bottom"]]}
                    onChange={(position) => update((kit) => ({ ...kit, captions: { ...kit.captions, position } }))}
                  />
                </div>
                <label className="brand-inline brand-grow">
                  Size
                  <input type="range" min={0.5} max={2} step={0.05} value={draft.kit.captions.fontScale ?? 1} onChange={(event) => update((kit) => ({ ...kit, captions: { ...kit.captions, fontScale: Number(event.target.value) } }))} />
                  <span className="brand-num">{Math.round((draft.kit.captions.fontScale ?? 1) * 100)}%</span>
                </label>
              </div>
            </section>

            <section className="brand-sec">
              <h2>Frame</h2>
              <div className="brand-aspects" role="radiogroup" aria-label="Aspect ratio" data-testid="brand-aspect">
                {BRAND_ASPECTS.map((aspect) => {
                  const [w, h] = aspect.split(":").map(Number) as [number, number];
                  const scale = 20 / Math.max(w, h);
                  return (
                    <button key={aspect} type="button" role="radio" aria-checked={draft.kit.layout.aspect === aspect} onClick={() => update((kit) => ({ ...kit, layout: { ...kit.layout, aspect } }))}>
                      <i style={{ width: Math.round(w * scale), height: Math.round(h * scale) }} aria-hidden />
                      {aspect}
                    </button>
                  );
                })}
              </div>
              <div className="brand-inline">
                Speaker
                <Segmented
                  label="Speaker framing"
                  value={draft.kit.layout.fit}
                  options={[["fill", "Fill the frame"], ["fit", "Fit whole video"]]}
                  onChange={(fit) => update((kit) => ({ ...kit, layout: { ...kit.layout, fit } }))}
                />
              </div>
            </section>

            <section className="brand-sec">
              <h2>Logo</h2>
              <div className="brand-logo-row">
                <label className="brand-logo-drop">
                  <span className="brand-logo-thumb" aria-hidden>
                    {draft.kit.logo ? <img src={`/api/v1/brand-kits/logo?object=${encodeURIComponent(draft.kit.logo.object)}`} alt="" /> : "↑"}
                  </span>
                  <span className="brand-logo-text">
                    <b>{draft.kit.logo ? "Replace logo" : "Upload logo"}</b>
                    <small>PNG, JPG, WebP or SVG · converted to PNG, under 2 MB</small>
                  </span>
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden data-testid="brand-logo-file" disabled={busy} onChange={(event) => void onLogo(event.target.files?.[0])} />
                </label>
                {draft.kit.logo ? (
                  <div className="brand-corners" role="radiogroup" aria-label="Logo corner" data-testid="brand-logo-corner">
                    {LOGO_CORNERS.map((corner) => (
                      <button
                        key={corner}
                        type="button"
                        role="radio"
                        aria-checked={draft.kit.logo?.corner === corner}
                        aria-label={corner.replace("-", " ")}
                        data-corner={corner}
                        onClick={() => update((kit) => ({ ...kit, logo: kit.logo && { ...kit.logo, corner: corner as (typeof LOGO_CORNERS)[number] } }))}
                      >
                        <i />
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {draft.kit.logo ? (
                <>
                  <div className="brand-row">
                    <label className="brand-inline brand-grow">
                      Size
                      <input type="range" min={0.05} max={0.4} step={0.01} value={draft.kit.logo.size} onChange={(event) => update((kit) => ({ ...kit, logo: kit.logo && { ...kit.logo, size: Number(event.target.value) } }))} />
                    </label>
                    <label className="brand-inline brand-grow">
                      Opacity
                      <input type="range" min={0.1} max={1} step={0.05} value={draft.kit.logo.opacity} onChange={(event) => update((kit) => ({ ...kit, logo: kit.logo && { ...kit.logo, opacity: Number(event.target.value) } }))} />
                    </label>
                  </div>
                  <button type="button" className="text-button brand-remove" onClick={() => update((kit) => ({ ...kit, logo: null }))}>
                    Remove logo
                  </button>
                </>
              ) : null}
            </section>

            {valid && !valid.success ? <p className="field-error brand-error">{valid.error.issues[0]?.message}</p> : null}
            <div className="brand-actions">
              <button type="button" className="brand-save" disabled={busy || !dirty || !valid?.success || !draft.name.trim()} data-testid="brand-save" onClick={() => void save()}>
                {dirty ? "Save changes" : "Saved"}
              </button>
              {draft.id && !isDefault ? (
                <button
                  type="button"
                  className="brand-ghost"
                  disabled={busy}
                  data-testid="brand-default"
                  onClick={() => void run("set the default", async () => {
                    await api(`/brand-kits/${draft.id}/default`, { method: "POST" });
                    await reload(draft.id!);
                  })}
                >
                  Use for new clips
                </button>
              ) : null}
              <button type="button" className="brand-ghost" disabled={busy} data-testid="brand-export" onClick={() => void exportKit()}>
                Export file
              </button>
              {draft.id ? (
                <button
                  type="button"
                  className="brand-delete"
                  disabled={busy}
                  data-testid="brand-delete"
                  onClick={() => {
                    // Bấm hai lần thay cho window.confirm: hộp thoại trình duyệt
                    // chặn cả trang và trông không thuộc về sản phẩm.
                    if (!confirmDelete) {
                      setConfirmDelete(true);
                      return;
                    }
                    setConfirmDelete(false);
                    void run("delete the brand kit", async () => {
                      await api(`/brand-kits/${draft.id}`, { method: "DELETE" });
                      setDraft(null);
                      await reload();
                    });
                  }}
                  onBlur={() => setConfirmDelete(false)}
                >
                  {confirmDelete ? "Confirm delete" : "Delete"}
                </button>
              ) : null}
            </div>
          </div>
          <aside className="brand-side">
            <div className="brand-side-head">
              <span>Preview</span>
              <small>
                {draft.kit.layout.aspect} · {draft.kit.layout.fit === "fill" ? "Fill" : "Fit"}
              </small>
            </div>
            <div className="brand-stage">
              {valid?.success ? <BrandPreview kit={valid.data} /> : <div className="brand-preview brand-preview-empty">Fix the fields to see a preview.</div>}
            </div>
            <p className="brand-hint">Preview uses the same renderer as your clips. Open a clip and choose Apply brand kit to restyle it.</p>
          </aside>
        </div>
      ) : (
        <p className="brand-empty">Create a brand kit to get started.</p>
      )}
    </section>
  );
}

/** Nút chọn một trong vài giá trị — gọn hơn dropdown khi chỉ có 2–3 lựa chọn. */
function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (value: T) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([option, text]) => (
        <button key={option} type="button" role="radio" aria-checked={value === option} onClick={() => onChange(option)}>
          {text}
        </button>
      ))}
    </div>
  );
}
