/**
 * Dò beat của nhạc nền (học Palmier §B7) từ đường bao biên độ timeline đã có
 * (đỉnh mỗi 1/100 giây, `peaks.ts`) — không giải mã lại, không model.
 *
 * Palmier chạy model "Beat This" ở 22.05 kHz và lấy BPM = 60 / trung vị khoảng
 * beat. Ở đây nhạc nền short-form gần như luôn giữ nhịp đều, nên: onset = phần
 * TĂNG của log biên độ (nhạc gõ lên là tăng vọt), tempo = độ trễ tự tương quan
 * mạnh nhất của onset trong 60–200 BPM, pha = độ lệch có tổng onset trên lưới
 * lớn nhất. Ra một lưới beat đều. Tiếng nói không có nhịp: độ tin thấp thì trả
 * null — snap vào "beat" của lời nói còn tệ hơn không có.
 */

export type BeatGrid = { bpm: number; beats: number[]; confidence: number };

const MIN_BPM = 60;
const MAX_BPM = 200;
/** Dưới mức này coi như không có nhịp (đo: click 120 BPM ~0.6+, giọng nói đọc ~0.1–0.2). */
const MIN_CONFIDENCE = 0.3;

/** `envelope`: biên độ đỉnh (0–1) theo `rate` mẫu/giây. Beat tính bằng giây của NGUỒN. */
export function detectBeats(envelope: ArrayLike<number>, rate: number): BeatGrid | null {
  const n = envelope.length;
  if (n < rate * 4) return null;
  // Onset: phần tăng của log biên độ, bỏ trung bình động 1 s cho khỏi ăn theo độ to chung.
  const log = new Float32Array(n);
  for (let index = 0; index < n; index++) log[index] = Math.log10(1e-4 + Math.max(0, envelope[index] ?? 0));
  const onset = new Float32Array(n);
  for (let index = 1; index < n; index++) onset[index] = Math.max(0, log[index]! - log[index - 1]!);
  const window = Math.round(rate);
  let sum = 0;
  const local = new Float32Array(n);
  for (let index = 0; index < n; index++) {
    sum += onset[index]!;
    if (index >= window) sum -= onset[index - window]!;
    local[index] = sum / Math.min(index + 1, window);
  }
  for (let index = 0; index < n; index++) onset[index] = Math.max(0, onset[index]! - local[index]!);
  // Làm mờ nhẹ (hai lượt 1-2-1): chu kỳ thật rơi lệch nửa mẫu nên đỉnh onset nhảy giữa hai
  // mẫu kề nhau; không mờ thì tự tương quan ở chu kỳ đơn bị chia đôi và thua chu kỳ kép.
  for (let pass = 0; pass < 2; pass++) {
    let previous = onset[0]!;
    for (let index = 1; index < n - 1; index++) {
      const current = onset[index]!;
      onset[index] = 0.25 * previous + 0.5 * current + 0.25 * onset[index + 1]!;
      previous = current;
    }
  }

  let energy = 0;
  for (let index = 0; index < n; index++) energy += onset[index]! * onset[index]!;
  if (energy <= 1e-9) return null;

  // Tempo: tự tương quan chuẩn hoá trên mọi độ trễ 60–200 BPM; ưu tiên nhẹ quanh 120
  // để không nhảy sang nửa/gấp đôi nhịp khi hai đỉnh gần bằng nhau.
  const minLag = Math.floor((60 / MAX_BPM) * rate);
  const maxLag = Math.ceil((60 / MIN_BPM) * rate);
  let bestLag = 0;
  let bestScore = -Infinity;
  let bestRaw = 0;
  let total = 0;
  let count = 0;
  for (let lag = minLag; lag <= maxLag && lag < n / 2; lag++) {
    let acc = 0;
    for (let index = lag; index < n; index++) acc += onset[index]! * onset[index - lag]!;
    const raw = acc / energy;
    total += raw;
    count += 1;
    const bpm = (60 * rate) / lag;
    const prior = Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    const score = raw * (0.6 + 0.4 * prior);
    if (score > bestScore) (bestScore = score), (bestLag = lag), (bestRaw = raw);
  }
  if (!bestLag) return null;
  const rawAt = (lag: number) => {
    let acc = 0;
    for (let index = lag; index < n; index++) acc += onset[index]! * onset[index - lag]!;
    return acc / energy;
  };
  // Nửa nhịp: track gõ đều có tự tương quan ở 2× chu kỳ gần bằng ở 1×, và prior quanh 120
  // kéo 174 BPM về 87. Nhịp gấp đôi vẫn trong khoảng mà tương quan ≥ 80% đỉnh thì lấy nó.
  // Chu kỳ thật hiếm khi là số mẫu nguyên: xét cả hai độ trễ quanh nửa.
  const halves = [Math.floor(bestLag / 2), Math.ceil(bestLag / 2)].filter((lag) => lag >= minLag);
  const half = halves.sort((x, y) => rawAt(y) - rawAt(x))[0];
  if (half && rawAt(half) >= 0.8 * bestRaw) (bestLag = half), (bestRaw = rawAt(half));
  // Tinh độ trễ dưới mẫu bằng parabol quanh đỉnh — 100 mẫu/giây chỉ chia BPM thành bậc ~1–3.
  const at = (lag: number) => {
    let acc = 0;
    for (let index = lag; index < n; index++) acc += onset[index]! * onset[index - lag]!;
    return acc;
  };
  const [a, b, c] = [at(bestLag - 1), at(bestLag), at(bestLag + 1)];
  const shift = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  const period = bestLag + Math.max(-0.5, Math.min(0.5, shift));

  // Pha: độ lệch có tổng onset trên lưới lớn nhất.
  let bestPhase = 0;
  let bestSum = -Infinity;
  for (let phase = 0; phase < period; phase++) {
    let acc = 0;
    for (let position = phase; position < n; position += period) acc += onset[Math.round(position)] ?? 0;
    if (acc > bestSum) (bestSum = acc), (bestPhase = phase);
  }
  // Độ tin = đỉnh nhô cao hơn mặt bằng tự tương quan bao nhiêu: nhiễu (đã làm mờ) có tương
  // quan đều ở mọi độ trễ, nhịp gõ thì có một đỉnh rõ.
  const mean = count ? total / count : 0;
  const confidence = Math.max(0, Math.min(1, (bestRaw - mean) / Math.max(1e-6, 1 - mean)));
  if (confidence < MIN_CONFIDENCE) return null;
  const beats: number[] = [];
  for (let position = bestPhase; position < n; position += period) beats.push(Math.round((position / rate) * 1000) / 1000);
  return { bpm: Math.round((60 * rate * 10) / period) / 10, beats, confidence: Math.round(confidence * 100) / 100 };
}
