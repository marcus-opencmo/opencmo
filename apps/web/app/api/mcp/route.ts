import { NextResponse } from "next/server";

import { mcpEndpoint } from "@/lib/cmo/connect";

export const dynamic = "force-dynamic";

/**
 * Retired (security fixes plan, item 8). The MCP server runs on Modal (`packages/mcp-server`),
 * with its own confirm codes, OAuth and paid-plan gate; this hand-rolled copy is gone. A client
 * still configured with this URL learns where the server moved.
 */
function moved() {
  return NextResponse.json({ error: "This endpoint moved.", url: mcpEndpoint() }, { status: 410, headers: { "cache-control": "no-store" } });
}

export const POST = moved;
export const GET = moved;
