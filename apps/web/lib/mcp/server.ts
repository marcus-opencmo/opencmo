import "server-only";

/**
 * MCP server của OpenCMO (G5, học Palmier: một tool layer cho agent trong app LẪN client MCP).
 *
 * Streamable HTTP dạng không trạng thái: mỗi POST là một thông điệp JSON-RPC, trả JSON. Tool clip
 * là ĐÚNG tool của Assistant (`runTool` trên workspace DB), thêm `clip_id`; mỗi lần ghi để lại một
 * checkpoint "MCP" trong Version history như lượt sửa của agent. Sinh media tốn credit nên đi hai
 * bước: lần gọi đầu chỉ báo giá + `confirm` (có chữ ký, sống 10 phút); gọi lại kèm `confirm` mới
 * sinh — client không thể đổi spec giữa hai bước.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { clipContext } from "@/lib/api/clips";
import { ApiError } from "@/lib/api/errors";
import type { SupabaseClient } from "@/lib/api/handler";
import { quoteRange } from "@opencmo/editor-core";
import { resolveMediaRefs } from "@/lib/generate/create";
import { loadCatalog } from "@/lib/generate/models";
import { dbWorkspace } from "@/lib/agent/db-workspace";
import { generateInput, generateToolSpec, prepareGeneration, runGeneration, type PreparedGeneration } from "@/lib/agent/generate-tool";
import { applyOpTool, runTool, TOOL_SPECS, type ToolOutcome } from "@/lib/agent/tools";

export const PROTOCOL_VERSION = "2025-06-18";
const CONFIRM_SECONDS = 600;

/** Tool của Assistant không có nghĩa ngoài khung chat (kế hoạch, hỏi lại) hay cần trình duyệt. */
const SKIP = new Set(["update_plan", "ask_user"]);
const CLIP_TOOLS = TOOL_SPECS.filter((tool) => !tool.browser && !tool.input && !SKIP.has(tool.name));
const CLIP_TOOL_NAMES = new Set(CLIP_TOOLS.map((tool) => tool.name));

type JsonRpc = { jsonrpc?: unknown; id?: string | number | null; method?: unknown; params?: unknown };
type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };

const withClip = (schema: Record<string, unknown>): Record<string, unknown> => ({
  ...schema,
  type: "object",
  properties: { clip_id: { type: "string", description: "The clip to work on (from list_clips)." }, ...((schema.properties as object) ?? {}) },
  required: ["clip_id", ...(((schema.required as string[]) ?? []).filter((key) => key !== "clip_id"))],
});

function toolList(): Tool[] {
  const generate = generateToolSpec();
  return [
    {
      name: "list_projects",
      description: "List the user's video projects, newest first.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "Words in the project name." } } },
    },
    {
      name: "list_clips",
      description: "List the clips of a project with their id, number, hook and length.",
      inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] },
    },
    ...CLIP_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: withClip(tool.schema) })),
    ...(generate
      ? [
          {
            name: "generate_media",
            description:
              `${generate.description}\n\nCosts credits, in two steps: call it once to get the price and a "confirm" code (nothing is spent), ` +
              `show the price to the user, and only after they agree call generate_media again with just clip_id and confirm.`,
            inputSchema: (() => {
              const schema = withClip(generate.schema);
              const properties = { ...(schema.properties as object), confirm: { type: "string", description: "The code from the price step." } };
              // Bước xác nhận chỉ cần clip_id + confirm: bỏ `required` của brief.
              return { ...schema, properties, required: ["clip_id"] };
            })(),
          },
        ]
      : []),
  ];
}

// ------------------------------------------------------------------ xác nhận giá

function confirmKey(): Buffer {
  const secret = process.env.SUPABASE_JWT_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("Thiếu khoá ký cho bước xác nhận MCP.");
  return createHmac("sha256", "opencmo-mcp-confirm").update(secret).digest();
}

/** Mã xác nhận: thứ ĐÃ báo giá (spec + op) gắn với user, clip, hạn — client không sửa được. */
export function signConfirm(userId: string, clipId: string, prepared: unknown, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ u: userId, c: clipId, e: Math.floor(now / 1000) + CONFIRM_SECONDS, p: prepared })).toString("base64url");
  return `${body}.${createHmac("sha256", confirmKey()).update(body).digest("base64url")}`;
}

export function readConfirm(token: string, userId: string, clipId: string, now = Date.now()): unknown {
  const [body, signature] = token.split(".");
  if (!body || !signature) throw new ApiError(422, "That confirm code is not valid. Ask for the price again.");
  const expected = createHmac("sha256", confirmKey()).update(body).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new ApiError(422, "That confirm code is not valid. Ask for the price again.");
  const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { u: string; c: string; e: number; p: unknown };
  if (data.u !== userId || data.c !== clipId) throw new ApiError(422, "That confirm code belongs to another clip.");
  if (data.e < Math.floor(now / 1000)) throw new ApiError(422, "That price has expired. Ask for the price again.");
  return data.p;
}

// ------------------------------------------------------------------ chạy tool

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

const fromOutcome = (outcome: ToolOutcome) => text(outcome.content, !outcome.ok);

async function clipEnv(supabase: SupabaseClient, clipId: string) {
  const context = await clipContext(supabase, clipId);
  // Mỗi lượt ghi: một checkpoint "MCP" trong Version history (khôi phục được như lượt agent).
  const workspace = dbWorkspace(supabase, context, clipId, { take: () => ({ kind: "agent" as const, label: "MCP" }), mark: async () => undefined });
  return { context, env: { workspace } };
}

async function callTool(supabase: SupabaseClient, userId: string, name: string, args: Record<string, unknown>) {
  if (name === "list_projects") {
    const { data, error } = await supabase.rpc("list_projects", { p_query: typeof args.query === "string" ? args.query : null, p_limit: 50 });
    if (error) throw new ApiError(503, "Could not load your projects.");
    return text(((data ?? []) as { id: string; name: string | null; title: string | null; status: string; created_at: string }[]).map((job) => ({
      id: job.id, name: job.name ?? job.title, status: job.status, created_at: job.created_at,
    })));
  }
  if (name === "list_clips") {
    const projectId = z.string().uuid().safeParse(args.project_id);
    if (!projectId.success) throw new ApiError(422, "project_id: give a project id from list_projects.");
    const { data, error } = await supabase.from("clips").select("id, idx, hook, start_seconds, end_seconds, kind").eq("job_id", projectId.data).order("idx");
    if (error) throw new ApiError(503, "Could not load the clips.");
    return text((data ?? []).map((clip) => ({
      id: clip.id, number: clip.idx + 1, hook: clip.hook, kind: clip.kind,
      seconds: Math.round((Number(clip.end_seconds) - Number(clip.start_seconds)) * 10) / 10,
    })));
  }

  const clipId = z.string().uuid().safeParse(args.clip_id);
  if (!clipId.success) throw new ApiError(422, "clip_id: give a clip id from list_clips.");
  const { clip_id: _clip, ...input } = args;

  if (name === "generate_media") {
    await loadCatalog(supabase);
    const { context, env } = await clipEnv(supabase, clipId.data);
    if (typeof input.confirm === "string") {
      const prepared = readConfirm(input.confirm, userId, clipId.data) as PreparedGeneration;
      const { outcome, generationId } = await runGeneration(
        { supabase, jobId: context.clip.job_id, clipId: clipId.data, applyOp: (op) => applyOpTool(op, env) },
        prepared,
      );
      let result: unknown = outcome.content;
      try {
        result = JSON.parse(outcome.content);
      } catch {
        // Nội dung không phải JSON: trả nguyên văn.
      }
      return text(generationId && result && typeof result === "object" ? { ...result, generation_id: generationId } : result, !outcome.ok);
    }
    const parsed = generateInput.safeParse(input);
    if (!parsed.success) return text({ INVALID_INPUT: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, true);
    const prepared = await prepareGeneration(
      parsed.data,
      async (quote) => {
        const snapshot = await env.workspace.read();
        return quoteRange(snapshot.document, await env.workspace.opContext(snapshot.document, snapshot.manifest), quote, { min: 1.5, max: 5 });
      },
      async (path) => {
        const snapshot = await env.workspace.read();
        const assets = ((snapshot.manifest as { assets?: unknown[] } | null)?.assets ?? []) as { path?: string; type?: string; state?: string; cloud?: { mediaId?: string } }[];
        const record = assets.find((item) => item.path === path && item.type === "IMAGE" && !item.state && item.cloud?.mediaId);
        if (!record?.cloud?.mediaId) return null;
        const resolved = (await resolveMediaRefs(supabase, context.clip.job_id, { startImage: record.cloud.mediaId }).catch(() => null)) as { startImage?: string } | null;
        return resolved?.startImage ?? null;
      },
    );
    if (typeof prepared === "string") return text({ INVALID_INPUT: prepared }, true);
    return text({
      price_credits: prepared.credits,
      model: prepared.model.name,
      prompt: prepared.spec.prompt,
      confirm: signConfirm(userId, clipId.data, prepared),
      next: "Show the price to the user. Only if they agree, call generate_media again with clip_id and this confirm code.",
    });
  }

  if (!CLIP_TOOL_NAMES.has(name)) throw new ApiError(404, `Unknown tool: ${name}.`);
  const { env } = await clipEnv(supabase, clipId.data);
  return fromOutcome(await runTool(name, input, env));
}

/** Một thông điệp JSON-RPC → kết quả (null với notification: trả 202, không thân). */
export async function handleMessage(message: JsonRpc, session: { supabase: SupabaseClient; userId: string }): Promise<Record<string, unknown> | null> {
  const id = message.id ?? null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return fail(-32600, "Invalid request.");
  if (message.id === undefined) return null;

  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "opencmo", version: "1.0.0" },
        instructions:
          "OpenCMO edits the user's short video clips. Start with list_projects and list_clips, read a clip with get_project_state, then edit it with the clip tools. " +
          "generate_media costs credits: always show the price and get the user's agreement before confirming.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      await loadCatalog(session.supabase);
      return reply({ tools: toolList() });
    case "tools/call": {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string") return fail(-32602, "Missing tool name.");
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      try {
        return reply(await callTool(session.supabase, session.userId, params.name, args));
      } catch (err) {
        // Lỗi người dùng (ApiError < 500) trả như kết quả tool có isError để model đọc được.
        if (err instanceof ApiError && err.status < 500) return reply(text(err.message, true));
        console.error("[mcp] tool lỗi", params.name, err);
        return reply(text("Something went wrong. Please try again.", true));
      }
    }
    default:
      return fail(-32601, `Unknown method: ${message.method}.`);
  }
}
