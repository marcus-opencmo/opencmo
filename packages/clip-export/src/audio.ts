/**
 * Trộn tiếng bằng ffmpeg: mỗi clip có tiếng là một input (`-ss` trước `-i`, chỉ
 * đọc đúng đoạn cần), giãn nhịp bằng `atempo` (giữ cao độ như DS), đặt vào
 * timeline bằng `adelay`, đổi âm lượng theo từng khung qua `asendcmd`.
 */

import type { AudioClip } from '@opencmo/clip-render';

export type MixInput = { file: string; seek: number; duration: number };
export type MixSource = { file: string; channels: number };

export type Mix = {
  /** Đứng SAU input hình: input tiếng thứ n là input ffmpeg thứ `n + 1`. */
  inputs: MixInput[];
  /** filter_complex; nhãn ra là `[aout]`. */
  graph: string;
  /** Nội dung file lệnh của từng `asendcmd`, theo thứ tự input. */
  commands: string[];
};

/** `atempo` chỉ nhận 0.5–2 (bản cũ): tốc độ ngoài khoảng đó thành một chuỗi. */
function tempo(rate: number): string[] {
  const out: string[] = [];
  let left = rate;
  while (left > 2) {
    out.push('atempo=2');
    left /= 2;
  }
  while (left < 0.5) {
    out.push('atempo=0.5');
    left /= 0.5;
  }
  if (Math.abs(left - 1) > 1e-9) out.push(`atempo=${left.toFixed(6)}`);
  return out;
}

const FPS = 30;

/**
 * Khử ồn giọng nói (học Palmier §C7) cho node có `denoise` 0…1: cắt rền dưới 80 Hz rồi
 * `anlmdn` (non-local means). Đo trên giọng giả + nhiễu hồng, qua đúng chuỗi export (mono →
 * stereo, AAC 128k): nền giữa câu −46 dB → −56 (s 0.05) / −60 (0.1) / −63 (0.2), mức giọng
 * giữ trong 0.1 dB. Không dùng `afftdn`: qua chuỗi này chỉ được ~5 dB. Không trộn dry/wet:
 * anlmdn trễ vài mẫu, trộn lại là lọc lược (giọng tụt 4–5 dB) — mức mạnh đổi bằng `s`
 * theo thang log 0.02 → 0.5. Tốn ~1/10 thời gian thực (60 s tiếng ≈ 6 s).
 */
export function denoiseFilters(amount: number | undefined): string[] {
  if (!amount || amount <= 0) return [];
  const strength = 0.02 * 25 ** Math.min(1, amount);
  return ['highpass=f=80', `anlmdn=s=${strength.toFixed(4)}`];
}

/**
 * `gains[i][k]`: biên độ của clip k ở khung thứ i của bản xuất.
 * `sourceOf(clip)`: file trên đĩa của nguồn, null khi nguồn không có tiếng.
 */
export function planMix(
  clips: AudioClip[],
  gains: number[][],
  range: { start: number; frames: number },
  sourceOf: (clip: AudioClip) => MixSource | null,
): Mix | null {
  const inputs: MixInput[] = [];
  const chains: string[] = [];
  const commands: string[] = [];
  const end = range.start + range.frames;
  clips.forEach((clip, k) => {
    const source = sourceOf(clip);
    const from = Math.max(clip.start, range.start);
    const to = Math.min(clip.end, end);
    if (!source || to <= from) return;
    const { file } = source;
    if (gains.every((row) => (row[k] ?? 0) === 0)) return;
    const seek = clip.sourceIn + ((from - clip.start) / FPS) * clip.rate;
    const duration = ((to - from) / FPS) * clip.rate;
    const n = inputs.length;
    inputs.push({ file, seek, duration });
    const lines: string[] = [];
    let last: number | null = null;
    gains.forEach((row, i) => {
      const gain = row[k] ?? 0;
      if (gain !== last) lines.push(`${(i / FPS).toFixed(6)} volume@v${n} volume ${gain.toFixed(6)};`);
      last = gain;
    });
    commands.push(lines.join('\n'));
    const delay = Math.round(((from - range.start) / FPS) * 1000);
    chains.push(
      [
        `[${n + 1}:a]aresample=48000`,
        // Web Audio chép mono ra hai kênh nguyên mức; swresample mặc định hạ −3 dB.
        ...(source.channels === 1 ? ['pan=stereo|c0=c0|c1=c0'] : []),
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
        ...denoiseFilters((clip.node?.node as { denoise?: number } | undefined)?.denoise),
        ...tempo(clip.rate),
        'asetpts=PTS-STARTPTS',
        `adelay=${delay}:all=1`,
        `asendcmd=f=CMD${n}`,
        `volume@v${n}=volume=0:precision=float`,
      ].join(',') + `[a${n}]`,
    );
  });
  if (!inputs.length) return null;
  const labels = inputs.map((_, n) => `[a${n}]`).join('');
  const graph = `${chains.join(';')};${labels}amix=inputs=${inputs.length}:normalize=0:dropout_transition=0,apad[aout]`;
  return { inputs, graph, commands };
}
