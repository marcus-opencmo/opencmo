import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { USER_INPUT } from './inputs.ts';

const run = promisify(execFile);

export type Probe = {
  duration: number;
  video: { width: number; height: number; fps: number; frames: number; matrix: string | null } | null;
  /** Số kênh của luồng tiếng đầu; 0 = không có tiếng. */
  channels: number;
};

export async function probe(file: string): Promise<Probe> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    // File của người dùng: chỉ demuxer media thường (inputs.ts).
    ...USER_INPUT,
    '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,r_frame_rate,color_space,channels:format=duration',
    '-of', 'json',
    file,
  ]);
  const json = JSON.parse(stdout) as {
    streams: { codec_type: string; channels?: number; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; color_space?: string }[];
    format: { duration?: string };
  };
  const duration = Number(json.format.duration ?? 0);
  const video = json.streams.find((stream) => stream.codec_type === 'video');
  const rate = (text?: string) => {
    const [num, den] = (text ?? '0/1').split('/').map(Number);
    return den ? num! / den : 0;
  };
  const fps = rate(video?.r_frame_rate) || rate(video?.avg_frame_rate) || 30;
  return {
    duration,
    video: video
      ? {
          width: video.width ?? 0,
          height: video.height ?? 0,
          fps,
          frames: Math.max(1, Math.floor(duration * fps)),
          // Luồng không ghi ma trận màu: Chromium (thứ người dùng nhìn khi sửa) giải
          // theo BT.709, ffmpeg mặc định BT.601 — đỏ lệch thành cam. Theo Chromium.
          matrix: !video.color_space || video.color_space === 'unknown' ? 'bt709' : null,
        }
      : null,
    channels: json.streams.find((stream) => stream.codec_type === 'audio')?.channels ?? 0,
  };
}
