/**
 * Read-only history format for Assistant chats saved while Gemini was a provider. New chats run on
 * Claude; these sessions can still be opened and read, but not continued.
 */

import { IMAGE_OMITTED, type Format, type StoredMessage, type ToolResult } from "./types";

/** The subset of Gemini's `Part` shape that saved chats contain. */
type Part = {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown>; parts?: Part[] };
};

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
        // Only ids Gemini set itself: generated `gc_*` ids are ours.
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
