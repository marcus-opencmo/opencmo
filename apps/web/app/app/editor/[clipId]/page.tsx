import Link from "next/link";

import { DeviceCheck } from "@/components/editor/DeviceCheck";
import { EditorShell } from "@/components/editor/EditorShell";
import { createServerClient } from "@/lib/supabase/server";

/**
 * Editor của một clip (E0: mục "Editor" trên rail). Project suy ra từ clip dưới RLS.
 * Clip không có (của người khác, đã xoá, id sai) vẫn đi qua cổng kiểm máy TRƯỚC: điện
 * thoại luôn thấy màn "mở trên máy tính", máy tính thấy câu "không tìm thấy" — không
 * lộ là clip có tồn tại hay không.
 */
export default async function EditorClipPage({ params }: { params: Promise<{ clipId: string }> }) {
  const { clipId } = await params;
  const valid = /^[0-9a-f-]{36}$/i.test(clipId);
  const supabase = await createServerClient();
  const { data } = valid
    ? await supabase.from("clips").select("job_id").eq("id", clipId).maybeSingle<{ job_id: string }>()
    : { data: null };
  return (
    <DeviceCheck projectId={data?.job_id ?? null} clipId={clipId}>
      {data ? (
        <EditorShell projectId={data.job_id} clipId={clipId} />
      ) : (
        <div className="editor-gate" data-testid="editor-missing">
          <h1>This clip was not found</h1>
          <p>It may have been deleted, or it belongs to another account.</p>
          <div className="editor-gate-link">
            <Link className="primary-button" href="/app/editor">
              Open my latest clip
            </Link>
          </div>
        </div>
      )}
    </DeviceCheck>
  );
}
