import { Suspense } from "react";

import { EditorHome } from "@/components/editor/EditorHome";

/** Mục "Editor" trên rail (G1): vào thẳng bản sửa gần nhất, hoặc một bản trống mới. */
export default function EditorPage() {
  return (
    <Suspense fallback={<div className="editor-gate" data-testid="editor-home" aria-busy="true"><p>Opening the editor…</p></div>}>
      <EditorHome />
    </Suspense>
  );
}
