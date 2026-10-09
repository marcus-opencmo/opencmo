/**
 * Model GIẢ: kịch bản cố định theo câu lệnh, cùng giao diện `Provider`. Để
 * contract check và E2E chạy trọn vòng lặp — tool server, tool trình duyệt,
 * CAS, checkpoint, credit, SSE, Undo — mà không tốn tiền, không cần mạng.
 * Lịch sử ở dạng content block của Claude (`anthropicFormat`).
 *
 * Kịch bản:
 *   "check" + "square" → set_frame 1080×1080 VÀ capture [1] cùng bước
 *   "check"            → capture [1, 2]
 *   "ask"              → ask_user (lượt chờ câu trả lời) → nhắc lại câu trả lời
 *   "silence"/"pause"  → find_silences → remove_ranges các gợi ý cắt
 *   "plan"             → update_plan → add_text
 *   "library"          → list_library → insert_asset (video đầu tiên) → capture
 *   "listen"           → media_waveform
 *   "lint"             → check + read_guide cùng bước
 *   "expensive"        → một bước báo usage rất lớn (đường hết credit giữ)
 *   "export"           → request_export 9:16 + bản 1:1 (thẻ duyệt, không tốn credit)
 *   "voice-over"       → generate_media voice (thẻ duyệt có giá)
 *   "b-roll shot"      → generate_media video: brief theo câu trích trong câu lệnh
 *   "save a frame"     → save_frame (tool tab: frame không chữ vào thư mục Frames)
 *   "square then undo" → set_frame 1080×1080 → undo (về như trước yêu cầu này)
 *   "cinematic"        → get_project_state → apply_color look ấm cho mọi video (E3)
 *   "side by side with" → list_library → insert_asset → apply_layout side_by_side: người nói trái, B-roll phải (E5)
 *   "feedback"         → send_feedback (báo giới hạn, diễn đạt lại bằng tiếng Anh)
 *   "generate b-roll:" → starter B-roll: nhiều generate_media image trong MỘT lượt (một thẻ duyệt)
 *   "generate"/"b-roll" → generate_media image: brief theo một dòng của <clip_context>
 *   "3d visual"        → update_plan + preview_3d (cảnh code: cột nhân đôi, neo "growing") → add_3d_scene
 *   "repurpose"        → add_voiceover replace: kịch bản mới từ hai dòng đầu (thẻ duyệt có giá)
 *   "3d studio"/"3d animation" → preview_3d (cảnh code: số đếm lên, con số của câu trích) → add_3d_scene (thẻ duyệt có giá)
 *   "more visual"      → update_plan → add_icon + add_diagram neo bằng quote
 *   "square"/"1:1"     → set_frame 1080×1080
 *   "vertical"/"9:16"  → set_frame 1080×1920
 *   "filler"           → find_filler_words → remove_words các id tìm được
 *   "title"            → add_text
 *   "broken"           → set_frame với input sai (đường lỗi của tool)
 *   "diagram"          → add_diagram hai bước lúc câu "start with the result…" (16–21s mẫu)
 *   "stat"             → add_chart stat 3 lúc "first three seconds" (14–17s mẫu)
 *   "split the screen" → set_layout split-bottom 16–21s → add_diagram cùng khoảng (tự vào panel)
 *   "icon"             → find_icons → add_icon trending-up lúc "growing" (1.5–4s mẫu)
 *   "emoji"            → find_lotties → add_lottie emoji/scream neo quote "people lose viewers"
 *   còn lại            → trả lời bằng chữ
 * Sau tool_result: ảnh thì đếm và nói số ảnh đã xem; còn lại một câu kết.
 */

import { anthropicFormat } from "./anthropic";
import type { Delta, Provider, Step, StepRequest, StoredMessage, ToolCall } from "./types";

let counter = 0;
const id = (): string => `toolu_fake_${Date.now().toString(36)}${(counter++).toString(36)}`;

type Block = { type: string; text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown; source?: unknown };

const text = (value: string) => ({ type: "text", text: value, citations: null });

/** Cảnh code mẫu (spec code-scenes). Câu trích nằm ở dòng đầu để bước sau đọc lại. */
function sceneCode(quote: string, body: string): string {
  return `// quote: ${quote.replace(/\n/g, " ")}\n${body}`;
}
const quoteOf = (code: string): string => /^\/\/ quote: (.*)$/m.exec(code)?.[1] ?? "";
const use = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: id(), name, input });

function script(history: StoredMessage[]): unknown[] {
  const user = [...history].reverse().find((message) => message.role === "user");
  const blocks = (user?.content ?? []) as Block[];
  const results = blocks.filter((block) => block.type === "tool_result");

  if (results.length) {
    const assistant = [...history].reverse().find((message) => message.role === "assistant");
    const previous = anthropicFormat.callsIn(assistant?.content ?? []).map((call) => call.name);
    const raw0 = typeof results[0]!.content === "string" ? (results[0]!.content as string) : "{}";
    // Câu lệnh của lượt: tin nhắn người dùng gần nhất có lời (không phải tool_result).
    const asked = [...history]
      .reverse()
      .map((message) => ((message.role === "user" ? message.content : []) as Block[]).filter((block) => block.type === "text").map((block) => block.text ?? "").join(" "))
      // Sau lượt ghi, tin nhắn tool_result kèm khối <project_state>: bỏ, chỉ giữ lời người dùng.
      .map((value) => value.split(/<clip_context>|<project_state>|<check>/)[0]!)
      .find((value) => value.trim())
      ?.toLowerCase() ?? "";
    if (previous.includes("set_frame") && /then undo/.test(asked)) return [text("On second thought, undoing that."), use("undo", {})];
    if (previous.includes("undo")) return [text(raw0.includes('"changed":true') ? "Undone: the clip is back to how it was." : "There was nothing to undo.")];
    if (previous.includes("send_feedback")) return [text("I sent that to the OpenCMO team.")];
    if (previous.includes("get_project_state") && /cinematic/.test(asked)) {
      const ids = [...raw0.matchAll(/\\?"id\\?":\\?"([^"\\]+)\\?",\\?"tag\\?":\\?"video/g)].map((match) => match[1]!);
      return [
        text("Grading every shot warm and cinematic."),
        use("apply_color", {
          element_ids: ids,
          adjustments: { wheels: { gain: [0.06, 0.02, -0.04], lift: [-0.02, 0, 0.03] }, contrast: 0.2, saturation: -0.1, grain: 0.15, vignette: { amount: 0.3 } },
        }),
      ];
    }
    if (previous.includes("apply_color")) return [text(results.some((block) => block.is_error) ? "The grade could not be applied." : "The clip now has a warm cinematic grade.")];
    if (previous.includes("ask_user")) {
      const parsed = JSON.parse(raw0) as { user_answer?: { choices?: string[]; text?: string }; skipped?: boolean };
      if (parsed.skipped) return [text("No problem, I'll keep it as it is.")];
      return [text(`You chose: ${[...(parsed.user_answer?.choices ?? []), parsed.user_answer?.text].filter(Boolean).join(", ")}.`)];
    }
    if (previous.includes("preview_3d")) {
      const call = anthropicFormat.callsIn(assistant?.content ?? []).find((item) => item.name === "preview_3d");
      const code = String((call?.input as { code?: string } | undefined)?.code ?? "");
      const parsed = JSON.parse(raw0) as { ok?: boolean; error?: string; layout?: { issues?: string[] }[] };
      if (!parsed.ok) return [text(`The 3D preview failed: ${parsed.error ?? "unknown error"}`)];
      return [use("add_3d_scene", { title: "Hero moment", code, quote: quoteOf(code) })];
    }
    if (previous.includes("find_silences")) {
      const cuts = ((JSON.parse(raw0) as { silences?: Array<{ cut: { start: number; end: number } | null }> }).silences ?? [])
        .map((item) => item.cut)
        .filter((cut): cut is { start: number; end: number } => Boolean(cut));
      return cuts.length ? [use("remove_ranges", { ranges: cuts })] : [text("There are no long pauses to cut.")];
    }
    if (previous.includes("update_plan")) return [use("add_text", { text: "Watch this", start: 0, end: 3 })];
    if (/side by side with/.test(asked) && previous.includes("list_library")) {
      const assets = (JSON.parse(raw0) as { untrusted_data?: { assets?: Array<{ path: string; type: string; role?: string }> } }).untrusted_data?.assets ?? [];
      const media = assets.find((asset) => !asset.role && (asset.type === "VIDEO" || asset.type === "IMAGE"));
      return media ? [use("insert_asset", { path: media.path, start: 1, end: 6 })] : [text("The library has no B-roll yet.")];
    }
    if (/side by side with/.test(asked) && previous.includes("insert_asset") && !results.some((block) => block.is_error)) {
      // Id lấy từ <project_state> đi kèm kết quả ghi: video của clip và rect B-roll vừa thêm.
      const state = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join(" ");
      const master = /"id":"([^"]+)","tag":"video"[^}]*"assets\/master\.mp4"/.exec(state)?.[1];
      const added = [...state.matchAll(/"id":"([^"]+)","tag":"rect"/g)].at(-1)?.[1];
      if (!master || !added) return [text("I could not find the clip video and the new B-roll.")];
      return [use("apply_layout", { layout: "side_by_side", slots: [{ slot: "left", element_ids: [master] }, { slot: "right", element_ids: [added] }] })];
    }
    // F2: phụ đề tốn credit qua thẻ duyệt — tìm phần tử trong get_document rồi gọi tool.
    if (/caption the b-?roll|translate the captions/.test(asked) && previous.includes("get_document")) {
      const found: Record<string, unknown>[] = [];
      const visit = (value: unknown) => {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") {
          found.push(value as Record<string, unknown>);
          Object.values(value).forEach(visit);
        }
      };
      visit(JSON.parse(raw0));
      if (/translate/.test(asked)) {
        const layer = found.find((node) => node.kind === "captions" && typeof node.src === "string" && node.src.startsWith("assets/transcripts/"));
        return layer ? [use("translate_captions", { element_id: layer.id, language: "Spanish" })] : [text("There are no saved captions to translate.")];
      }
      const broll = found.find((node) => node.kind === "rect" && Array.isArray(node.paints) && (node.paints as { type?: string }[]).some((paint) => paint.type === "video"));
      return broll ? [use("add_captions", { element_id: broll.id })] : [text("There is no B-roll video to caption.")];
    }
    if (previous.includes("add_captions") || previous.includes("translate_captions")) {
      return [text(results.some((block) => block.is_error) || /"declined"|"error"|"pending"/.test(raw0) ? "The captions were not added." : "Done: the new captions layer is on the timeline.")];
    }
    if (previous.includes("apply_layout")) return [text(results.some((block) => block.is_error) ? "The layout could not be applied." : "The speaker and the B-roll are side by side now.")];
    if (previous.includes("list_library")) {
      const assets = (JSON.parse(raw0) as { untrusted_data?: { assets?: Array<{ path: string; type: string; role?: string }> } }).untrusted_data?.assets ?? [];
      const video = assets.find((asset) => !asset.role && (asset.type === "VIDEO" || asset.type === "IMAGE"));
      return video ? [use("insert_asset", { path: video.path, start: 1, end: 3 })] : [text("The library has no B-roll yet.")];
    }
    if (previous.includes("insert_asset") && !results.some((block) => block.is_error)) return [use("capture", { times: [2] })];
    if (previous.includes("media_waveform")) return [text("I listened to the clip.")];
    if (previous.includes("find_filler_words")) {
      const raw = typeof results[0]!.content === "string" ? (results[0]!.content as string) : "{}";
      const ids = ((JSON.parse(raw) as { untrusted_data?: { suggestions?: Array<{ id?: string }> } }).untrusted_data
        ?.suggestions ?? [])
        .map((item) => item.id)
        .filter((value): value is string => Boolean(value));
      if (ids.length) return [use("remove_words", { word_ids: ids })];
    }
    const images = results.flatMap((block) =>
      Array.isArray(block.content) ? (block.content as Block[]).filter((item) => item.type === "image") : [],
    ).length;
    if (previous.includes("request_export")) {
      const raw = typeof results[0]!.content === "string" ? (results[0]!.content as string) : "{}";
      const parsed = JSON.parse(raw) as { declined?: boolean; ok?: boolean; error?: string; INVALID_INPUT?: string };
      if (parsed.declined) return [text("Okay, nothing was exported.")];
      if (parsed.ok) return [text("Your files are rendering. Each one gets a Download button here when it's ready.")];
      return [text(`That didn't work: ${parsed.error ?? parsed.INVALID_INPUT ?? "unknown error"}`)];
    }
    if (previous.includes("generate_media") || previous.includes("add_3d_scene") || previous.includes("add_voiceover")) {
      const raw = typeof results[0]!.content === "string" ? (results[0]!.content as string) : "{}";
      const parsed = JSON.parse(raw) as { declined?: boolean; ok?: boolean; error?: string; INVALID_INPUT?: string };
      if (parsed.declined) return [text("Okay, I didn't create anything.")];
      if (parsed.ok) return [text("It's being generated now and will appear on the clip when it's ready.")];
      return [text(`That didn't work: ${parsed.error ?? parsed.INVALID_INPUT ?? "unknown error"}`)];
    }
    if (previous.includes("save_frame")) {
      // Kết quả có ảnh: content là mảng (khối chữ + khối ảnh), JSON nằm ở khối chữ.
      const content = results[0]!.content;
      const raw =
        typeof content === "string"
          ? content
          : ((content as Block[]).find((item) => item.type === "text")?.text ?? "{}");
      const parsed = JSON.parse(raw) as { path?: string; error?: string };
      return [text(parsed.path ? `Saved the frame as ${parsed.path}.` : `That didn't work: ${parsed.error ?? "unknown error"}`)];
    }
    if (previous.includes("capture")) {
      return [text(images ? `I looked at ${images} ${images === 1 ? "frame" : "frames"}: the speaker is in frame.` : "I could not see the frames.")];
    }
    const failed = results.some((block) => block.is_error);
    return [text(failed ? "That did not work — nothing was changed." : "Done. You can undo this in one click.")];
  }

  const original = blocks.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join(" ");
  const prompt = original.toLowerCase();
  // Chỉ câu lệnh, không phải khối <clip_context>/<project_state> đi kèm.
  const ask = prompt.split(/<clip_context>|<project_state>/)[0]!;
  // Dòng kịch bản trong <clip_context>: model thật đọc chúng để chọn câu trích.
  const lines = [...original.matchAll(/\[[\d.]+–[\d.]+\] ([^\n<]+)/g)].map((match) => match[1]!.trim());
  const lineWith = (word: string) => lines.find((line) => line.toLowerCase().includes(word)) ?? lines[1] ?? lines[0] ?? "";
  const quoted = /'([^']{4,})'/.exec(original.split(/<clip_context>|<project_state>/)[0]!)?.[1];
  // Trước "square": "export it, also as a square copy" là một lượt export, không phải đổi khung.
  if (/\bexport/.test(ask)) {
    return [text("Exporting it, with a square copy for the feed."), use("request_export", { frames: ["9:16", "1:1"] })];
  }
  if (/feedback/.test(ask)) {
    return [
      text("I can't do that yet, so I'm reporting it."),
      use("send_feedback", { category: "missing_capability", summary: "User asked for a feature the editor does not have yet.", severity: "low" }),
    ];
  }
  if (/check/.test(ask) && /square/.test(ask)) {
    return [text("Making it square, then checking the frame."), use("set_frame", { width: 1080, height: 1080 }), use("capture", { times: [1] })];
  }
  if (/check/.test(ask)) return [text("Let me look at the clip."), use("capture", { times: [1, 2] })];
  if (/\bask\b/.test(ask)) {
    return [use("ask_user", { question: "Which caption style do you want?", options: ["Classic", "Spotlight"], multi: false })];
  }
  if (/silence|pause/.test(ask)) return [text("Looking for long pauses."), use("find_silences", {})];
  if (/\bplan\b/.test(ask)) {
    return [use("update_plan", { items: [{ text: "Add a hook title", status: "active" }, { text: "Check the frame", status: "pending" }] })];
  }
  if (/library/.test(ask)) return [use("list_library", {})];
  if (/listen/.test(ask)) return [use("media_waveform", {})];
  if (/lint/.test(ask)) return [use("check", {}), use("read_guide", { name: "workflow" })];
  if (/expensive/.test(ask)) return [text("Working hard."), use("get_project_state", {})];
  if (/caption the b-?roll|translate the captions/.test(ask)) return [text("Finding the layer."), use("get_document", {})];
  if (/square|1:1/.test(ask)) return [text("Switching the clip to a square frame."), use("set_frame", { width: 1080, height: 1080 })];
  if (/vertical|9:16/.test(ask)) return [text("Switching back to vertical."), use("set_frame", { width: 1080, height: 1920 })];
  if (/repurpose/.test(ask)) {
    // Kịch bản MỚI (không chép câu người nói): nhắc lại ý bằng lời của mình.
    const topic = (lines[0] ?? "this idea").split(" ").slice(0, 6).join(" ").replace(/[.,!?]+$/, "");
    const script = `Here is the short version. ${topic}: that is the whole point. Try it today and see what changes.`;
    return [text("I'll replace the voice with a new script."), use("add_voiceover", { text: script, voice: "Test A", mode: "replace" })];
  }
  if (/voice-?over|narrat/.test(ask)) {
    return [text("I'll add a voice-over."), use("generate_media", { kind: "voice", prompt: "Welcome back. Here is the one habit that changed everything." })];
  }
  if (/b-roll shot/.test(ask)) {
    // Brief từ câu người nói, không phải chủ đề tự nghĩ ra.
    return [
      text("I'll brief an AI shot for that line."),
      use("generate_media", {
        kind: "video",
        quote: quoted ?? lineWith("numbers"),
        idea: "results start to grow once the hook works",
        subject: "a creator watching the view counter climb on a phone",
        action: "smiling as the phone lights up",
        setting: "a small home studio at night",
        style: "cinematic",
        camera: "slow push-in",
      }),
    ];
  }
  if (/save a frame/.test(ask)) return [text("Saving a clean frame to the library."), use("save_frame", { time: 1, name: "before-cut" })];
  if (/generate b-roll:/.test(ask)) {
    // Starter B-roll (guide broll): bỏ câu đầu (hook) và câu cuối, ảnh tĩnh trước, cùng một lượt.
    let picks = lines.slice(1, -1).filter((line) => line.split(" ").length >= 4).slice(0, 3);
    // Clip rất ngắn (một dòng): tách đôi câu dài thành hai shot, cả hai vẫn là lời có thật.
    if (picks.length < 2) {
      const words = (lines.find((line) => line.split(" ").length >= 6) ?? "").split(" ");
      if (words.length >= 6) picks = [words.slice(0, Math.floor(words.length / 2)).join(" "), words.slice(Math.floor(words.length / 2)).join(" ")];
    }
    return [
      text(`I'll start with ${picks.length} stills; you approve them together.`),
      ...picks.map((line) =>
        use("generate_media", {
          kind: "image",
          quote: line.split(" ").slice(0, 6).join(" "),
          idea: "show what the speaker talks about",
          subject: "a creator at a desk with a phone and a notebook",
          setting: "a bright home office",
          style: "photo",
          length: 2.5,
        }),
      ),
    ];
  }
  if (/generate|create an image|b-roll/.test(ask)) {
    const quote = lineWith("hooks").split(" ").slice(0, 8).join(" ");
    return [
      text("I'll create an image for this clip."),
      use("generate_media", { kind: "image", quote, idea: "a strong opening grabs attention", subject: "a person stopping mid-scroll on their phone", setting: "a busy street", style: "photo" }),
    ];
  }
  if (/3d studio|premium 3d|3d animation/.test(ask)) {
    // Con số của câu được trích (chữ số hoặc số viết bằng chữ) — không bịa số.
    const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const line = quoted ?? lines.find((item) => /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(item)) ?? lines[0] ?? "";
    const token = /(\d[\d,.]*)|\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/i.exec(line);
    const value = token?.[1] ? Number(token[1].replace(/,/g, "")) : NUMBERS[(token?.[2] ?? "three").toLowerCase()]!;
    const quote = line.split(" ").slice(0, 6).join(" ");
    const code = sceneCode(
      quote,
      `const counter = kit.counter(${value}, { size: 1.2 });\nkit.label('seconds to hook', { size: 0.3, at: counter.mesh, lift: 0.3 });\nreturn (t) => { counter.set(kit.phase(t, 0.3, 1.8)); kit.frame({ yaw: 8 + 6 * t / 4, push: t / 4 }); };`,
    );
    return [
      use("update_plan", { items: [{ text: `'${quote}' → 3D number counting up to ${value}`, status: "active" }] }),
      use("preview_3d", { code, duration: 4, aspect_ratio: "1:1" }),
    ];
  }
  if (/3d visual/.test(ask)) {
    // Câu chứa từ khoá dài nhất của câu lệnh ("habits", "growing"…), vài từ đầu làm quote.
    const keys = ask.split(/[^a-z]+/).filter((word) => word.length > 4 && !["visual", "explains", "about", "compounds"].includes(word));
    const key = keys.map((word) => word.replace(/s$/, "")).find((word) => lines.some((item) => item.toLowerCase().includes(word))) ?? "growing";
    const line = lines.find((item) => item.toLowerCase().includes(key)) ?? lineWith("growing");
    const words = line.split(" ");
    const at = Math.max(0, words.findIndex((word) => word.toLowerCase().includes(key)));
    const quote = words.slice(at, at + 4).join(" ");
    const code = sceneCode(
      quote,
      "const bars = kit.bars([1, 2, 4, 8], { showValues: false });\nkit.label('Compounds', { size: 0.4, at: bars.group, lift: 0.7 });\nreturn (t) => { bars.grow(kit.phase(t, 0.2, 2.2)); kit.frame({ yaw: 12 + t, push: t / 4 }); };",
    );
    return [
      use("update_plan", { items: [{ text: `'${quote}' → 3D bars doubling`, status: "active" }] }),
      use("preview_3d", { code, duration: 4, aspect_ratio: "1:1" }),
    ];
  }
  if (/more visual/.test(ask)) {
    return [
      use("update_plan", { items: [{ text: "[6s] 'better hooks' → icon", status: "active" }, { text: "[16s] 'start with the result' → diagram", status: "pending" }] }),
      use("add_icon", { quote: "you need better hooks", name: "fish", motion: "pop" }),
      use("add_diagram", { quote: "start with the result then show how you got there", nodes: [{ label: "Result" }, { label: "How you got there" }], layout: "column" }),
    ];
  }
  if (/side by side with/.test(ask)) return [text("Looking for B-roll."), use("list_library", {})];
  if (/cinematic/.test(ask)) return [text("Reading the project first."), use("get_project_state", {})];
  if (/filler/.test(ask)) return [text("Looking for filler words."), use("find_filler_words", {})];
  if (/title/.test(ask)) return [use("add_text", { text: "Watch this", start: 0, end: 3 })];
  if (/broken/.test(ask)) return [use("set_frame", { width: 5, height: 1080 })];
  if (/split the screen/.test(ask)) {
    return [
      use("set_layout", { mode: "split-bottom", start: 16, end: 21.5 }),
      use("add_diagram", { nodes: [{ label: "Start with the result" }, { label: "Show how you got there" }], layout: "column", start: 16.2, end: 21 }),
    ];
  }
  if (/\bemoji\b/.test(ask)) {
    return [use("find_lotties", { query: "shock scared lose" }), use("add_lottie", { animation: "emoji/scream", size: 0.25, quote: "people lose viewers" })];
  }
  if (/\bicon\b/.test(ask)) return [use("find_icons", { query: "growth" }), use("add_icon", { name: "trending-up", motion: "pop", start: 2.2, end: 4.5 })];
  if (/diagram/.test(ask)) {
    return [use("add_diagram", { nodes: [{ label: "Start with the result" }, { label: "Show how you got there" }], layout: "column", start: 16, end: 21 })];
  }
  if (/\bstat\b/.test(ask)) {
    return [use("add_chart", { type: "stat", data: [{ label: "seconds to hook them", value: 3 }], start: 14, end: 17 })];
  }
  return [text("I can change the frame, captions, cuts and text on this clip.")];
}

/**
 * Kịch bản trang project:
 *   "style"/"caption" → list_clips → apply_to_clips(mọi clip, set_caption_style classic #FFD400)
 *   "hook"            → list_clips → trả lời bằng chữ
 *   còn lại           → trả lời bằng chữ
 * Sau thẻ duyệt: đọc kết quả, nói bao nhiêu clip đã đổi (hoặc bị từ chối).
 */
function projectScript(history: StoredMessage[]): unknown[] {
  const user = [...history].reverse().find((message) => message.role === "user");
  const blocks = (user?.content ?? []) as Block[];
  const results = blocks.filter((block) => block.type === "tool_result");
  // Câu lệnh của lượt: tin nhắn user gần nhất không phải kết quả tool.
  const promptMessage = [...history]
    .reverse()
    .find((message) => message.role === "user" && !(message.content as Block[]).some((block) => block.type === "tool_result"));
  const turnPrompt = ((promptMessage?.content ?? []) as Block[])
    .map((block) => block.text ?? "")
    .join(" ")
    .split("<project_state>")[0]!
    .toLowerCase();

  if (results.length) {
    const assistant = [...history].reverse().find((message) => message.role === "assistant");
    const previous = anthropicFormat.callsIn(assistant?.content ?? []).map((call) => call.name);
    const raw = typeof results[0]!.content === "string" ? (results[0]!.content as string) : "{}";
    if (previous.includes("list_clips")) {
      const clips = (JSON.parse(raw) as { untrusted_data?: { clips?: Array<{ id: string; hook: string | null; number: number }> } }).untrusted_data?.clips ?? [];
      if (/hook/.test(turnPrompt)) {
        const best = clips[0];
        return [text(best ? `Clip ${best.number} has the strongest hook: "${best.hook ?? ""}".` : "This project has no clips yet.")];
      }
      return [
        text(`Applying the caption style to ${clips.length} clips.`),
        use("apply_to_clips", {
          clip_ids: clips.map((clip) => clip.id),
          ops: [{ op: "set_caption_style", preset: "classic", colors: ["#FFD400"] }],
        }),
      ];
    }
    if (previous.includes("apply_to_clips")) {
      const parsed = JSON.parse(raw) as { declined?: boolean; results?: Array<{ ok: boolean }> };
      if (parsed.declined) return [text("Okay, I left the clips as they were.")];
      const done = (parsed.results ?? []).filter((item) => item.ok).length;
      return [text(`Updated ${done} of ${(parsed.results ?? []).length} clips.`)];
    }
    return [text("Done.")];
  }

  if (/style|caption|hook/.test(turnPrompt)) return [text("Reading the clips."), use("list_clips", {})];
  return [text("I can change captions, frames and text across the clips in this project.")];
}

/**
 * Kịch bản CMO chat (scope `cmo`, nhận ra nhờ tool `create_task`):
 *   "research"        → search_reddit → create_task sales (brief kèm URL đầu tiên)
 *   "clip"/"video"    → create_task video (mục lịch có nút Make clips)
 *   "plan"            → create_task planner
 *   "draft"/"post"    → create_task x_writer
 *   "calendar"        → list_calendar → nói số mục
 *   "remember"        → remember (phần sau chữ "remember")
 *   còn lại           → trả lời bằng chữ
 */
function cmoScript(history: StoredMessage[]): unknown[] {
  const user = [...history].reverse().find((message) => message.role === "user");
  const blocks = (user?.content ?? []) as Block[];
  const results = blocks.filter((block) => block.type === "tool_result");
  if (results.length) {
    const assistant = [...history].reverse().find((message) => message.role === "assistant");
    const previous = anthropicFormat.callsIn(assistant?.content ?? []).map((call) => call.name);
    const raw = typeof results[0]!.content === "string" ? (results[0]!.content as string) : "{}";
    if (previous.includes("search_reddit")) {
      const posts = (JSON.parse(raw) as { untrusted_data?: { url?: string }[] }).untrusted_data ?? [];
      return [
        text(`I found ${posts.length} Reddit posts about this. Handing it to the Sales agent.`),
        use("create_task", { agent: "sales", brief: `People asking for help with this, e.g. ${posts[0]?.url ?? "Reddit"}`, when: "now" }),
      ];
    }
    if (previous.includes("create_task")) {
      const parsed = JSON.parse(raw) as { started?: boolean; scheduled?: boolean; day?: string; error?: string };
      if (parsed.scheduled) return [text(`Added to your calendar for ${parsed.day}. Open it there to make the clips from your own video.`)];
      if (!parsed.started) return [text(`I could not start that: ${parsed.error ?? "unknown error"}`)];
      return [text("On it. The result will show up in the app within a minute, and nothing goes out until you approve it.")];
    }
    if (previous.includes("list_calendar")) {
      const items = (JSON.parse(raw) as { untrusted_data?: { items?: unknown[] } }).untrusted_data?.items ?? [];
      return [text(`You have ${items.length} items on your calendar for the next two weeks.`)];
    }
    if (previous.includes("remember")) return [text("Noted. I will use that in every plan and draft.")];
    return [text("Done.")];
  }
  const ask = blocks.map((block) => block.text ?? "").join(" ").split("<documents>")[0]!.split("<cmo_state>")[0]!;
  const lower = ask.toLowerCase();
  if (/remember/.test(lower)) return [use("remember", { note: ask.replace(/^.*?remember( that)?:?\s*/i, "").trim().slice(0, 200) || ask.trim() })];
  if (/research/.test(lower)) return [text("Looking at Reddit first."), use("search_reddit", { query: "late invoices" })];
  if (/clip|video/.test(lower)) return [text("Adding a video task."), use("create_task", { agent: "video", brief: "Clips about how you onboard a new client", clips: 3, clip_length: "short" })];
  if (/reddit/.test(lower)) return [text("Scanning Reddit for people who need this."), use("create_task", { agent: "sales", brief: "People who struggle with the problem we solve", when: "now" })];
  if (/plan/.test(lower)) return [text("Planning your week."), use("create_task", { agent: "planner", brief: "A balanced week from the content strategy", when: "now" })];
  if (/draft|post/.test(lower)) return [text("Drafting a post for X."), use("create_task", { agent: "x_writer", brief: "A post from the content strategy", when: "now" })];
  if (/calendar/.test(lower)) return [use("list_calendar", {})];
  return [text("I know your product from your documents. Ask me to plan the week or draft a post for X.")];
}

export const fakeProvider: Provider = {
  kind: "fake",
  model: "fake",
  ...anthropicFormat,
  failureMessage: () => "Something went wrong. Please try again.",
  async step({ history, tools }: StepRequest, onDelta: (delta: Delta) => void): Promise<Step> {
    const project = tools.some((tool) => tool.name === "apply_to_clips");
    const cmo = tools.some((tool) => tool.name === "create_task");
    const content = [
      { type: "thinking", thinking: "Deciding which tool fits.", signature: "fake" },
      ...(cmo ? cmoScript(history) : project ? projectScript(history) : script(history)),
    ];
    onDelta({ type: "thinking", text: "Deciding which tool fits." });
    for (const block of content as Array<{ type: string; text?: string; id?: string; name?: string }>) {
      if (block.type === "text") onDelta({ type: "text", text: block.text! });
      if (block.type === "tool_use") onDelta({ type: "tool_start", id: block.id!, name: block.name! });
    }
    const calls: ToolCall[] = anthropicFormat.callsIn(content);
    // "expensive": ~$10 trong một bước — vượt phần giữ 5 credit, lượt phải dừng chờ gia hạn.
    const expensive = calls.some((call) => call.name === "get_project_state") && /expensive/.test(JSON.stringify(history[history.length - 1]?.content ?? ""));
    return {
      content,
      toolCalls: calls,
      stop: calls.length ? "tool" : "end",
      usage: { input: expensive ? 2_000_000 : 1200, output: 80, cacheRead: 0, cacheWrite: 0 },
      model: "fake",
    };
  },
};
