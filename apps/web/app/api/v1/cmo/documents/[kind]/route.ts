import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { firstRow, rpcOrThrow, withApi } from "@/lib/api/handler";
import { clampDocument, DOCUMENT_KINDS, type DocumentKind } from "@/lib/cmo/documents";
import type { DocumentRow } from "@/lib/cmo/state";

export const dynamic = "force-dynamic";

const body = z.object({ body: z.record(z.string(), z.unknown()) });

/** Người dùng sửa một document: lưu thành version mới, `created_by = user`. */
export const PUT = withApi(
  { body, rateLimit: { bucket: "presets", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, body, params }) => {
    const kind = params.kind as DocumentKind;
    if (!DOCUMENT_KINDS.includes(kind)) throw new ApiError(404, "Document not found.");
    const row = firstRow(
      await rpcOrThrow<DocumentRow | DocumentRow[]>(supabase, "save_marketing_document", {
        p_kind: kind,
        p_body: clampDocument(kind, body.body),
      }),
    );
    if (!row) throw new ApiError(500, "Could not save the document.");
    return row;
  },
);
