"use client";

/**
 * Phụ đề tốn credit (E4-e, học Palmier add_captions + dịch): "Generate captions" trên
 * video thư viện đã lên Storage, "Translate…" trên lớp phụ đề. Giá hiện TRƯỚC khi bấm
 * (1 credit/phút, làm tròn lên — cùng công thức `captions_credits` trong SQL). Kết quả là
 * một lớp `captions` mới qua `insert_captions` (tránh chỗ của phụ đề đang chạy cùng lúc), nên Undo gỡ được như mọi thao tác khác.
 */

import { useState } from "react";

import { captionCredits, captionsNode, mediaOf, sourceRange, TRANSCRIPT_SRC } from "@/lib/editor/captions-source";
import { TRANSLATE_LANGUAGES } from "@/lib/editor/captions-translate";

import { VOICEOVER_MARK, walk, type VoiceoverMark } from "@opencmo/editor-core";

import { generationMatches, libraryRecord } from "../media";
import { Row, Section, SelectField } from "./controls";
import type { Entity, InspectorContext } from "./shared";

export { mediaOf };

const POLL_MS = 1000;


async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = (await response.json().catch(() => ({}))) as T & { detail?: unknown };
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Something went wrong. Please try again.");
  return data;
}

function parentFor(ctx: InspectorContext, parent: Entity | null): string {
  return parent && (parent.kind === "scene" || parent.kind === "group") && typeof parent.id === "string" ? parent.id : String(ctx.scene.id);
}

export function GenerateCaptionsSection({ ctx, parent, clipId }: { ctx: InspectorContext; parent: Entity | null; clipId: string }) {
  const { node } = ctx;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const media = mediaOf(node);
  const record = media && typeof media.src === "string" ? libraryRecord(ctx.manifest, media.src) : null;
  const mediaId = record?.cloud?.state === "synced" ? record.cloud.mediaId : undefined;
  if (!media || !record) return null;
  const range = sourceRange(media.timing, typeof record.duration === "number" ? record.duration : undefined);
  const credits = captionCredits(range.end - range.start);
  const run = async () => {
    if (!mediaId) return;
    setBusy(true);
    setError(null);
    try {
      const request = JSON.stringify({ clip_id: clipId, media_id: mediaId, source_in: range.start, source_out: range.end, request_id: crypto.randomUUID() });
      let task_id = "";
      // File vừa lên Storage còn đang được worker đo độ dài: chờ tối đa ~1 phút rồi mới báo lỗi.
      for (let attempt = 0; !task_id; attempt++) {
        try {
          task_id = (await api<{ task_id: string }>("/api/v1/editor/captions", { method: "POST", body: request })).task_id;
        } catch (failure) {
          if (attempt >= 30 || !(failure instanceof Error) || !/still being processed/.test(failure.message)) throw failure;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const task = await api<{ status: string; error: string | null; output: { src?: string } | null }>(`/api/v1/editor/captions?task=${task_id}`);
        if (task.status === "done" && task.output?.src) {
          await ctx.edit([{ op: "insert_captions", parent_id: parentFor(ctx, parent), node: captionsNode(media.timing, task.output.src, `Captions · ${String(record.path ?? "file").split("/").pop()}`) }]);
          break;
        }
        if (task.status === "failed" || task.status === "cancelled") throw new Error(task.error ?? "Could not create captions. Your credits were refunded.");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Captions" testid="ins-media-captions">
      <button type="button" className="ed2-btn" data-testid="generate-captions" disabled={busy || !mediaId} onClick={() => void run()}>
        {busy ? "Creating captions…" : `Generate captions (${credits} credit${credits === 1 ? "" : "s"})`}
      </button>
      {!mediaId ? <p className="ed2-hint">Captions need the file stored with this project. Wait for it to finish uploading.</p> : null}
      {error ? (
        <p className="ed2-hint" role="alert">
          {error}
        </p>
      ) : null}
    </Section>
  );
}

type VoiceWord = { text: string; start: number; end: number };

/**
 * Phụ đề cho một voiceover (UAT 09/10: voiceover phải thành transcript để làm
 * phụ đề). Miễn phí — mốc từng chữ đã có từ lượt sinh giọng. Lớp phụ đề đang ẩn
 * thì hiện ra; voiceover cũ chưa có lớp thì dựng từ mốc chữ của generation.
 */
export function VoiceoverCaptionsSection({ ctx }: { ctx: InspectorContext }) {
  const { node } = ctx;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mark = (node.marks as Record<string, unknown> | undefined)?.[VOICEOVER_MARK] as VoiceoverMark | undefined;
  if (node.kind !== "audio" || !mark?.key) return null;
  const layers: Entity[] = [];
  walk(ctx.doc, ({ entity, tag }) => {
    const own = (entity.marks as Record<string, unknown> | undefined)?.[VOICEOVER_MARK] as { key?: string } | undefined;
    if (tag === "captions" && own?.key === mark.key) layers.push(entity);
  });
  const shown = layers.some((layer) => !layer.hidden && layer.src);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      let words: VoiceWord[] | undefined;
      if (!layers.some((layer) => layer.src)) {
        const src = node.src as Record<string, unknown> | undefined;
        const record =
          src && typeof src === "object"
            ? (ctx.manifest?.assets ?? []).find((item) => !("state" in item) && generationMatches(src, item))
            : undefined;
        const id = (record?.generation as { id?: string | null } | undefined)?.id;
        if (!id) throw new Error("The voiceover is still being generated. Try again when it plays.");
        const view = await api<{ asset: { words: VoiceWord[] | null } | null }>(`/api/v1/generations/${encodeURIComponent(id)}`);
        words = view.asset?.words ?? undefined;
        if (!words?.length) throw new Error("This voiceover has no word timings, so captions can't be made from it. Generate it again.");
      }
      await ctx.edit([{ op: "caption_voiceover", key: mark.key, ...(words ? { words } : {}) }]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Captions" testid="ins-voiceover-captions">
      {shown ? (
        <p className="ed2-hint">This voiceover has captions. Edit their style by selecting the Voiceover captions layer.</p>
      ) : (
        <button type="button" className="ed2-btn" data-testid="voiceover-captions-create" disabled={busy || !mark.synced} onClick={() => void run()}>
          {busy ? "Adding captions…" : layers.length ? "Show captions" : "Create captions from voiceover"}
        </button>
      )}
      {!mark.synced && !shown ? <p className="ed2-hint">Captions can be added when the voiceover is ready.</p> : null}
      {error ? (
        <p className="ed2-hint" role="alert">
          {error}
        </p>
      ) : null}
    </Section>
  );
}

export function TranslateCaptionsRow({ ctx, parent, clipId }: { ctx: InspectorContext; parent: Entity | null; clipId: string }) {
  const { node } = ctx;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const match = typeof node.src === "string" ? TRANSCRIPT_SRC.exec(node.src) : null;
  // Phụ đề gốc của clip đọc từ artifact (không có hash): sửa một chữ là có bản lưu để dịch.
  if (!match) return null;
  const run = async (language: string) => {
    setBusy(true);
    setError(null);
    try {
      const out = await api<{ src: string }>("/api/v1/editor/captions/translate", {
        method: "POST",
        body: JSON.stringify({ clip_id: clipId, hash: match[1], language }),
      });
      const copy = { ...node } as Record<string, unknown>;
      delete copy.id;
      await ctx.edit([{ op: "insert_captions", parent_id: parentFor(ctx, parent), node: { ...copy, src: out.src, name: `Captions · ${language}` } }]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Row label="Translate">
        <SelectField
          label="Translate captions"
          testid="translate-captions"
          value=""
          options={[{ value: "", label: busy ? "Translating…" : "Choose a language (1 credit/min)" }, ...TRANSLATE_LANGUAGES.map((language) => ({ value: language, label: language }))]}
          onChange={(value) => value && !busy && void run(value)}
        />
      </Row>
      {error ? (
        <p className="ed2-hint" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
