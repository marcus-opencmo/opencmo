/**
 * Chạy eval của agent editor (spec agent-editor §6):
 *
 *   npm run agent:eval -- --provider fake                 # CI: kiểm harness, không tốn tiền
 *   npm run agent:eval -- --provider anthropic --yes      # model thật: TỐN TIỀN API
 *   npm run agent:eval -- --provider anthropic --task hook --yes
 *
 * Mỗi bài: workspace trong bộ nhớ từ clip mẫu → cùng system prompt, cùng bộ
 * tool, cùng `runTool` với app; tool tab chạy bằng Node (`node-tools.ts`);
 * `ask_user` được trả lời bằng câu soạn sẵn của bài. Chấm bằng code
 * (`tasks.ts`), ghi báo cáo + contact sheet cuối vào `--out`.
 *
 * Model thật cần khoá trong env (`ANTHROPIC_API_KEY`) và
 * `--yes`: không có `--yes` thì chỉ in ước lượng chi phí rồi thoát.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { planStudio3d, planVoiceover, quoteRange, readCaptionState, summarizeProject, type Transcript } from "@opencmo/editor-core";

import { clipContextBlock } from "../clip-context";
import { KEEP_IMAGES } from "../limits";
import { SYSTEM_PROMPT, projectStateBlock } from "../prompt";
import { anthropicProvider } from "../providers/anthropic";
import { fakeProvider } from "../providers/fake";
import type { Image, Provider, StoredMessage, ToolResult } from "../providers/types";
import { generateToolSpec, prepareGeneration, prepareScene, prepareVoiceover, sceneToolSpec, voiceoverToolSpec, type PreparedGeneration } from "../generate-tool";
import { BROWSER_INPUTS, TOOL_SPECS, applyOpTool, isWriteTool, runCheck, runTool } from "../tools";
import { memoryWorkspace } from "../workspace";
import {
  FIXTURE_ABOUT,
  FIXTURE_DURATIONS,
  FIXTURE_FILES,
  FIXTURE_MASTER,
  FONTS_DIR,
  TRANSCRIPT,
  fixtureDocument,
  fixtureManifest,
} from "./fixture";
import { nodeCapture, nodeGrab, nodeInspectColor, nodePreview3d, nodeWaveform, type NodeMedia } from "./node-tools";
import { TASKS, type EvalTask } from "./tasks";

type Args = { provider: string; task?: string; out: string; maxSteps: number; yes: boolean };

function args(): Args {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    provider: value("--provider") ?? "fake",
    task: value("--task"),
    out: value("--out") ?? join(process.cwd(), ".agent-eval"),
    maxSteps: Number(value("--max-steps") ?? 60),
    yes: argv.includes("--yes"),
  };
}

/** Price per million tokens (USD), same as `agent_model_prices`. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  anthropic: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  fake: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function providerFor(name: string): Provider {
  if (name === "fake") return fakeProvider;
  if (name === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new Error("ANTHROPIC_API_KEY chưa có trong env.");
    return anthropicProvider();
  }
  throw new Error(`provider lạ: ${name}`);
}

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

async function runTask(task: EvalTask, provider: Provider, options: Args) {
  const document = fixtureDocument();
  task.setup?.(document);
  const workspace = memoryWorkspace(
    { version: 1, document, manifest: fixtureManifest() },
    { durations: FIXTURE_DURATIONS, transcripts: { "assets/transcript.json": TRANSCRIPT }, master: FIXTURE_MASTER },
  );
  // Transcript renderer cần (bản gốc và bản sau cắt do op lưu) — nạp lại trước mỗi lần vẽ.
  const cache = new Map<string, Transcript>();
  const media = (): NodeMedia => ({ files: FIXTURE_FILES, durations: FIXTURE_DURATIONS, transcripts: cache as never, fontsDir: FONTS_DIR });
  const refreshTranscripts = async () => {
    const snapshot = workspace.snapshot();
    const ctx = await workspace.opContext(snapshot.document, snapshot.manifest);
    cache.clear();
    for (const src of ["assets/transcript.json", ...JSON.stringify(snapshot.document).match(/assets\/transcripts\/[^"]+/g) ?? []]) {
      const found = ctx.media?.transcript?.(src);
      if (found) cache.set(src, found as unknown as Transcript);
    }
  };

  const state = async () => {
    const snapshot = workspace.snapshot();
    const report = await runCheck(workspace);
    const check = report.issues.length ? `<check>${JSON.stringify({ ok: report.ok, issues: report.issues.slice(0, 20) })}</check>` : "<check>ok</check>";
    return `${projectStateBlock({ version: snapshot.version, ...summarizeProject(snapshot.document) })}${check}`;
  };

  // Như session.ts: kịch bản clip gắn vào câu lệnh đầu, rồi mới tới trạng thái.
  const start = workspace.snapshot();
  const about = await clipContextBlock(start.document, await workspace.opContext(start.document, start.manifest), FIXTURE_ABOUT);
  const history: StoredMessage[] = [{ role: "user", content: provider.userTurn(task.prompt, `${about}${await state()}`) }];
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const tools: string[] = [];
  let steps = 0;
  let stopped = "done";
  const env = { workspace };
  // Sinh media trong eval: chuẩn bị + kiểm brief như bản thật (chọn model, câu
  // trích, ghép prompt), đặt khai báo lên clip, KHÔNG gọi model sinh. Catalog
  // giả đủ cho việc đó và không tốn gì.
  process.env.OPENCMO_AI_FAKE ??= "1";
  const toolSpecs = [...TOOL_SPECS, ...[generateToolSpec(), sceneToolSpec(), voiceoverToolSpec()].filter((spec) => spec !== null)];
  const generations: PreparedGeneration[] = [];

  for (;;) {
    if (steps >= options.maxSteps) {
      stopped = "max steps";
      break;
    }
    steps++;
    const step = await provider.step({ history: provider.trimImages(history, KEEP_IMAGES), tools: toolSpecs, system: SYSTEM_PROMPT }, () => undefined);
    usage.input += step.usage.input;
    usage.output += step.usage.output;
    usage.cacheRead += step.usage.cacheRead;
    usage.cacheWrite += step.usage.cacheWrite;
    history.push({ role: "assistant", content: step.content });
    if (!step.toolCalls.length || step.stop === "refusal" || step.stop === "max_tokens") {
      if (step.stop !== "end" && step.stop !== "tool") stopped = step.stop;
      break;
    }
    const results: ToolResult[] = [];
    let wrote = false;
    for (const call of step.toolCalls) {
      tools.push(call.name);
      if (call.name === "ask_user") {
        const content = task.answer
          ? JSON.stringify({ user_answer: { choices: [], text: task.answer } })
          : JSON.stringify({ skipped: true, message: "The user skipped the question. Use your best judgement." });
        results.push({ id: call.id, name: call.name, ok: true, content });
        continue;
      }
      if (call.name in BROWSER_INPUTS) {
        const parsed = BROWSER_INPUTS[call.name]!.safeParse(call.input);
        if (!parsed.success) {
          results.push({ id: call.id, name: call.name, ok: false, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues[0]?.message }) });
          continue;
        }
        await refreshTranscripts();
        const input = parsed.data as Record<string, unknown>;
        const snapshot = workspace.snapshot();
        if (call.name === "save_frame") {
          // Eval không có Storage: lưu frame cần thư viện thật của editor.
          results.push({ id: call.id, name: call.name, ok: false, content: JSON.stringify({ error: "save_frame needs the editor (not available in eval)." }) });
          continue;
        }
        const answer =
          call.name === "preview_3d"
            ? await nodePreview3d(input as Parameters<typeof nodePreview3d>[0])
            : call.name === "capture"
            ? await nodeCapture(snapshot.document, media(), input)
            : call.name === "inspect_color"
            ? await nodeInspectColor(snapshot.document, media(), input as { time?: number })
            : call.name === "media_grab"
              ? await nodeGrab(media(), input as { path: string })
              : await nodeWaveform(media(), input, "assets/master.mp4", readCaptionState(snapshot.document)?.window ?? null);
        if ("error" in answer) {
          results.push({ id: call.id, name: call.name, ok: false, content: JSON.stringify({ error: answer.error }) });
          continue;
        }
        const shots = "images" in answer ? (answer.images as string[]) : [];
        const images: Image[] | undefined = shots.length ? shots.map((data) => ({ data, mimeType: "image/jpeg" as const })) : undefined;
        results.push({ id: call.id, name: call.name, ok: true, content: JSON.stringify({ ok: true, ...(answer.data as object) }), images });
        continue;
      }
      if (call.name === "generate_media" || call.name === "add_3d_scene" || call.name === "add_voiceover") {
        const prepared =
          call.name === "generate_media"
            ? await prepareGeneration(call.input, async (quote) => {
                const snapshot = workspace.snapshot();
                return quoteRange(snapshot.document, await workspace.opContext(snapshot.document, snapshot.manifest), quote, { min: 1.5, max: 5 });
              })
            : call.name === "add_voiceover"
              ? await prepareVoiceover(call.input, async (input) => {
                  const snapshot = workspace.snapshot();
                  return planVoiceover(snapshot.document, input, await workspace.opContext(snapshot.document, snapshot.manifest));
                })
              : await prepareScene(
                  call.input,
                  async (input) => {
                    const snapshot = workspace.snapshot();
                    return planStudio3d(snapshot.document, input, await workspace.opContext(snapshot.document, snapshot.manifest));
                  },
                  // Eval không có DB: code_ref = sha256 như save_scene_code.
                  async (code) => createHash("sha256").update(code, "utf8").digest("hex"),
                );
        if (typeof prepared === "string") {
          results.push({ id: call.id, name: call.name, ok: false, content: JSON.stringify({ INVALID_INPUT: prepared }) });
          continue;
        }
        generations.push(prepared);
        const applied = await applyOpTool(prepared.op, env);
        if (applied.version !== undefined) wrote = true;
        results.push({ id: call.id, name: call.name, ok: applied.ok, content: applied.ok ? JSON.stringify({ ok: true, note: "Generation started (eval: not rendered)." }) : applied.content });
        continue;
      }
      const outcome = await runTool(call.name, call.input, env);
      if (outcome.version !== undefined) wrote = true;
      results.push({ id: call.id, name: call.name, ok: outcome.ok, content: outcome.content });
    }
    const after = wrote && step.toolCalls.some((call) => isWriteTool(call.name)) ? await state() : undefined;
    history.push({ role: "user", content: provider.toolResults(results, after) });
  }

  const final = workspace.snapshot();
  const report = await runCheck(workspace);
  const grade = task.grade({ document: final.document, report, tools, generations });
  await refreshTranscripts();
  const sheet = await nodeCapture(final.document, media(), { count: 8 }).catch(() => null);
  return { task, grade, steps, usage, tools, stopped, sheet: sheet?.images[0] ?? null, document: final.document };
}

async function main() {
  const options = args();
  const tasks = options.task ? TASKS.filter((task) => task.id === options.task) : TASKS;
  if (!tasks.length) throw new Error(`không có bài ${options.task}`);
  const price = PRICES[options.provider] ?? PRICES.anthropic!;

  if (options.provider !== "fake" && !options.yes) {
    // Ước lượng thô: ~15 bước/bài, ~30k token vào mỗi bước (80% trúng cache), ~1.5k ra.
    const perStep = (6_000 * price.input + 24_000 * price.cacheRead + 1_500 * price.output) / 1e6;
    console.log(`Ước lượng: ${tasks.length} bài × ~15 bước × ~$${perStep.toFixed(3)} ≈ $${(tasks.length * 15 * perStep).toFixed(2)} (trần ${options.maxSteps} bước/bài).`);
    console.log("Thêm --yes để chạy thật.");
    return;
  }

  const provider = providerFor(options.provider);
  mkdirSync(options.out, { recursive: true });
  const rows = [];
  for (const task of tasks) {
    const started = Date.now();
    const result = await runTask(task, provider, options);
    const cost = (result.usage.input * price.input + result.usage.output * price.output + result.usage.cacheRead * price.cacheRead + result.usage.cacheWrite * price.cacheWrite) / 1e6;
    if (result.sheet) writeFileSync(join(options.out, `${task.id}.jpg`), Buffer.from(result.sheet, "base64"));
    writeFileSync(join(options.out, `${task.id}.json`), JSON.stringify({ tools: result.tools, grade: result.grade, document: result.document }, null, 2));
    const row = {
      task: task.id,
      pass: result.grade.pass,
      steps: result.steps,
      stopped: result.stopped,
      seconds: Math.round((Date.now() - started) / 1000),
      cost: Math.round(cost * 1000) / 1000,
      notes: result.grade.notes.join("; "),
    };
    rows.push(row);
    console.log(`${row.pass ? "PASS" : "FAIL"} ${row.task.padEnd(9)} ${String(row.steps).padStart(3)} bước  $${row.cost.toFixed(3)}  ${row.notes}`);
  }
  const passed = rows.filter((row) => row.pass).length;
  const total = rows.reduce((sum, row) => sum + row.cost, 0);
  console.log(`\n${passed}/${rows.length} bài qua · $${total.toFixed(2)} · báo cáo ở ${options.out}`);
  writeFileSync(join(options.out, "report.json"), JSON.stringify({ provider: options.provider, rows, passed, cost: total }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
