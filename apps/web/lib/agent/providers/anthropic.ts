/**
 * Provider Claude (Anthropic) — logic của P2, sau giao diện trung lập.
 *
 * Tham số theo skill `claude-api`: adaptive thinking `summarized`, server-side
 * fallback `"default"`, tool `strict` + `eager_input_streaming` (input được
 * zod kiểm lại ở `tools.ts` trước khi chạy), cache ở system và đuôi hội thoại.
 */

import Anthropic from "@anthropic-ai/sdk";

import { MAX_TOKENS } from "../limits";
import type { ToolSpec } from "../tools";
import { IMAGE_OMITTED, type Delta, type Format, type Provider, type Step, type StepRequest, type StoredMessage, type ToolCall, type ToolResult } from "./types";

type Block = Anthropic.Beta.Messages.BetaContentBlockParam;

/** Beta header của `fallbacks: "default"`. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/**
 * Thinking blocks are bound to the system prompt and tool list that produced them. A deploy that
 * changes either (or `trimImages` replacing an old image) would make every stored conversation
 * fail with a 400; with `drop_block` the API drops the stale blocks and the turn still runs.
 */
const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

export const ANTHROPIC_MODEL = "claude-opus-5";

/** Định dạng content block của Claude — dùng chung cho Claude giả. */
export const anthropicFormat: Omit<Format, "kind"> = {
  userTurn: (prompt, state, images) => [
    { type: "text", text: prompt },
    ...(images ?? []).map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.data },
    })),
    { type: "text", text: state },
  ],
  toolResults(results: ToolResult[], state?: string) {
    const blocks: Block[] = results.map((result) => ({
      type: "tool_result",
      tool_use_id: result.id,
      content: result.images?.length
        ? [
            { type: "text", text: result.content },
            ...result.images.map((image) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: image.mimeType, data: image.data },
            })),
          ]
        : result.content,
      ...(result.ok ? {} : { is_error: true }),
    }));
    // tool_result đứng trước, chữ đứng sau — thứ tự API đòi.
    if (state) blocks.push({ type: "text", text: state });
    return blocks;
  },
  callsIn: (content) =>
    (content as Array<{ type?: string; id?: string; name?: string; input?: unknown }>)
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ id: block.id!, name: block.name!, input: block.input })),
  replyText: (content) =>
    (content as Array<{ type?: string; text?: string }>)
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text!)
      .join("\n\n"),
  trimImages(history: StoredMessage[], keep: number): StoredMessage[] {
    type Item = { type?: string; content?: unknown };
    // Ảnh nằm trong tool_result (capture) HOẶC thẳng trong tin nhắn (khung người dùng đính kèm).
    const hasImage = (message: StoredMessage) =>
      message.role === "user" &&
      (message.content as Item[]).some(
        (block) => block.type === "image" || (Array.isArray(block.content) && (block.content as Item[]).some((part) => part.type === "image")),
      );
    let seen = 0;
    const out = [...history];
    for (let index = out.length - 1; index >= 0; index--) {
      const message = out[index]!;
      if (!hasImage(message) || ++seen <= keep) continue;
      out[index] = {
        ...message,
        content: (message.content as Item[]).map((block) =>
          block.type === "image"
            ? { type: "text", text: IMAGE_OMITTED }
            : Array.isArray(block.content)
            ? {
                ...block,
                content: (block.content as Item[]).map((part) => (part.type === "image" ? { type: "text", text: IMAGE_OMITTED } : part)),
              }
            : block,
        ),
      };
    }
    return out;
  },
};

const tools = (specs: ToolSpec[]): Anthropic.Beta.BetaTool[] =>
  specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: spec.schema as Anthropic.Beta.BetaTool["input_schema"],
    ...(spec.strict ? { strict: true } : {}),
    eager_input_streaming: true,
  }));

function failureMessage(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
    return "The assistant is busy right now. Try again in a moment.";
  }
  if (err instanceof Anthropic.APIConnectionError) return "The assistant could not be reached. Try again in a moment.";
  if (err instanceof Anthropic.APIError) return "The assistant could not process this request.";
  return "Something went wrong. Please try again.";
}

/** `model` / `apiKey`: agent CMO cấu hình riêng (H1); vắng thì model + khoá chung của Assistant. */
export function anthropicProvider(model: string = ANTHROPIC_MODEL, apiKey?: string): Provider {
  const client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();

  return {
    kind: "anthropic",
    model,
    ...anthropicFormat,
    failureMessage,
    async step({ history, tools: specs, system, signal }: StepRequest, onDelta: (delta: Delta) => void): Promise<Step> {
      let jsonRetries = 0;
      for (;;) {
        const stream = client.beta.messages.stream({
          model,
          max_tokens: MAX_TOKENS,
          thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          // Breakpoint thứ hai: đuôi hội thoại, để bước sau chỉ trả phần mới.
          cache_control: { type: "ephemeral" },
          tools: tools(specs),
          messages: history as Anthropic.Beta.Messages.BetaMessageParam[],
          betas: [FALLBACK_BETA, THINKING_BINDING_BETA],
          fallbacks: "default",
        }, { signal });
        try {
          for await (const event of stream) {
            if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
              onDelta({ type: "tool_start", id: event.content_block.id, name: event.content_block.name });
            } else if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta") onDelta({ type: "text", text: event.delta.text });
              else if (event.delta.type === "thinking_delta") onDelta({ type: "thinking", text: event.delta.thinking });
            }
          }
          const message = await stream.finalMessage();
          const calls: ToolCall[] = anthropicFormat.callsIn(message.content);
          return {
            content: message.content,
            toolCalls: calls,
            stop:
              message.stop_reason === "refusal"
                ? "refusal"
                : message.stop_reason === "max_tokens"
                  ? "max_tokens"
                  : calls.length
                    ? "tool"
                    : "end",
            usage: {
              input: message.usage.input_tokens ?? 0,
              output: message.usage.output_tokens ?? 0,
              cacheRead: message.usage.cache_read_input_tokens ?? 0,
              cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
            },
            model: message.model,
          };
        } catch (err) {
          // Eager input streaming: JSON tool input hỏng làm stream ném lúc khối
          // đóng. Chỉ trường hợp đó được gửi lại (tối đa 2 lần); lỗi API thì không.
          if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
        }
      }
    },
  };
}
