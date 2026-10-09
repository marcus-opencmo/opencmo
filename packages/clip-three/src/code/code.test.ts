import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { compileScene, MAX_CODE_CHARS, SceneCodeError } from './guard.ts';

describe('guard', () => {
	it('lỗi cú pháp ra phase compile với câu của engine', () => {
		expect(() => compileScene('return (t) => {')).toThrow(SceneCodeError);
		try {
			compileScene('function () {}');
		} catch (error) {
			expect((error as SceneCodeError).phase).toBe('compile');
			expect((error as Error).message).toMatch(/^Syntax error:/);
		}
	});
	it('code rỗng hoặc quá dài bị từ chối trước khi biên dịch', () => {
		expect(() => compileScene('  ')).toThrow(/empty/);
		expect(() => compileScene(`return () => {};${' '.repeat(MAX_CODE_CHARS)}`)).toThrow(/longer than/);
	});
	it('che mạng, đồng hồ, ngẫu nhiên: cùng t luôn ra cùng khung', () => {
		const run = (code: string) => compileScene(code)({}, {}, {});
		expect(run('return typeof fetch')).toBe('undefined');
		expect(run('return typeof Date')).toBe('undefined');
		expect(run('return typeof setTimeout')).toBe('undefined');
		expect(run('return typeof document')).toBe('undefined');
		expect(() => run('return Math.random()')).toThrow(/stage\.random/);
		expect(run('return Math.round(Math.PI * 100)')).toBe(314);
	});
});

// Cảnh thật trong Chromium (SwiftShader, khung nhỏ): chỉ chạy khi có Chromium của Playwright.
const chromium = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const base = { width: 192, height: 192, duration: 3 };
const GOOD = `
const bars = kit.bars([12, 31], { labels: ['Before', 'After'] });
const title = kit.label('Revenue', { size: 0.4, at: bars.group, lift: 0.9 });
return (t) => {
  bars.grow(kit.phase(t, 0.2, 1.6));
  kit.frame({ yaw: 10 + 8 * t / 3, push: t / 3 });
};`;

describe.skipIf(!existsSync(chromium))('cảnh code (Chromium)', () => {
	it('cảnh tốt: ảnh có nội dung, không có vấn đề bố cục', { timeout: 120_000 }, async () => {
		const { renderCodeStills } = await import('../render.ts');
		const result = await renderCodeStills({ ...base, code: GOOD }, [0.5, 2.9]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.images).toHaveLength(2);
		expect(result.images[1]!.length).toBeGreaterThan(4_000);
		expect(result.reports[1]!.issues).toEqual([]);
		expect(result.reports[1]!.coverage).toBeGreaterThan(0.1);
	});
	it('vật ra ngoài khung được báo đích danh; lỗi khi dựng/khung có phase', { timeout: 120_000 }, async () => {
		const { renderCodeStills } = await import('../render.ts');
		const off = `
const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), kit.glossy('#38bdf8'));
box.name = 'blue box';
stage.root.add(box);
const far = kit.label('FAR AWAY');
// Camera đặt tay (không kit.frame): đúng kiểu lỗi của spike — nhãn trôi khỏi khung.
return (t) => {
  kit.orbit(stage.camera, new THREE.Vector3(0, 0.5, 0), 0, 10, 6);
  far.position.x = t > 1 ? 40 : 0;
};`;
		const result = await renderCodeStills({ ...base, code: off }, [2]);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.reports[0]!.issues.join(' | ')).toMatch(/label "FAR AWAY" is outside the frame/);

		const build = await renderCodeStills({ ...base, code: 'const x = Math.random(); return (t) => {};' }, [1]);
		expect(build).toMatchObject({ ok: false, phase: 'build' });
		const frame = await renderCodeStills({ ...base, code: 'return (t) => { if (t > 1) missing.thing = 1; };' }, [2]);
		// Runtime chạy trước update(duration) để chốt khung: lỗi lộ ra ở giây cuối, trước cả ảnh đầu.
		expect(frame).toMatchObject({ ok: false, phase: 'frame', at: 3 });
	});
	it('cảnh to (nhãn cỡ 4 của Gemini) vẫn nằm trong tầm camera, không khung trống', { timeout: 120_000 }, async () => {
		// Code thật Gemini viết 01/10: kit.frame đẩy camera ra ~255 đơn vị, quá mặt phẳng
		// xa 200 — mọi vật bị cắt và báo cáo nói nhầm "behind the camera".
		const { renderCodeStills } = await import('../render.ts');
		const code = readFileSync(new URL('./fixtures/gemini-90-pages.js', import.meta.url), 'utf8');
		const result = await renderCodeStills({ width: 108, height: 192, duration: 4, code }, [3.95]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const report = result.reports[0]!;
		expect(report.issues.join(' | ')).not.toMatch(/behind the camera|too far/);
		// padding 0.8 của Gemini để chừa rất rộng: chỉ đòi khung không trống.
		expect(report.coverage).toBeGreaterThan(0.05);
		expect(result.triangles).toBeGreaterThan(1000);
	});
	it('bản "sạch" của Gemini: lề bị kẹp nên cảnh to lên, nhãn bị che thì báo', { timeout: 120_000 }, async () => {
		// Code thật 01/10: padding 1.0 (cảnh ~5% khung), nhãn "90 PAGES" nằm sau chồng giấy.
		const { renderCodeStills } = await import('../render.ts');
		const code = readFileSync(new URL('./fixtures/gemini-90-pages-clean.js', import.meta.url), 'utf8');
		const result = await renderCodeStills({ width: 108, height: 192, duration: 4, code }, [3.95]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const report = result.reports[0]!;
		expect(report.coverage).toBeGreaterThan(0.08);
		expect(report.issues.join(' | ')).toMatch(/label "90 PAGES" is partly hidden behind Paper Stack|fills only/);
	});
});
