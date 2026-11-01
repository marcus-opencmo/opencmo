import { NextResponse, type NextRequest } from "next/server";

import { handleZernioWebhook } from "@/lib/departments/publish/webhook-handle";
import { MAX_WEBHOOK_BYTES } from "@/lib/departments/publish/webhook";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Zernio's post and account events (P4 B5). Open to anyone, so the body is capped before it is hashed, and nothing
 * is read or written until the signature over the raw body checks out.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.ZERNIO_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[zernio] webhook secret is not configured");
    return NextResponse.json({ error: "Webhook is not configured." }, { status: 500 });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "Webhook payload is too large." }, { status: 413 });
  }
  const body = await request.text();
  // Chunked bodies have no content-length: measure the bytes themselves.
  if (Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "Webhook payload is too large." }, { status: 413 });
  }
  const admin = createAdminClient();
  const answer = await handleZernioWebhook(body, request.headers.get("x-zernio-signature"), secret, {
    rpc: (name, args) => admin.rpc(name, args),
    releaseReceipt: async (eventId) => {
      const { error } = await admin.from("zernio_receipts").delete().eq("event_id", eventId);
      if (error) console.error("[zernio] could not release a receipt", error.message);
    },
  });
  if (answer.status >= 400) console.warn("[zernio] webhook answered", answer.status, answer.body.error);
  return NextResponse.json(answer.body, { status: answer.status });
}
