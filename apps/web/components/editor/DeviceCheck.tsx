"use client";

/**
 * Máy này mở được editor không. Luật nằm ở `lib/editor/device.ts` (dò tính năng,
 * không dò tên trình duyệt): Chrome, Edge, Safari 17+, Firefox trên máy tính đều
 * vào được. Máy không đạt nhận một màn hướng dẫn thay vì một editor dùng dở.
 */

import { useEffect, useState, type ReactNode } from "react";

import { browserFacts, deviceVerdict, MIN_HEIGHT, MIN_WIDTH, type DeviceVerdict } from "@/lib/editor/device";

export function DeviceCheck({ projectId, clipId, children }: { projectId: string | null; clipId: string; children: ReactNode }) {
  const [verdict, setVerdict] = useState<DeviceVerdict | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => setVerdict(deviceVerdict(browserFacts())), []);

  if (!verdict) return null;
  if (verdict.ok) return <>{children}</>;

  const link = `${window.location.origin}/app/editor/${clipId}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard bị từ chối quyền: ô chữ bên dưới vẫn chọn tay được.
    }
  };

  return (
    <div className="editor-gate">
      <h1>
        {verdict.reason === "codec" || verdict.reason === "missing" ? "This browser can't run the editor" : "Open this editor on a computer"}
      </h1>
      {verdict.reason === "codec" ? <p>This browser can&apos;t play H.264 video, which the editor uses for previews.</p> : null}
      {verdict.reason === "missing" ? <p>This browser is missing: {verdict.missing?.join(", ")}. Update it, or switch browsers.</p> : null}
      <p>
        The clip editor works in a desktop version of Chrome, Edge, Safari 17 or later, or Firefox — in a window at least{" "}
        {MIN_WIDTH}×{MIN_HEIGHT}.
      </p>
      <p>Send yourself this link and open it there:</p>
      <div className="editor-gate-link">
        <input readOnly value={link} aria-label="Link to this clip" onFocus={(event) => event.currentTarget.select()} />
        <button type="button" className="primary-button" onClick={copy}>
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      <p className="editor-gate-alt">
        You can still download this clip, or change its crop and captions, from{" "}
        <a href={projectId ? `/app/projects/${projectId}` : "/app/projects"}>the project page</a>.
      </p>
    </div>
  );
}
