/**
 * Mẫu nghe thử cho từng giọng voiceover → `public/voices/<Tên>.mp3` (tĩnh,
 * cùng origin: nút ▶ cạnh ô chat phát ngay, không tốn credit của người dùng).
 *
 * Vì sao tự sinh: khoá ElevenLabs của server không có quyền `voices_read` nên
 * không lấy được `preview_url` sẵn của họ; Gemini TTS không có mẫu công khai.
 * Mỗi lần chạy tốn ~60 ký tự × số giọng. Tên giọng lấy từ catalog
 * (`ai-models.json`), id ElevenLabs lấy từ engine — một nguồn.
 *
 *   ELEVENLABS_API_KEY=… GEMINI_API_KEY=… npx tsx scripts/build-voice-previews.mts [--force]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const OUT = join(HERE, '..', 'public', 'voices');

const force = process.argv.includes('--force');

type Model = { provider: string; providerModel?: string; kind: string; limits: { voices?: string[] } };
const catalog = JSON.parse(readFileSync(join(ROOT, 'packages/contracts/ai-models.json'), 'utf8')) as { models: Model[] };
const sample = (voice: string) => `Hi, I'm ${voice}. This is how your voiceover will sound.`;

mkdirSync(OUT, { recursive: true });

/** Giọng chưa có mẫu (hay có `--force`): bỏ qua cái đã có, ghi log. */
const todo = (voice: string) => {
  const file = join(OUT, `${voice}.mp3`);
  if (existsSync(file) && !force) {
    console.log(`giữ ${voice}`);
    return null;
  }
  return file;
};

// ---- ElevenLabs: id lấy từ engine (`VOICES: dict[str, str] = { "Aria": "9BW…", … }`).
const eleven = catalog.models.find((entry) => entry.kind === 'voice' && entry.provider === 'elevenlabs');
if (eleven?.limits.voices?.length) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('Thiếu ELEVENLABS_API_KEY');
  const engine = readFileSync(join(ROOT, 'packages/engine/opencmo/ai/providers/elevenlabs.py'), 'utf8');
  const ids = new Map([...engine.matchAll(/^\s*"([^"]+)":\s*"([A-Za-z0-9]{20})",?$/gm)].map((match) => [match[1]!, match[2]!]));
  for (const voice of eleven.limits.voices) {
    const file = todo(voice);
    if (!file) continue;
    const id = ids.get(voice);
    if (!id) throw new Error(`Engine không có id cho giọng ${voice}`);
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: sample(voice), model_id: eleven.providerModel }),
    });
    if (!response.ok) throw new Error(`${voice}: ElevenLabs trả ${response.status} ${(await response.text()).slice(0, 200)}`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    console.log(`ghi ${voice} (${statSync(file).size} byte)`);
  }
}

// ---- Gemini TTS: PCM 16-bit mono thô → mp3 bằng ffmpeg (như engine đóng m4a).
const gemini = catalog.models.find((entry) => entry.kind === 'voice' && entry.provider === 'gemini');
if (gemini?.limits.voices?.length) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Thiếu GEMINI_API_KEY');
  for (const voice of gemini.limits.voices) {
    const file = todo(voice);
    if (!file) continue;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${gemini.providerModel}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: sample(voice) }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
    });
    if (!response.ok) throw new Error(`${voice}: Gemini trả ${response.status} ${(await response.text()).slice(0, 200)}`);
    const body = (await response.json()) as { candidates?: { content?: { parts?: { inlineData?: { data: string; mimeType: string } }[] } }[] };
    const inline = body.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)?.inlineData;
    if (!inline) throw new Error(`${voice}: Gemini không trả audio`);
    const rate = /rate=(\d+)/.exec(inline.mimeType)?.[1] ?? '24000';
    const encoded = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 's16le', '-ar', rate, '-ac', '1', '-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', '64k', file], {
      input: Buffer.from(inline.data, 'base64'),
    });
    if (encoded.status !== 0) throw new Error(`${voice}: ffmpeg lỗi ${encoded.stderr.toString().slice(0, 200)}`);
    console.log(`ghi ${voice} (${statSync(file).size} byte)`);
  }
}
