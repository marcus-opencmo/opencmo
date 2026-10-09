/**
 * Khối `<clip_context>`: clip nói về gì, theo từng câu và theo giây CLIP (spec
 * visual-grounding). Gắn MỘT lần vào tin nhắn đầu mỗi yêu cầu — không lặp sau
 * từng bước ghi như `<project_state>`, vì kịch bản không đổi trong một lượt
 * trừ khi agent cắt chữ (khi đó nó đọc lại bằng get_transcript).
 *
 * Trước đây agent chỉ thấy danh sách phần tử: muốn biết người nói nói gì nó
 * phải tự gọi get_transcript, và với visual nó hay bỏ qua — ra ảnh/video sinh
 * lạc đề. Giờ kịch bản đi cùng mọi câu lệnh.
 */

import type { ClipDocument } from "@opencmo/clip-doc";
import { clipScript, frameRatio, readBrand, clipTranscript, formatScript, loadCaptions, summarizeProject, type OpContext } from "@opencmo/editor-core";

export type ClipAbout = { hook?: string | null; reason?: string | null };

export async function clipContextBlock(document: ClipDocument, ctx: Pick<OpContext, "readTranscript">, about: ClipAbout = {}): Promise<string> {
  const model = await loadCaptions(document, ctx).catch(() => null);
  const script = model ? formatScript(clipScript(clipTranscript(model.transcript, model.window, model.removed))) : "";
  const payload = {
    ...(about.hook ? { title: about.hook } : {}),
    ...(about.reason ? { why_this_clip: about.reason } : {}),
    duration: summarizeProject(document).duration,
    // Hình khung: agent từng mặc định 9:16 cho 3D toàn khung trên clip 16:9 (02/10).
    ...(() => {
      const frame = frameRatio(document);
      return frame ? { frame } : {};
    })(),
    // Brand Kit đã áp: visual mới tự lấy màu/font này; chữ agent tự thêm nên theo.
    ...(() => {
      const kit = readBrand(document);
      return kit ? { brand: { colors: kit.colors, heading_font: kit.fonts.heading, body_font: kit.fonts.body, captions: kit.captions.preset } } : {};
    })(),
  };
  return `<clip_context>${JSON.stringify(payload)}\n<script clip_seconds="true">\n${script || "(no transcript)"}\n</script></clip_context>`;
}
