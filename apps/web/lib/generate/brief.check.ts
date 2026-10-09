/**
 * Brief → prompt cho ảnh/video sinh (spec visual-grounding) và cửa
 * `generate_media` của agent: câu trích phải có thật, brief thiếu thì lỗi,
 * brief xin sơ đồ/chữ thì bị đẩy sang visual vẽ sẵn.
 */

import assert from "node:assert/strict";

import { prepareGeneration } from "@/lib/agent/generate-tool";

import type { SupabaseClient } from "@/lib/api/handler";

import { briefMisuse, composePrompt, type Brief } from "./brief";
import { resolveMediaRefs } from "./create";

const brief: Brief = {
  quote: "watch the numbers change",
  idea: "results grow once the hook works",
  subject: "a creator watching a view counter climb on a phone",
  action: "smiling as the screen lights up",
  setting: "a small home studio at night",
  style: "cinematic",
  camera: "slow push-in",
  avoid: ["brand names"],
};

async function main(): Promise<void> {
  // Khuôn: chủ thể + ý + phong cách + máy quay + khung dọc + cấm chữ; câu trích không lọt vào.
  {
    const prompt = composePrompt(brief, "video", { maxChars: 2000, aspectRatio: "9:16", duration: 6 });
    assert.match(prompt, /^A creator watching a view counter climb on a phone, smiling/);
    assert.match(prompt, /Camera: slow push-in; one continuous shot of about 6 seconds/);
    assert.match(prompt, /Vertical 9:16 composition/);
    assert.match(prompt, /No text, letters, numbers, captions, logos, watermarks or UI in the frame; also avoid: brand names\./);
    assert.ok(!prompt.toLowerCase().includes("watch the numbers change"), "câu người nói không được vào prompt");
    const image = composePrompt({ ...brief, style: undefined, camera: undefined }, "image", { maxChars: 2000, aspectRatio: "1:1" });
    assert.match(image, /Photorealistic photograph/);
    assert.ok(!/Camera:|Vertical 9:16/.test(image));
    // Trần ký tự: giữ chủ thể và câu cấm chữ, bỏ phần giữa.
    const short = composePrompt(brief, "video", { maxChars: 300 });
    assert.ok(short.length <= 300);
    assert.match(short, /No text/);
  }

  // Brief xin thứ model sinh làm hỏng → gợi ý visual vẽ sẵn.
  {
    assert.match(briefMisuse({ idea: "x", subject: "a bar chart of growth" }) ?? "", /add_chart/);
    assert.match(briefMisuse({ idea: "x", subject: "a glowing sphere", action: "with the title 'Hooks' written on it" }) ?? "", /add_diagram/);
    assert.equal(briefMisuse({ idea: "numbers grow", subject: "a runner at sunrise" }), null);
  }

  // generate_media: câu trích phải có trong clip; thiếu brief thì lỗi; mốc theo câu.
  {
    process.env.OPENCMO_AI_FAKE = "1";
    const locate = async (quote: string) => {
      if (!/numbers/.test(quote)) throw new Error(`"${quote}" is not in this clip's transcript.`);
      return { start: 21.9, end: 25.9 };
    };
    const ok = await prepareGeneration({ kind: "video", ...brief }, locate);
    assert.ok(typeof ok !== "string", String(ok));
    assert.equal((ok.op as { start?: number }).start, 21.9);
    assert.equal(ok.quote, "watch the numbers change");
    assert.match(ok.spec.prompt, /No text/);

    assert.match(String(await prepareGeneration({ kind: "image", ...brief, quote: "compound interest" }, locate)), /not in this clip's transcript/);
    assert.match(String(await prepareGeneration({ kind: "image", prompt: "a sunset" }, locate)), /quote is required/);
    assert.match(String(await prepareGeneration({ kind: "video", ...brief, subject: "a 3D diagram of the funnel" }, locate)), /add_diagram/);
    // Giọng đọc giữ prompt: chữ cần đọc.
    const voice = await prepareGeneration({ kind: "voice", prompt: "Welcome back." }, locate);
    assert.ok(typeof voice !== "string" && voice.spec.prompt === "Welcome back.");
  }

  // Frame đầu/cuối (plan Palmier P1-B): model phải nhận, ảnh phải là ảnh AI đã xong.
  {
    process.env.FAL_KEY = "test";
    const locate = async () => ({ start: 3, end: 6 });
    const lookup = async (path: string) => (path === "AI/still.png" ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/j/still.png" : null);
    const ok = await prepareGeneration(
      { kind: "video", ...brief, model: "fal-seedance", resolution: "720p", start_image: "AI/still.png" },
      locate,
      lookup,
    );
    assert.ok(typeof ok !== "string", String(ok));
    assert.equal(ok.spec.startImage, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/j/still.png");
    assert.equal(ok.spec.resolution, "720p");
    assert.equal(ok.credits, 10, "720p nhân hệ số 2");
    assert.equal((ok.op as { start_frame?: string }).start_frame, "AI/still.png");
    const broll = await prepareGeneration({ kind: "video", ...brief, model: "fal-seedance", start_image: "AI/still.png", length: 2.5, muted: true }, locate, lookup);
    assert.ok(typeof broll !== "string", String(broll));
    assert.deepEqual([(broll.op as { length?: number }).length, (broll.op as { muted?: boolean }).muted], [2.5, true]);
    assert.ok(!("length" in broll.spec) && !("muted" in broll.spec), "length/muted là cách đặt, không vào spec (không đổi giá, không đổi hash)");
    assert.match(String(await prepareGeneration({ kind: "video", ...brief, model: "fal-kling", end_image: "AI/still.png" }, locate, lookup)), /cannot end on an image/);
    assert.match(String(await prepareGeneration({ kind: "video", ...brief, model: "fal-seedance", start_image: "AI/other.png" }, locate, lookup)), /not an image saved to the cloud/);
    assert.match(String(await prepareGeneration({ kind: "video", ...brief, model: "fal-seedance", resolution: "4k" }, locate, lookup)), /resolution/);

    // Ảnh tham chiếu cho agent (G2): model nhận references, mỗi ảnh đã lên Storage.
    const refs = await prepareGeneration({ kind: "image", ...brief, model: "fal-nano-banana", references: ["AI/still.png"] }, locate, lookup);
    assert.ok(typeof refs !== "string", String(refs));
    assert.deepEqual(refs.spec.references, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/j/still.png"]);
    assert.deepEqual((refs.op as { refs?: string[] }).refs, ["AI/still.png"], "op giữ đường dẫn thư viện, spec giữ tên object");
    assert.match(String(await prepareGeneration({ kind: "video", ...brief, model: "fal-kling", references: ["AI/still.png"] }, locate, lookup)), /does not take reference images/);
    assert.match(String(await prepareGeneration({ kind: "image", ...brief, model: "fal-nano-banana", references: ["AI/other.png"] }, locate, lookup)), /references: .*not an image saved/);
    assert.match(
      String(await prepareGeneration({ kind: "image", ...brief, model: "fal-nano-banana", references: Array(5).fill("AI/still.png") }, locate, lookup)),
      /up to 4 reference images/,
    );
    delete process.env.FAL_KEY;
  }

  // Id thư viện → tên object Storage, chỉ trong job của mình; ảnh chưa xong thì báo chờ.
  {
    const job = "11111111-1111-4111-8111-111111111111";
    const asset = "22222222-2222-4222-8222-222222222222";
    const generation = "33333333-3333-4333-8333-333333333333";
    const pending = "44444444-4444-4444-8444-444444444444";
    const rows: Record<string, Record<string, Record<string, unknown>>> = {
      media_assets: { [asset]: { status: "ready", storage_path: "media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/j/a.png", job_id: job }, linked: { status: "ready", storage_path: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/j/g.png", job_id: job } },
      generations: { [generation]: { media_asset_id: "linked", status: "done", job_id: job }, [pending]: { media_asset_id: null, status: "running", job_id: job } },
    };
    const fake = {
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const query = {
          select: () => query,
          eq(column: string, value: unknown) {
            filters[column] = value;
            return query;
          },
          async maybeSingle() {
            const row = rows[table]?.[String(filters.id)];
            const match = row && (filters.job_id === undefined || row.job_id === filters.job_id);
            return { data: match ? row : null, error: null };
          },
        };
        return query;
      },
    } as unknown as SupabaseClient;
    const out = (await resolveMediaRefs(fake, job, { prompt: "x", startImage: asset, references: [generation, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/j/kept.png"] })) as Record<string, unknown>;
    assert.equal(out.startImage, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/j/a.png", "bỏ tiền tố bucket");
    assert.deepEqual(out.references, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/j/g.png", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/j/kept.png"], "generation → asset; đường dẫn giữ nguyên");
    await assert.rejects(resolveMediaRefs(fake, job, { endImage: pending }), /still generating/);
    await assert.rejects(resolveMediaRefs(fake, "55555555-5555-4555-8555-555555555555", { startImage: asset }), /not found in your library/);
  }

  console.log("brief: mọi kiểm tra xanh");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
