"use client";

/**
 * Ô Generate (checklist OCM-03): viết prompt, chọn loại (ảnh / video / giọng /
 * âm thanh) và tuỳ chọn, thấy giá credit TRƯỚC khi bấm. Chỉ loại và model máy
 * chủ đang bật mới hiện (`/api/v1/generations/models`).
 *
 * Bấm Generate là op `add_generated` (cùng op của Assistant): một phần tử mà
 * nguồn là khai báo `generate.*`, đặt vừa khung clip. `useGenerations` phân
 * giải khai báo đó thành file thật.
 *
 * Tab Voiceover là op `add_voiceover` (spec voiceover §4): thay giọng cả clip
 * (tắt tiếng gốc, phụ đề theo giọng mới) hoặc chèn một đoạn ở playhead (hạ
 * tiếng gốc trong lúc đọc).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { estimateSeconds, WORDS_PER_SECOND } from "@opencmo/editor-core";
import { priceOf, type AiModel, type GenerationKind } from "@opencmo/editor-core/generate";

import { insertMention, mentionAt, resolveMentions } from "./mentions";

type Tab = GenerationKind | "voiceover";

const KINDS: { kind: Tab; label: string }[] = [
  { kind: "image", label: "Image" },
  { kind: "video", label: "Video" },
  { kind: "voice", label: "Voice" },
  { kind: "voiceover", label: "Voiceover" },
  { kind: "audio", label: "Audio" },
];

let enabledModels: Promise<Set<string>> | null = null;
/** Catalog máy chủ trả (G5: giá + giới hạn từ bảng `ai_models`, không phải JSON đóng gói). */
let liveCatalog: AiModel[] | null = null;
/** Model máy chủ đang bật; hỏi một lần mỗi trang. */
export function loadEnabledModels(): Promise<Set<string>> {
  enabledModels ??= fetch("/api/v1/generations/models")
    .then((response) => (response.ok ? (response.json() as Promise<{ models: AiModel[] }>) : { models: [] as AiModel[] }))
    .then((body) => {
      liveCatalog = body.models;
      return new Set(body.models.map((model) => model.id));
    })
    .catch(() => new Set<string>());
  return enabledModels;
}

/**
 * Model đang bật kèm giá/giới hạn của máy chủ (G5) — nguồn cho mọi chỗ HIỆN giá hay lọc model.
 * Rỗng tới khi `loadEnabledModels` xong (mọi chỗ dùng nó cũng chờ `useEnabledModels`).
 */
export const liveModels = (): AiModel[] => liveCatalog ?? [];
export const liveModel = (id: string): AiModel | undefined => liveModels().find((model) => model.id === id);

export function useEnabledModels(): Set<string> | null {
  const [enabled, setEnabled] = useState<Set<string> | null>(null);
  useEffect(() => {
    void loadEnabledModels().then(setEnabled);
  }, []);
  return enabled;
}

const randomSeed = () => Math.floor(Math.random() * 1_000_000);

/** Mức nhạc nền dưới giọng nói: đủ nghe, không lấn lời. */
const BED_DB = -18;

/** Đoạn video được sửa (menu "Edit with AI"): đường dẫn thư viện, giây trong file, độ dài, chỗ đặt. */
export type EditSource = { path: string; name: string; start: number; seconds: number; at: number; aspect: string };

/**
 * Giọng so với chỗ trống trên clip, trước khi trả tiền. Kịch bản không đo được
 * bằng mắt: dài quá thì đuôi giọng bị cắt ở cuối clip (export theo `workarea`),
 * ngắn quá thì đuôi clip im lặng vì tiếng gốc đã tắt. Ước theo cùng tốc độ với
 * op, nên con số này cũng là độ dài trên timeline trước khi giọng về.
 */
function scriptFit(script: string, room: number, mode: "replace" | "overlay"): { text: string; warn: boolean } | null {
  if (!script.trim() || room <= 0) return null;
  const voice = estimateSeconds(script);
  const words = (seconds: number) => Math.max(1, Math.round(seconds * WORDS_PER_SECOND));
  const base = `About ${Math.round(voice)}s of voice for ${mode === "replace" ? "a" : "the"} ${Math.round(room)}s ${mode === "replace" ? "clip" : "left after the playhead"}`;
  if (voice > room + 1) return { text: `${base}. The end will be cut — remove about ${words(voice - room)} words.`, warn: true };
  if (mode === "replace" && voice < room * 0.9) {
    return { text: `${base}. The last ${Math.round(room - voice)}s will be silent — add about ${words(room - voice)} words.`, warn: true };
  }
  return { text: `${base}.`, warn: false };
}

/**
 * Ảnh trong thư viện đã có bản trên Storage (`cloud.mediaId`): ảnh AI đã xong hoặc ảnh
 * người dùng upload — thứ dùng được làm frame đầu/cuối hay tham chiếu (server cần tên
 * object; ảnh chỉ nằm ở OPFS thì chưa có).
 */
export function storedImages(manifest: { assets?: unknown[] } | null): { path: string; name: string }[] {
  return ((manifest?.assets ?? []) as { path?: string; type?: string; state?: string; generation?: unknown; cloud?: { mediaId?: string } }[])
    .filter((record) => record.type === "IMAGE" && !record.state && record.cloud?.mediaId && record.path)
    .map((record) => ({ path: record.path!, name: record.path!.split("/").pop() ?? record.path! }));
}

export function GeneratePanel({
  enabled,
  busy,
  playhead,
  clipSeconds,
  onGenerate,
  onClose,
  images = [],
  initial,
}: {
  enabled: Set<string>;
  busy: boolean;
  /** Giây CLIP của playhead: chỗ chèn voiceover `overlay`. */
  playhead: () => number;
  /** Độ dài clip (workarea) tính bằng giây: chỗ trống cho voiceover. */
  clipSeconds: number;
  onGenerate: (ops: unknown[]) => void;
  onClose: () => void;
  /** Ảnh dùng được làm frame đầu/cuối hay tham chiếu (`storedImages`). */
  images?: { path: string; name: string }[];
  /** Gieo sẵn (menu chuột phải "Animate this image"): tab + frame đầu; người dùng vẫn tự bấm Generate. */
  initial?: { kind: Tab; firstFrame?: string; edit?: EditSource };
}) {
  // Model 3D Studio cần dữ liệu cảnh, không phải prompt: nó ở tab 3D Studio của bảng Visuals.
  // Model sửa video chỉ mở từ menu "Edit with AI" (cần video nguồn); khi đó CHỈ hiện chúng.
  const editing = initial?.edit;
  const models = useMemo(
    () => liveModels().filter((model) => enabled.has(model.id) && !model.limits.scene && !model.limits.upscale && !model.limits.sourceVideo === !editing),
    [enabled, editing],
  );
  const kinds = KINDS.filter((entry) => models.some((model) => model.kind === (entry.kind === "voiceover" ? "voice" : entry.kind)));
  const [tab, setTab] = useState<Tab>(initial && kinds.some((entry) => entry.kind === initial.kind) ? initial.kind : (kinds[0]?.kind ?? "image"));
  const voiceover = tab === "voiceover";
  const kind: GenerationKind = voiceover ? "voice" : tab;
  const ofKind = models.filter((model) => model.kind === kind);
  // Gieo frame đầu thì chọn sẵn model nhận frame đầu (model đầu danh sách có thể không nhận).
  const [modelId, setModelId] = useState<string>(
    () => (initial?.firstFrame ? models.find((entry) => entry.kind === "video" && entry.limits.firstFrame)?.id : undefined) ?? "",
  );
  const model: AiModel | undefined = ofKind.find((entry) => entry.id === modelId) ?? ofKind[0];
  const voices = models.filter((entry) => entry.kind === "voice").flatMap((entry) => (entry.limits.voices ?? []).map((voice) => ({ voice, model: entry })));
  const [voice, setVoice] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<string>("16:9");
  const [duration, setDuration] = useState<number>(5);
  const [count, setCount] = useState(1);
  const [mode, setMode] = useState<"replace" | "overlay">("replace");
  const [captions, setCaptions] = useState<boolean | null>(null);
  const [duck, setDuck] = useState(-18);
  const [resolution, setResolution] = useState<string>("");
  const [firstFrame, setFirstFrame] = useState<string>(initial?.firstFrame ?? "");
  const [lastFrame, setLastFrame] = useState<string>("");
  const [refs, setRefs] = useState<string[]>([]);
  // Nhạc/SFX nền cho cả clip (G3): dài bằng clip trong giới hạn của model, đặt từ giây 0, −18 dB.
  const [bed, setBed] = useState(false);
  // `@Image1` (G2): đang gõ một thẻ thì hiện danh sách ảnh; lỗi thẻ hiện dưới prompt.
  const promptBox = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionError, setMentionError] = useState<string | null>(null);
  // Mặc định có phụ đề cả khi overlay (UAT 09/10); bỏ tick thì lớp phụ đề nằm ẩn, bật lại được.
  const withCaptions = captions ?? true;

  const chosenVoice = voices.find((entry) => entry.voice === voice) ?? voices[0];
  const active = kind === "voice" ? chosenVoice?.model : model;
  const aspects = active?.limits.aspectRatios ?? [];
  const durations =
    kind === "video"
      ? (active?.limits.durations ?? [5])
      : kind === "audio"
        ? Array.from({ length: (active?.limits.maxSeconds ?? 22) - (active?.limits.minSeconds ?? 1) + 1 }, (_, index) => index + (active?.limits.minSeconds ?? 1))
        : [];
  // Sửa video: khung và độ dài là của đoạn nguồn, không chọn.
  const aspectValue = editing && aspects.includes(editing.aspect) ? editing.aspect : aspects.includes(aspect) ? aspect : (aspects[0] ?? "16:9");
  const bedOn = kind === "audio" && bed && durations.length > 0;
  const bedSeconds = bedOn ? Math.min(durations[durations.length - 1]!, Math.max(durations[0]!, Math.round(clipSeconds))) : 0;
  const durationValue = editing
    ? editing.seconds
    : bedOn
      ? bedSeconds
      : durations.includes(duration)
        ? duration
        : durations.includes(5)
          ? 5
          : (durations[0] ?? 5);
  const copies = kind === "image" ? count : 1;
  // Khả năng theo model (plan Palmier P1): chỉ hiện ô model thật sự nhận.
  const resolutions = kind === "image" || kind === "video" ? (active?.limits.resolutions ?? []) : [];
  const resolutionValue = resolutions.includes(resolution) ? resolution : resolutions[0];
  const canFirst = kind === "video" && !!active?.limits.firstFrame && images.length > 0;
  const canLast = kind === "video" && !!active?.limits.lastFrame && images.length > 0;
  const maxRefs = kind === "image" || kind === "video" ? (active?.limits.maxReferences ?? 0) : 0;
  const firstValue = canFirst && images.some((image) => image.path === firstFrame) ? firstFrame : "";
  const lastValue = canLast && images.some((image) => image.path === lastFrame) ? lastFrame : "";
  const refsValue = maxRefs > 0 ? refs.filter((path) => images.some((image) => image.path === path)).slice(0, maxRefs) : [];
  const spec = {
    prompt: prompt.trim() || " ",
    ...(kind === "image" || kind === "video" ? { aspectRatio: aspectValue } : {}),
    ...(kind === "video" || kind === "audio" ? { duration: durationValue } : {}),
    ...(kind === "voice" ? { voice: chosenVoice?.voice } : {}),
    ...(resolutionValue ? { resolution: resolutionValue } : {}),
  };
  const price = active ? priceOf(active, spec) * copies : null;
  const tooLong = !!active && prompt.trim().length > active.limits.maxPromptChars;
  const fit = voiceover ? scriptFit(prompt, mode === "replace" ? clipSeconds : clipSeconds - playhead(), mode) : null;

  const mentionOptions =
    mention && maxRefs > 0
      ? images.filter((image) => image.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6)
      : [];
  const chooseMention = (path: string) => {
    if (!mention) return;
    const next = refsValue.includes(path) ? refsValue : refsValue.length < maxRefs ? [...refsValue, path] : null;
    if (!next) {
      setMentionError(`${active?.name ?? "This model"} takes up to ${maxRefs} reference images.`);
      return;
    }
    setRefs(next);
    const caret = promptBox.current?.selectionStart ?? prompt.length;
    const inserted = insertMention(prompt, mention, caret, next.indexOf(path) + 1);
    setPrompt(inserted.text);
    setMention(null);
    setMentionError(null);
    requestAnimationFrame(() => {
      promptBox.current?.focus();
      promptBox.current?.setSelectionRange(inserted.caret, inserted.caret);
    });
  };

  const submit = () => {
    if (!active || !prompt.trim() || tooLong || busy) return;
    let text = prompt.trim();
    if (kind === "image" || kind === "video") {
      const resolved = resolveMentions(text, refsValue.length);
      if ("error" in resolved) {
        setMentionError(resolved.error);
        return;
      }
      text = resolved.prompt;
    }
    if (voiceover) {
      onGenerate([
        {
          op: "add_voiceover",
          text: prompt.trim(),
          voice: chosenVoice?.voice,
          mode,
          ...(mode === "overlay" ? { start: Math.round(playhead() * 100) / 100, duck_db: duck } : {}),
          captions: withCaptions,
          seed: randomSeed(),
        },
      ]);
      setPrompt("");
      onClose();
      return;
    }
    const ops = Array.from({ length: copies }, () => ({
      op: "add_generated",
      kind,
      model: active.id,
      prompt: text,
      seed: randomSeed(),
      ...(kind === "image" || kind === "video" ? { aspect_ratio: aspectValue } : {}),
      ...(kind === "video" || kind === "audio" ? { duration: durationValue } : {}),
      ...(kind === "voice" ? { voice: chosenVoice?.voice } : {}),
      ...(resolutionValue ? { resolution: resolutionValue } : {}),
      ...(firstValue ? { start_frame: firstValue } : {}),
      ...(lastValue ? { end_frame: lastValue } : {}),
      ...(refsValue.length ? { refs: refsValue } : {}),
      // Kết quả đè đúng chỗ đoạn được sửa, tắt tiếng: tiếng gốc vẫn phát từ clip bên dưới.
      ...(editing ? { source_video: editing.path, source_start: editing.start, start: editing.at, length: editing.seconds, muted: true } : {}),
      ...(bedOn ? { start: 0, volume: BED_DB } : {}),
    }));
    onGenerate(ops);
    setPrompt("");
    onClose();
  };

  return (
    <div className="ed2-gen" data-testid="generate-panel" onPointerDown={(event) => event.stopPropagation()}>
      {editing ? (
        <p className="ed2-muted" data-testid="generate-edit-source">
          Editing {editing.name} · {editing.seconds}s. Describe what to change; the motion and camera stay.
        </p>
      ) : null}
      <div className="ed2-row" hidden={!!editing}>
        {kinds.map((entry) => (
          <button
            key={entry.kind}
            type="button"
            className="ed2-chip"
            aria-pressed={tab === entry.kind}
            data-testid={`generate-kind-${entry.kind}`}
            onClick={() => setTab(entry.kind)}
          >
            {entry.label}
          </button>
        ))}
        <span className="ed2-grow" />
        <button type="button" className="ed2-icon" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <textarea
        className="ed2-asst-input"
        autoFocus
        placeholder={
          voiceover
            ? `Write the new script. About ${WORDS_PER_SECOND} words per second of clip.`
            : kind === "voice"
              ? "What should the voice say?"
              : `Describe the ${kind} to generate`
        }
        aria-label="Prompt"
        data-testid="generate-prompt"
        ref={promptBox}
        value={prompt}
        onChange={(event) => {
          setPrompt(event.target.value);
          setMentionError(null);
          setMention(maxRefs > 0 && images.length ? mentionAt(event.target.value, event.target.selectionStart) : null);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (mention && mentionOptions.length && (event.key === "Enter" || event.key === "Tab")) {
            event.preventDefault();
            chooseMention(mentionOptions[0]!.path);
            return;
          }
          if (mention && event.key === "Escape") {
            setMention(null);
            return;
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
          if (event.key === "Escape") onClose();
        }}
      />
      {mentionOptions.length ? (
        <ul className="ed2-gen-mentions" role="listbox" aria-label="Reference images" data-testid="generate-mentions">
          {mentionOptions.map((image) => (
            <li key={image.path}>
              <button type="button" role="option" aria-selected={false} data-testid="generate-mention-option" onClick={() => chooseMention(image.path)}>
                {refsValue.includes(image.path) ? `Image ${refsValue.indexOf(image.path) + 1} · ` : ""}
                {image.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {mentionError ? (
        <p className="ed2-warn" role="alert" data-testid="generate-mention-error">
          {mentionError}
        </p>
      ) : null}
      <div className="ed2-row ed2-wrap">
        {kind === "voice" ? (
          <select className="ed2-select" aria-label="Voice" value={chosenVoice?.voice ?? ""} onChange={(event) => setVoice(event.target.value)}>
            {voices.map((entry) => (
              <option key={entry.voice} value={entry.voice}>
                {entry.voice}
              </option>
            ))}
          </select>
        ) : (
          <select className="ed2-select" aria-label="Model" value={model?.id ?? ""} onChange={(event) => setModelId(event.target.value)}>
            {ofKind.map((entry) => (
              <option key={entry.id} value={entry.id} title={entry.description}>
                {entry.name}
              </option>
            ))}
          </select>
        )}
        {!editing && aspects.length && (kind === "image" || kind === "video") ? (
          <select className="ed2-select" aria-label="Aspect ratio" value={aspectValue} onChange={(event) => setAspect(event.target.value)}>
            {aspects.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        ) : null}
        {!editing && !bedOn && durations.length ? (
          <select className="ed2-select" aria-label="Duration" value={durationValue} onChange={(event) => setDuration(Number(event.target.value))}>
            {durations.map((value) => (
              <option key={value} value={value}>
                {value}s
              </option>
            ))}
          </select>
        ) : null}
        {voiceover ? (
          <>
            <select className="ed2-select" aria-label="Voiceover mode" data-testid="voiceover-mode" value={mode} onChange={(event) => setMode(event.target.value as "replace" | "overlay")}>
              <option value="replace">Replace the voice</option>
              <option value="overlay">Insert at playhead</option>
            </select>
            {mode === "overlay" ? (
              <select className="ed2-select" aria-label="Lower original audio" value={duck} onChange={(event) => setDuck(Number(event.target.value))}>
                {[-6, -12, -18, -24, -40].map((value) => (
                  <option key={value} value={value}>
                    Original {value} dB
                  </option>
                ))}
              </select>
            ) : null}
            <label className="ed2-muted">
              <input type="checkbox" checked={withCaptions} data-testid="voiceover-captions" onChange={(event) => setCaptions(event.target.checked)} /> Captions
            </label>
          </>
        ) : null}
        {resolutions.length ? (
          <select className="ed2-select" aria-label="Resolution" data-testid="generate-resolution" value={resolutionValue} onChange={(event) => setResolution(event.target.value)}>
            {resolutions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        ) : null}
        {canFirst ? (
          <select className="ed2-select" aria-label="First frame" data-testid="generate-first-frame" value={firstValue} onChange={(event) => setFirstFrame(event.target.value)}>
            <option value="">No first frame</option>
            {images.map((image) => (
              <option key={image.path} value={image.path}>
                Start on {image.name}
              </option>
            ))}
          </select>
        ) : null}
        {canLast ? (
          <select className="ed2-select" aria-label="Last frame" data-testid="generate-last-frame" value={lastValue} onChange={(event) => setLastFrame(event.target.value)}>
            <option value="">No last frame</option>
            {images.map((image) => (
              <option key={image.path} value={image.path}>
                End on {image.name}
              </option>
            ))}
          </select>
        ) : null}
        {kind === "image" ? (
          <select className="ed2-select" aria-label="Variants" value={count} onChange={(event) => setCount(Number(event.target.value))}>
            {[1, 2, 3, 4].map((value) => (
              <option key={value} value={value}>
                ×{value}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {kind === "audio" && clipSeconds > 0 ? (
        <label className="ed2-muted" data-testid="generate-bed">
          <input type="checkbox" checked={bed} onChange={(event) => setBed(event.target.checked)} /> Background for the whole clip, at {BED_DB} dB
          {bedOn && bedSeconds < Math.round(clipSeconds) ? ` (covers the first ${bedSeconds}s)` : ""}
        </label>
      ) : null}
      {maxRefs > 0 && images.length ? (
        <fieldset className="ed2-gen-refs" data-testid="generate-refs">
          <legend className="ed2-muted">Reference images (up to {maxRefs}) · type @ to name them in the prompt</legend>
          {images.map((image) => (
            <label key={image.path} className="ed2-muted">
              <input
                type="checkbox"
                checked={refsValue.includes(image.path)}
                disabled={!refsValue.includes(image.path) && refsValue.length >= maxRefs}
                onChange={(event) => setRefs((all) => (event.target.checked ? [...all, image.path] : all.filter((path) => path !== image.path)))}
              />{" "}
              {refsValue.includes(image.path) ? `Image ${refsValue.indexOf(image.path) + 1} · ` : ""}
              {image.name}
            </label>
          ))}
        </fieldset>
      ) : null}
      {voiceover && fit ? (
        <p className={fit.warn ? "ed2-warn" : "ed2-muted"} data-testid="voiceover-fit">
          {fit.text}
        </p>
      ) : null}
      {voiceover ? (
        <p className="ed2-muted" data-testid="voiceover-hint">
          {mode === "replace"
            ? "Mutes the original speech and hides its captions. Remove the voiceover to bring them back."
            : "Plays over the clip and lowers the original audio while it speaks."}
        </p>
      ) : null}
      <div className="ed2-row">
        {tooLong ? <span className="ed2-error">Keep the prompt under {active?.limits.maxPromptChars} characters.</span> : null}
        <span className="ed2-grow" />
        <span className="ed2-muted" data-testid="generate-price">
          {price === null ? "" : `${price} ${price === 1 ? "credit" : "credits"}`}
        </span>
        <button type="button" className="ed2-btn ed2-primary" data-testid="generate-submit" disabled={!prompt.trim() || tooLong || busy || !active} onClick={submit}>
          Generate
        </button>
      </div>
    </div>
  );
}
