"use client";

/**
 * Phân giải khai báo `generate.*` trong document thành asset thật (spec AI
 * Studio §7.5, editor-rewrite B8) — việc `OpenCmoAi` làm trong fork:
 *
 * - Mỗi khai báo chưa có record khớp: đặt một record "partial" `pending` trong
 *   thư viện (dưới `generated/`), gọi `POST /api/v1/generations`, hỏi lại tới
 *   khi xong. Cùng spec trong cùng project thì server trả lại lượt đã có — nên
 *   mở lại tab giữa chừng là tiếp tục đúng lượt đó, không trừ credit lần hai.
 * - Xong: tải file về OPFS, record thật thế chỗ partial (cùng đường dẫn), có
 *   `generation.key` (để worker và preview khớp khai báo) và `cloud.mediaId`.
 * - Hỏng: partial thành `error` với câu của server; không tự chạy lại.
 * - Người dùng xoá partial đang chạy = huỷ: gọi huỷ để credit được hoàn.
 *
 * Khoá (`generation.key`) cùng dạng với fork: `{type, model, spec}` đã chuẩn
 * hoá, cùng thứ tự field — nên cùng một khai báo khớp cùng một record ở cả
 * hai editor.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { isPartial, joinPath, uniquePath, type LibraryRecord, type Manifest, type PartialRecord } from "@opencmo/clip-assets";
import type { ClipDocument } from "@opencmo/clip-doc";
import { AI_MODELS } from "@opencmo/editor-core/generate";

import { createClient } from "@/lib/supabase/client";

import { generationMatches, libraryRecord } from "../media";
import type { LibraryApi } from "../library/useLibrary";
import { describe, keepLocal } from "../library/store";

const GENERATED_DIR = "generated";
const POLL_MS = 1500;
/**
 * Trạng thái lượt sinh tới qua Realtime (G1): worker ghi `generations` là client đọc lại
 * ngay. Hỏi lại định kỳ chỉ còn là lưới an toàn — Realtime có thể rụng mà channel vẫn
 * báo SUBSCRIBED (cùng lý do với `useLive`).
 */
const FALLBACK_MS = 5000;
const WAIT_MS = 15 * 60_000;
/** Ảnh vừa upload: probe trên worker thường xong trong vài giây. */
const PROBE_WAIT_MS = 90_000;
const TYPES = { image: "IMAGE", video: "VIDEO", voice: "AUDIO", audio: "AUDIO" } as const;

export type Declaration = Record<string, unknown> & { generate: keyof typeof TYPES; prompt: string };
type Resolved = { type: Declaration["generate"]; model: string; spec: Record<string, unknown> };
type GenerationView = {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  error: string | null;
  asset: { id: string; name: string; url: string } | null;
};

/** Mọi khai báo `{generate}` trong document (src của node, src của paint). */
export function declarationsOf(document: ClipDocument): Declaration[] {
  const out: Declaration[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.generate === "string" && typeof record.prompt === "string") {
      out.push(record as Declaration);
      return;
    }
    Object.values(record).forEach(visit);
  };
  visit(document.stage);
  return out;
}

export type PendingGeneration = { key: string; label: string };

/**
 * Khai báo `{generate}` chưa có file sẵn sàng và chưa hỏng — đang sinh. Thanh
 * trên hiện chúng: agent kết thúc lượt ngay khi đặt lệnh sinh, nên không có chỉ
 * báo này thì người dùng tưởng đã xong trong khi worker còn chạy (02/10).
 */
export function pendingGenerations(document: ClipDocument, manifest: Manifest): PendingGeneration[] {
  const seen = new Set<string>();
  const out: PendingGeneration[] = [];
  for (const declaration of declarationsOf(document)) {
    const key = JSON.stringify(resolve(declaration));
    if (seen.has(key)) continue;
    seen.add(key);
    const records = (manifest?.assets ?? []).filter((record) => generationMatches(declaration, record as never));
    if (records.some((record) => !isPartial(record))) continue;
    if (records.some((record) => isPartial(record) && (record as PartialRecord).state === "error")) continue;
    const kind = declaration.generate as string;
    const voice = typeof declaration.voice === "string" ? ` (${declaration.voice})` : "";
    const noun = kind === "voice" ? "voice" : kind === "audio" ? "sound" : kind;
    out.push({ key, label: `${noun}${voice}` });
  }
  return out;
}

export type AiState = { state: "pending"; label: string } | { state: "error"; message: string };

/** Khai báo `{generate}` của CHÍNH phần tử: `src` của nó hoặc `src` của một paint (không xét con). */
export function ownDeclarations(entity: Record<string, unknown>): Declaration[] {
  const sources = [entity.src, ...((entity.paints as { src?: unknown }[] | undefined) ?? []).map((paint) => paint.src)];
  return sources.filter(
    (src): src is Declaration =>
      !!src && typeof src === "object" && typeof (src as Declaration).generate === "string" && typeof (src as Declaration).prompt === "string",
  );
}

/**
 * Trạng thái sinh của một phần tử, cho timeline và canvas (G1, học Palmier: thứ đang sinh
 * phải thấy NGAY TRÊN clip, không chỉ ở thanh trên). Hỏng thắng đang sinh: một khai báo hỏng
 * là phần tử đó không bao giờ có hình nếu người dùng không Retry.
 */
export function aiStateOf(entity: Record<string, unknown>, manifest: Manifest, label = "Generating…"): AiState | null {
  let pending = false;
  for (const declaration of ownDeclarations(entity)) {
    const records = (manifest?.assets ?? []).filter((record) => generationMatches(declaration, record as never));
    if (records.some((record) => !isPartial(record))) continue;
    const failed = records.find((record) => isPartial(record) && (record as PartialRecord).state === "error") as PartialRecord | undefined;
    if (failed) return { state: "error", message: failed.error ?? "Generation failed." };
    pending = true;
  }
  return pending ? { state: "pending", label } : null;
}

/** Trường có mặt trong khai báo, đúng thứ tự gọi (khoá phải ổn định). */
function pick(declaration: Declaration, ...names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.filter((name) => declaration[name] !== undefined).map((name) => [name, declaration[name]]));
}

const INPUT_KEYS = { startFrame: "startImage", endFrame: "endImage" } as const;

/**
 * Spec của KHOÁ giữ ảnh đầu vào đúng như khai báo (đường dẫn thư viện, hay một khai báo
 * `generate` lồng) — khoá không đổi khi thư viện đổi. Lúc gửi lên server mới đổi mỗi ảnh
 * thành id asset media của nó; server đổi tiếp thành tên object dưới RLS. Ảnh lồng còn
 * đang sinh thì CHỜ nó xong (sinh ảnh rồi animate — quy trình B-roll của Palmier).
 */
async function serverSpec(spec: Record<string, unknown>, latest: () => Manifest, aborted: () => boolean): Promise<Record<string, unknown>> {
  const mediaId = async (input: unknown): Promise<string> => {
    const started = Date.now();
    for (;;) {
      const manifest = latest();
      const record = libraryRecord(manifest, input as never) as (LibraryRecord & { cloud?: { mediaId?: string } }) | null;
      if (record) {
        if (record.cloud?.mediaId) return record.cloud.mediaId;
        throw new Error("That image is still uploading. Try again when its cloud icon shows it is saved.");
      }
      const failed = typeof input === "object" && (manifest.assets ?? []).some(
        (item) => isPartial(item) && (item as PartialRecord).state === "error" && generationMatches(input as Record<string, unknown>, item as never),
      );
      if (failed) throw new Error("The image it starts from failed to generate.");
      if (typeof input === "string") throw new Error("That image was not found in your library.");
      if (aborted() || Date.now() - started > WAIT_MS) throw new Error("The image it starts from is still generating. Try again when it is ready.");
      await sleep(POLL_MS);
    }
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spec)) {
    if (key in INPUT_KEYS) out[INPUT_KEYS[key as keyof typeof INPUT_KEYS]] = await mediaId(value);
    else if (key === "sourceVideo") out.sourceVideo = await mediaId(value);
    else if (key === "refs" && Array.isArray(value)) out.references = await Promise.all(value.map(mediaId));
    else out[key] = value;
  }
  return out;
}

/** Khai báo → đúng thứ gửi lên server; thứ tự field cố định để khoá ổn định. */
export function resolve(declaration: Declaration): Resolved {
  const seed = typeof declaration.seed === "number" ? { seed: declaration.seed } : {};
  const firstOf = (kind: string) => AI_MODELS.find((model) => model.kind === kind && !model.limits.scene && !model.limits.sourceVideo)?.id ?? "";
  switch (declaration.generate) {
    case "image":
      return {
        type: "image",
        model: String(declaration.model ?? firstOf("image")),
        spec: { prompt: declaration.prompt, aspectRatio: declaration.aspectRatio ?? "16:9", ...pick(declaration, "resolution", "refs"), ...seed },
      };
    case "video":
      return {
        type: "video",
        model: String(declaration.model ?? firstOf("video")),
        spec: {
          prompt: declaration.prompt,
          aspectRatio: declaration.aspectRatio ?? "16:9",
          duration: declaration.duration ?? 5,
          // 3D Studio: dữ liệu cảnh đi nguyên vào spec (nằm trong hash).
          ...(declaration.scene && typeof declaration.scene === "object" ? { scene: declaration.scene } : {}),
          ...pick(declaration, "resolution", "audio", "startFrame", "endFrame", "refs", "sourceVideo", "sourceStart"),
          ...seed,
        },
      };
    case "voice": {
      // Giọng quyết định model.
      const voice = String(declaration.voice ?? "");
      const model = AI_MODELS.find((entry) => entry.kind === "voice" && entry.limits.voices?.includes(voice))?.id ?? firstOf("voice");
      return { type: "voice", model, spec: { prompt: declaration.prompt, voice, ...seed } };
    }
    case "audio":
      return {
        type: "audio",
        model: String(declaration.model ?? firstOf("audio")),
        spec: { prompt: declaration.prompt, duration: Math.round(Number(declaration.duration ?? 5)), ...seed },
      };
  }
}

function provisionalName(prompt: string): string {
  const text = prompt.trim().replace(/\s+/g, " ").replace(/\//g, "-");
  if (text.length <= 48) return text || "Generation";
  const cut = text.lastIndexOf(" ", 48);
  return `${text.slice(0, cut > 0 ? cut : 48)}…`;
}

async function keyId(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`key\n${key}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { ...init, headers: init?.body ? { "content-type": "application/json" } : undefined }).catch(() => null);
  if (!response) throw new Error("Connection lost. Check your internet and try again.");
  const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
  if (!response.ok) throw new Error(typeof body?.detail === "string" ? body.detail : "Something went wrong. Please try again.");
  return body as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const recordFor = (manifest: Manifest, key: string) => manifest.assets.find((record) => record.generation?.key === key);

export function useGenerations({
  document,
  library,
  clipId,
  projectId,
  notify,
  onCredits,
}: {
  document: ClipDocument;
  library: LibraryApi;
  clipId: string;
  projectId: string;
  notify: (message: string) => void;
  /** Gọi khi số dư vừa đổi: giữ credit lúc tạo, kết toán hoặc hoàn lúc xong. */
  onCredits?: () => void;
}): { retry: (entity: Record<string, unknown>) => Promise<void> } {
  const running = useRef(new Set<string>());
  // Retry xoá record hỏng khỏi thư viện; manifest không nằm trong deps của effect nên cần
  // một nhịp riêng để effect chạy lại. Server không dùng lại lượt `failed` cùng spec, nên
  // lượt mới là lượt mới (giữ credit lại từ đầu, hoàn nếu lại hỏng).
  const [attempt, setAttempt] = useState(0);
  const credits = useRef(onCredits);
  credits.current = onCredits;
  const libraryRef = useRef(library);
  libraryRef.current = library;
  // Người đang chờ một thay đổi của `generations`: Realtime (hoặc quay lại tab) đánh thức hết.
  const waiters = useRef(new Set<() => void>());
  const wake = useCallback(() => {
    const pending = [...waiters.current];
    waiters.current.clear();
    for (const resolve of pending) resolve();
  }, []);

  useEffect(() => {
    if (!projectId) return;
    const supabase = createClient();
    // Payload không phải nguồn sự thật: nó chỉ đánh thức vòng chờ, vòng chờ đọc lại qua API (RLS).
    const channel = supabase
      .channel(`generations-${projectId}-${clipId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "generations", filter: `job_id=eq.${projectId}` }, wake)
      .subscribe();
    const onVisible = () => {
      if (window.document.visibilityState === "visible") wake();
    };
    window.document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.document.removeEventListener("visibilitychange", onVisible);
      void supabase.removeChannel(channel);
    };
  }, [projectId, clipId, wake]);

  useEffect(() => {
    for (const declaration of declarationsOf(document)) {
      const resolved = resolve(declaration);
      const key = JSON.stringify(resolved);
      if (running.current.has(key)) continue;
      const manifest = libraryRef.current.latest();
      // Đã có asset khớp (kể cả record cũ khớp theo trường), hay đã hỏng: không chạy.
      if (manifest.assets.some((record) => !isPartial(record) && generationMatches(declaration, record as never))) continue;
      const existing = recordFor(manifest, key);
      if (existing && isPartial(existing) && existing.state === "error") continue;
      running.current.add(key);
      void run(resolved, key).finally(() => running.current.delete(key));
    }

    async function run(resolved: Resolved, key: string) {
      const lib = libraryRef.current;
      // Partial giữ chỗ trong thư viện (tiếp tục partial cũ nếu tab trước bỏ dở).
      let partial = recordFor(lib.latest(), key) as PartialRecord | undefined;
      if (!partial) {
        const id = await keyId(key);
        await lib.update((current) => {
          if (recordFor(current, key)) return current;
          const placed: PartialRecord = {
            id,
            path: uniquePath(current, joinPath(GENERATED_DIR, provisionalName(String(resolved.spec.prompt)))),
            type: TYPES[resolved.type],
            createdAt: new Date().toISOString(),
            generation: { key },
            state: "pending",
          };
          return { ...current, assets: [placed, ...current.assets] };
        });
        partial = recordFor(lib.latest(), key) as PartialRecord | undefined;
      }
      if (!partial) return;
      const fail = (message: string) =>
        lib.update((current) => ({
          ...current,
          assets: current.assets.map((record) => (record.generation?.key === key ? { ...record, state: "error", error: message } : record)) as LibraryRecord[],
        }));
      try {
        const spec = await serverSpec(resolved.spec, () => libraryRef.current.latest(), () => !recordFor(libraryRef.current.latest(), key));
        const requestId = crypto.randomUUID();
        const post = () =>
          api<{ generation: GenerationView }>("generations", {
            method: "POST",
            body: JSON.stringify({ job_id: projectId, clip_id: clipId, model: resolved.model, spec, request_id: requestId }),
          });
        // Ảnh vừa upload còn đang được worker kiểm (probe) vài giây: chờ thay vì báo hỏng.
        // Server từ chối TRƯỚC khi đặt credit, nên gửi lại không trừ hai lần.
        let attempt = post();
        const waitStarted = Date.now();
        for (;;) {
          try {
            await attempt;
            break;
          } catch (error) {
            const stillUploading = /still uploading/i.test((error as Error).message);
            if (!stillUploading || Date.now() - waitStarted > PROBE_WAIT_MS || !recordFor(libraryRef.current.latest(), key)) throw error;
            await sleep(POLL_MS);
            attempt = post();
          }
        }
        const { generation } = await attempt;
        credits.current?.();
        const started = Date.now();
        // POST chỉ trả trạng thái, không kèm `asset` (GET mới ký URL). Lượt dùng lại
        // một generation ĐÃ xong (agent tạo lúc duyệt, voice xong trong vài giây) vì
        // thế từng bị coi là hỏng: "Voice generation failed" dù audio đã có (02/10).
        let view: GenerationView =
          generation.status === "done" && !generation.asset ? await api<GenerationView>(`generations/${encodeURIComponent(generation.id)}`) : generation;
        while (view.status === "queued" || view.status === "running") {
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              waiters.current.delete(done);
              resolve();
            };
            const timer = setTimeout(done, FALLBACK_MS);
            waiters.current.add(done);
          });
          if (!recordFor(lib.latest(), key)) {
            // Người dùng xoá partial: huỷ để hoàn credit.
            await api(`generations/${encodeURIComponent(view.id)}/cancel`, { method: "POST" }).catch(() => undefined);
            return;
          }
          if (Date.now() - started > WAIT_MS) throw new Error("This is taking longer than expected. It will appear in your library when it finishes.");
          view = await api<GenerationView>(`generations/${encodeURIComponent(view.id)}`);
        }
        if (view.status !== "done" || !view.asset) {
          throw new Error(
            view.status === "cancelled" ? "Generation was cancelled. Your credits were refunded." : (view.error ?? "Generation failed. Your credits were refunded."),
          );
        }
        const download = await fetch(view.asset.url).catch(() => null);
        if (!download?.ok) throw new Error("Could not download the generated file. Try again.");
        const blob = await download.blob();
        const placed = recordFor(lib.latest(), key);
        if (!placed) return;
        const folder = placed.path.split("/").slice(0, -1).join("/");
        const name = placed.path.split("/").pop() ?? view.asset.name;
        const extension = view.asset.name.includes(".") ? view.asset.name.slice(view.asset.name.lastIndexOf(".")) : "";
        // Tên KHÔNG trùng phải chọn TRƯỚC khi ghi OPFS: `source` (chỗ bytes nằm)
        // suy từ tên file. Chọn sau (chỉ đổi `path`) thì giọng mới cùng câu mở đầu
        // ghi đè bytes của giọng cũ, blob URL đang mở hỏng (ERR_UPLOAD_FILE_CHANGED)
        // và preview im tới khi tải lại trang (production 02/10, đổi giọng voiceover).
        const wanted = joinPath(folder, name.endsWith(extension) ? name : `${name}${extension}`);
        const unique = uniquePath(lib.latest(), wanted, placed.id).split("/").pop()!;
        const file = new File([blob], unique, { type: blob.type });
        const described = await describe(file, folder);
        const record = { ...described, generation: { key, id: view.id }, cloud: { state: "synced" as const, mediaId: view.asset.id } };
        // OPFS chỉ là bộ đệm: bytes đã nằm trên Storage (`mediaId`) và credit đã
        // trừ. Ghi đệm hỏng (Chrome không có locale UTF-8 từ chối mọi tên ngoài
        // ASCII, hết quota, chế độ riêng tư) không được biến một lượt đã trả tiền
        // thành "failed" — `urlOf` tải lại từ Storage.
        await keepLocal(clipId, record, file).catch((error) => console.warn("[generate] local cache skipped", error));
        // Partial giữ chỗ bằng tên CHƯA có đuôi, nên nó không đụng ai; thêm `.m4a`
        // lúc về thì có thể trùng đúng file của lượt trước cùng câu mở đầu (hai
        // voiceover viết lại cùng một kịch bản) — hai record một đường dẫn.
        await lib.update((current) => ({
          ...current,
          assets: current.assets.map((item) =>
            item.generation?.key === key ? { ...record, path: uniquePath(current, record.path, item.id) } : item,
          ),
        }));
      } catch (error) {
        const message = (error as Error).message;
        const kind = resolved.type === "voice" ? "Voice" : resolved.type[0]!.toUpperCase() + resolved.type.slice(1);
        // Lỗi của worker đã mở đầu bằng "Generation failed." — ghép thẳng ra
        // "Video generation failed. Generation failed. …" (UAT production 29/09).
        notify(`${kind} generation failed. ${message.replace(/^Generation failed\.?\s*/i, "")}`.trim());
        await fail(message);
      } finally {
        credits.current?.();
      }
    }
  }, [document, clipId, projectId, notify, attempt]);

  const retry = useCallback(async (entity: Record<string, unknown>) => {
    const keys = new Set(ownDeclarations(entity).map((declaration) => JSON.stringify(resolve(declaration))));
    await libraryRef.current.update((current) => ({
      ...current,
      assets: current.assets.filter(
        (record) => !(record.generation?.key && keys.has(record.generation.key) && isPartial(record) && record.state === "error"),
      ),
    }));
    setAttempt((value) => value + 1);
  }, []);

  return { retry };
}
