/**
 * Brief có cấu trúc → prompt cho model sinh ảnh/video (spec visual-grounding).
 *
 * Trước đây agent đưa thẳng một prompt tự do cho Veo, và ảnh/video ra lạc đề:
 * không có gì buộc prompt bám câu người nói. Giờ agent điền brief (câu trích,
 * ý, chủ thể, hành động, bối cảnh, phong cách…), server kiểm câu trích có thật
 * trong transcript rồi ghép prompt theo một khuôn. Thuần — không gọi mạng —
 * nên test được bằng snapshot.
 *
 * Câu trích KHÔNG vào prompt: model ảnh/video thấy chữ là vẽ chữ ra hình.
 */

import { z } from "zod";

export const STYLES = ["photo", "cinematic", "3d-render", "illustration", "flat"] as const;
export const CAMERAS = ["static", "slow push-in", "slow pull-out", "pan left", "pan right", "orbit", "handheld", "top-down"] as const;

export const briefShape = {
  quote: z.string().trim().min(2).max(300).describe("The exact words from <clip_context> this media illustrates."),
  idea: z.string().trim().min(3).max(300).describe("What the viewer should understand from the picture, in one sentence."),
  subject: z.string().trim().min(2).max(200).describe("The main thing in the frame: a concrete person, object or place."),
  action: z.string().trim().max(200).optional().describe("What the subject does (video: the motion)."),
  setting: z.string().trim().max(200).optional().describe("Where it happens, time of day, surroundings."),
  style: z.enum(STYLES).optional().describe("Keep the same style for every shot in a clip."),
  camera: z.enum(CAMERAS).optional().describe("Video only: the camera move."),
  mood: z.string().trim().max(100).optional().describe("Lighting and feeling, e.g. warm morning light, tense, calm."),
  avoid: z.array(z.string().trim().min(1).max(80)).max(8).optional().describe("Things that must not appear."),
};

export type Brief = {
  quote: string;
  idea: string;
  subject: string;
  action?: string;
  setting?: string;
  style?: (typeof STYLES)[number];
  camera?: (typeof CAMERAS)[number];
  mood?: string;
  avoid?: string[];
};

const STYLE_TEXT: Record<(typeof STYLES)[number], string> = {
  photo: "Photorealistic photograph, natural colors, sharp focus, shallow depth of field.",
  cinematic: "Cinematic film still, dramatic but natural lighting, rich color grading, 35mm lens.",
  "3d-render": "Clean 3D render, soft studio lighting, smooth materials, subtle shadows, minimal background.",
  illustration: "Editorial illustration, bold simple shapes, limited color palette, clean lines.",
  flat: "Flat vector illustration, solid colors, simple geometric shapes, minimal detail.",
};

/**
 * Brief xin một thứ model sinh làm hỏng (sơ đồ, biểu đồ, chữ, con số): trả
 * câu gợi ý tool vẽ sẵn của editor; null khi brief ổn.
 */
const MISUSE = /\b(diagrams?|charts?|graphs?|infographics?|flow ?charts?|formulas?|equations?|statistics?|percent(age)?s?|numbers?|labels?|captions?|titles?|text|words?|letters?|timeline|steps? \d|explainer|3d (explanation|visual|diagram))\b/i;

export function briefMisuse(brief: Pick<Brief, "idea" | "subject" | "action">): string | null {
  const text = [brief.subject, brief.action ?? ""].join(" ");
  if (!MISUSE.test(text)) return null;
  return "AI images and video get diagrams, charts, numbers and text wrong. Draw it instead with add_diagram, add_chart, add_graph, add_3d, add_icon or add_text (pass the same quote); use generate_media only for a concrete real-world scene.";
}

const sentence = (text: string): string => {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  const capital = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

/** Prompt cuối theo khuôn của từng loại, trong trần ký tự của model. */
export function composePrompt(brief: Brief, kind: "image" | "video", options: { maxChars: number; aspectRatio?: string; duration?: number }): string {
  const style = brief.style ?? (kind === "video" ? "cinematic" : "photo");
  const vertical = (options.aspectRatio ?? "9:16") === "9:16";
  const parts = [
    sentence(`${brief.subject}${brief.action ? `, ${brief.action}` : ""}${brief.setting ? `, ${brief.setting}` : ""}`),
    sentence(`The shot conveys: ${brief.idea}`),
    brief.mood ? sentence(`Mood: ${brief.mood}`) : "",
    STYLE_TEXT[style],
    kind === "video"
      ? sentence(`Camera: ${brief.camera ?? "slow push-in"}; one continuous shot${options.duration ? ` of about ${options.duration} seconds` : ""}, smooth natural motion`)
      : "",
    vertical ? "Vertical 9:16 composition: main subject in the upper two thirds, calm lower third (captions go there)." : "",
    `No text, letters, numbers, captions, logos, watermarks or UI in the frame${brief.avoid?.length ? `; also avoid: ${brief.avoid.join(", ")}` : ""}.`,
  ].filter(Boolean);
  let prompt = parts.join(" ");
  // Trần của model: bỏ bớt từ phần giữa (mood, style chi tiết) chứ không cắt mất phần "No text".
  if (prompt.length > options.maxChars) {
    const essential = [parts[0], parts.at(-1)].join(" ");
    prompt = essential.length <= options.maxChars ? essential : essential.slice(0, options.maxChars);
  }
  return prompt;
}
