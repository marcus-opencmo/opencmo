// Chẩn đoán 02/10: render video trên L4 mất WebGL context ở khung 2 (ảnh tĩnh thì không).
// Thử các bộ cờ, mỗi bộ 3 giây (90 khung, trần dưới của spec), in dòng log có "MẤT CONTEXT" nếu có.
import { readFileSync } from 'node:fs';
import { renderToFile } from '../src/render.ts';
import { fromGeneration } from '../src/spec.ts';

const QUIET = ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--disable-default-apps'];
const OFFLINE = ['--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
const VK = ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--disable-vulkan-surface'];
const SETS: Record<string, string[]> = {
	prod: [...QUIET, ...OFFLINE, ...VK, '--enable-gpu-rasterization'],
	no_offline: [...QUIET, ...VK, '--enable-gpu-rasterization'],
	no_raster: [...QUIET, ...OFFLINE, ...VK],
	no_watchdog: [...QUIET, ...OFFLINE, ...VK, '--enable-gpu-rasterization', '--disable-gpu-watchdog', '--disable-gpu-process-crash-limit'],
	egl: [...QUIET, ...OFFLINE, '--use-angle=gl-egl', '--ignore-gpu-blocklist'],
};
const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const { code, ...generation } = input;
const spec = fromGeneration({ ...generation, duration: 3 });
for (const [name, args] of Object.entries(SETS)) {
	try {
		await renderToFile(spec, `/tmp/variant-${name}.mp4`, { gpu: true, code, args, log: (line) => console.log(`[${name}] ${line}`) });
	} catch (error) {
		console.log(`[${name}] LỖI ${(error as Error).message.slice(0, 300)}`);
	}
}
