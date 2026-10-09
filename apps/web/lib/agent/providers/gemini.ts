/**
 * Provider Gemini (`@google/genai`) — cùng khoá `GEMINI_API_KEY` với engine
 * (`packages/engine/opencmo/steps/select.py`).
 *
 * Lịch sử lưu ở dạng `parts` NATIVE, gửi lại NGUYÊN VẸN: Gemini gắn
 * `thoughtSignature` vào part và đòi nhận lại đúng part đó ở lượt sau — gộp
 * hay sửa part là mất mạch suy nghĩ giữa các lần gọi tool.
 *
 * Tool: `functionDeclarations` dựng từ CÙNG schema op với Claude
 * (`TOOL_SPECS`); function calling tự động của SDK tắt — vòng lặp của ta chạy
 * tool, không phải SDK. Kết quả tool là part `functionResponse`; ảnh của
 * `capture_frames` đi trong `functionResponse.parts` (phản hồi đa phương thức).
 */

import { ApiError, FinishReason, GoogleGenAI, type Content, type Part } from "@google/genai";

import type { ToolSpec } from "../tools";
import { IMAGE_OMITTED, type Delta, type Format, type Provider, type Step, type StepRequest, type StoredMessage, type ToolCall, type ToolResult } from "./types";

/** Bản Pro mới nhất; đổi bằng `AGENT_GEMINI_MODEL` (vd. một id cố định sau khi `models.list`). */
export const GEMINI_MODEL = process.env.AGENT_GEMINI_MODEL || "gemini-pro-latest";

const MAX_OUTPUT_TOKENS = 32_768;

const REFUSALS = new Set<string>([
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.BLOCKLIST,
  FinishReason.SPII,
  FinishReason.RECITATION,
]);

/**
 * Id của một function call. Gemini không phải lúc nào cũng trả `id`; khi đó
 * id là vị trí của nó trong tin nhắn — tất định, nên đọc lại tin nhắn đã lưu
 * (`callsIn`) ra đúng id đã gửi cho trình duyệt.
 */
const callId = (part: Part, index: number): string => part.functionCall?.id || `gc_${index}`;

function parseContent(content: string): Record<string, unknown> {
  try {
    const value = JSON.parse(content) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { output: value };
  } catch {
    return { output: content };
  }
}

export const geminiFormat: Format = {
  kind: "gemini",
  userTurn: (prompt, state, images) => [
    { text: prompt },
    ...(images ?? []).map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })),
    { text: state },
  ],
  toolResults(results: ToolResult[], state?: string) {
    const parts: Part[] = results.map((result) => ({
      functionResponse: {
        // `id` chỉ khi model đã đặt nó; id tự sinh `gc_*` là của ta, không phải của Gemini.
        ...(result.id.startsWith("gc_") ? {} : { id: result.id }),
        name: result.name,
        response: result.ok ? parseContent(result.content) : { error: parseContent(result.content) },
        ...(result.images?.length
          ? { parts: result.images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })) }
          : {}),
      },
    }));
    if (state) parts.push({ text: state });
    return parts;
  },
  callsIn: (content) =>
    (content as Part[]).flatMap((part, index) =>
      part.functionCall ? [{ id: callId(part, index), name: part.functionCall.name ?? "", input: part.functionCall.args ?? {} }] : [],
    ),
  replyText: (content) =>
    (content as Part[])
      .filter((part) => part.text && !part.thought)
      .map((part) => part.text!)
      .join("")
      .trim(),
  trimImages(history: StoredMessage[], keep: number): StoredMessage[] {
    const hasImage = (message: StoredMessage) =>
      message.role === "user" && (message.content as Part[]).some((part) => part.inlineData || part.functionResponse?.parts?.length);
    let seen = 0;
    const out = [...history];
    for (let index = out.length - 1; index >= 0; index--) {
      const message = out[index]!;
      if (!hasImage(message) || ++seen <= keep) continue;
      out[index] = {
        ...message,
        content: (message.content as Part[]).map((part) => {
          if (part.inlineData) return { text: IMAGE_OMITTED };
          if (!part.functionResponse?.parts?.length) return part;
          const { parts: _dropped, ...rest } = part.functionResponse;
          return { ...part, functionResponse: { ...rest, response: { ...rest.response, images: IMAGE_OMITTED } } };
        }),
      };
    }
    return out;
  },
};

const declarations = (specs: ToolSpec[]) =>
  specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parametersJsonSchema: spec.schema,
  }));

function failureMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429 || err.status >= 500) return "The assistant is busy right now. Try again in a moment.";
    return "The assistant could not process this request.";
  }
  return "Something went wrong. Please try again.";
}

const toContents = (history: StoredMessage[]): Content[] =>
  history.map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: message.content as Part[] }));

/**
 * `client` để check thay client thật bằng response ghi sẵn — không mạng. `modelId`: agent CMO
 * chọn model riêng (H1, `lib/cmo/agents/registry.ts`); vắng thì model chung của Assistant.
 */
export function geminiProvider(apiKey: string, client?: Pick<GoogleGenAI, "models">, modelId: string = GEMINI_MODEL): Provider {
  const ai = client ?? new GoogleGenAI({ apiKey });

  return {
    ...geminiFormat,
    model: modelId,
    failureMessage,
    async step({ history, tools, system, signal }: StepRequest, onDelta: (delta: Delta) => void): Promise<Step> {
      const stream = await ai.models.generateContentStream({
        model: modelId,
        contents: toContents(history),
        config: {
          systemInstruction: system,
          tools: [{ functionDeclarations: declarations(tools) }],
          thinkingConfig: { includeThoughts: true },
          automaticFunctionCalling: { disable: true },
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          abortSignal: signal,
        },
      });

      // Giữ MỌI part đúng như nhận được, theo thứ tự: chữ, suy nghĩ, function
      // call và `thoughtSignature` đi kèm chúng.
      const parts: Part[] = [];
      let finish: string | undefined;
      let blocked = false;
      let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let model = modelId;

      for await (const chunk of stream) {
        if (chunk.promptFeedback?.blockReason) blocked = true;
        const candidate = chunk.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          parts.push(part);
          if (part.functionCall) {
            onDelta({ type: "tool_start", id: callId(part, parts.length - 1), name: part.functionCall.name ?? "" });
          } else if (part.text) {
            onDelta({ type: part.thought ? "thinking" : "text", text: part.text });
          }
        }
        if (candidate?.finishReason) finish = candidate.finishReason;
        if (chunk.modelVersion) model = chunk.modelVersion;
        const meta = chunk.usageMetadata;
        if (meta) {
          const cached = meta.cachedContentTokenCount ?? 0;
          usage = {
            // `promptTokenCount` đã gồm phần cache; tính phần cache ở giá cache.
            input: Math.max(0, (meta.promptTokenCount ?? 0) - cached),
            output: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
            cacheRead: cached,
            cacheWrite: 0,
          };
        }
      }

      const calls: ToolCall[] = geminiFormat.callsIn(parts);
      return {
        content: parts,
        toolCalls: calls,
        stop:
          blocked || (finish && REFUSALS.has(finish))
            ? "refusal"
            : finish === FinishReason.MAX_TOKENS
              ? "max_tokens"
              : calls.length
                ? "tool"
                : "end",
        usage,
        model,
      };
    },
  };
}
