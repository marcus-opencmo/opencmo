/**
 * Skill của người dùng cho Assistant (học Palmier §A8): "công thức edit" họ muốn
 * agent nhớ — hook kiểu X, phụ đề kiểu Y, nhịp cắt Z. Prompt chỉ mang MỤC LỤC (tên +
 * một câu); thân đọc khi cần bằng `read_skill`. Agent lưu bằng `save_skill` khi
 * người dùng bảo nhớ cách làm, như Palmier `manage_skills`. Bảng `editor_skills`,
 * ghi qua RPC (migration 20261017090000).
 */

import { z } from "zod";

import { rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";

import { spec, type ToolOutcome } from "./tools";

const name = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$/, "Use letters, numbers and hyphens, like hook-style.");
export const readSkillInput = z.object({ name });
export const saveSkillInput = z.object({
  name,
  description: z.string().trim().min(1).max(300).describe("One line: when to use it. Shown in your skill index."),
  body: z.string().min(1).max(50_000).describe("The recipe: concrete steps, values and tools to use."),
});

export const SKILL_TOOLS = new Set(["read_skill", "save_skill"]);

export const SKILL_SPECS = [
  spec("read_skill", "Read one of the user's saved editing skills (recipes they asked you to remember), by name from <your_skills>. Read it before doing the kind of edit it describes.", readSkillInput),
  spec(
    "save_skill",
    "Save an editing recipe the user wants you to reuse on future clips (\"remember this style\", \"always do my hooks like this\"). Saving under an existing name replaces it. Only when the user asks you to remember or save something.",
    saveSkillInput,
  ),
];

/** Mục lục cho khối ngữ cảnh: không có skill thì chuỗi rỗng (không tốn token). */
export async function skillIndex(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase.from("editor_skills").select("name, description").order("name").limit(50);
  const rows = (data ?? []) as { name: string; description: string }[];
  if (!rows.length) return "";
  return `<your_skills>${JSON.stringify(rows)}</your_skills>`;
}

export async function runSkillTool(supabase: SupabaseClient, call: { name: string; input: unknown }): Promise<ToolOutcome> {
  if (call.name === "read_skill") {
    const parsed = readSkillInput.safeParse(call.input);
    if (!parsed.success) return { ok: false, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues[0]?.message }), summary: "Could not read the skill" };
    const { data } = await supabase.from("editor_skills").select("name, description, body").eq("name", parsed.data.name.toLowerCase()).maybeSingle();
    if (!data) return { ok: false, content: JSON.stringify({ error: `No skill named ${parsed.data.name}.` }), summary: "Skill not found" };
    // Thân skill do người dùng viết: dữ liệu, không phải chỉ thị hệ thống.
    return { ok: true, content: JSON.stringify({ untrusted_data: data }), summary: `Read the skill ${data.name}` };
  }
  const parsed = saveSkillInput.safeParse(call.input);
  if (!parsed.success) return { ok: false, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues[0]?.message }), summary: "Could not save the skill" };
  const saved = await rpcOrThrow<{ name: string }>(supabase, "save_editor_skill", {
    p_name: parsed.data.name,
    p_description: parsed.data.description,
    p_body: parsed.data.body,
  });
  return { ok: true, content: JSON.stringify({ saved: saved.name }), summary: `Saved the skill ${saved.name}` };
}
