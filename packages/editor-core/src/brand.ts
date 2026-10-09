/**
 * Brand Kit (spec brand-kit BK1/BK4): màu, font, kiểu phụ đề, khung và logo của
 * một thương hiệu — đặt MỘT lần, mọi clip mới và mọi visual tự theo.
 *
 * Kit sống ở hai chỗ:
 * - bảng `brand_kits` (của người dùng; route + RPC kiểm lại schema này);
 * - mark `brand` trên scene của document đã áp kit (`apply_brand`). Visual thêm
 *   sau đọc màu/font từ mark đó, nên clip giữ đúng brand kể cả khi kit gốc bị
 *   sửa hay xoá, và `update_visual` dựng lại ra cùng màu.
 *
 * Không DOM, không three: route, editor, agent và worker cùng import.
 */

import { z } from 'zod';

import { FONTS, type FontFamily } from '@opencmo/clip-render';
import { BrandMarkSchema, CAPTION_PRESETS, type BrandLogoSchema, type ClipDocument } from '@opencmo/clip-doc';

import { sceneOf } from './doc';
import { THEME, type Theme } from './visuals/common';

export const BRAND_VERSION = 1;
/** Kiểu phụ đề của brand = đúng bộ preset của `<captions>` (một nguồn ở clip-doc). */
export const CAPTION_STYLES = CAPTION_PRESETS;
export { BRAND_ASPECTS, BrandLogoSchema, LOGO_CORNERS } from '@opencmo/clip-doc';

const FONT_NAMES = Object.keys(FONTS) as [FontFamily, ...FontFamily[]];

/**
 * Kit = mark `brand` của clip-doc (một nguồn cho cấu trúc), siết font theo bảng font
 * của clip-render — thứ clip-doc không phụ thuộc.
 */
export const BrandKitSchema = BrandMarkSchema.extend({
	fonts: z.object({ heading: z.enum(FONT_NAMES), body: z.enum(FONT_NAMES) }).strict(),
});

export type BrandKit = z.infer<typeof BrandKitSchema>;
export type BrandLogo = z.infer<typeof BrandLogoSchema>;

/** Kit khởi đầu cho form "New brand kit" — cùng màu với visual mặc định. */
export const DEFAULT_BRAND: BrandKit = {
	version: BRAND_VERSION,
	colors: { primary: '#38BDF8', secondary: '#F472B6', accent: '#FACC15', text: '#FFFFFF', background: '#0F172A' },
	fonts: { heading: 'Montserrat', body: 'Inter' },
	captions: { preset: 'spotlight' },
	layout: { aspect: '9:16', fit: 'fill' },
	logo: null,
};

/** Kích thước khung theo tỉ lệ, cạnh ngắn 1080 (cùng bảng của ô tỉ lệ trong editor). */
export function brandFrame(aspect: BrandKit['layout']['aspect']): { width: number; height: number } {
	return { '9:16': { width: 1080, height: 1920 }, '1:1': { width: 1080, height: 1080 }, '4:5': { width: 1080, height: 1350 }, '16:9': { width: 1920, height: 1080 } }[aspect];
}

/** Kit đã áp vào document (mark `brand` của scene); null khi chưa áp. */
export function readBrand(document: ClipDocument): BrandKit | null {
	const marks = (sceneOf(document) as { marks?: Record<string, unknown> } | undefined)?.marks;
	const parsed = BrandKitSchema.safeParse(marks?.brand);
	return parsed.success ? parsed.data : null;
}

/** Bảng màu của visual theo kit: màu kit đứng đầu, bảng mặc định lấp phần còn lại. */
export function themeFromBrand(kit: BrandKit | null): Theme {
	if (!kit) return THEME;
	const { primary, secondary, accent, text, background } = kit.colors;
	const lead = [accent, primary, secondary];
	const palette = [...lead, ...THEME.palette.filter((color) => !lead.some((item) => item.toLowerCase() === color.toLowerCase()))].slice(0, THEME.palette.length);
	return { ...THEME, text, line: text, panel: background, accent, palette, font: kit.fonts.heading };
}

const COLOR_KEYS = new Set(['color', 'color2', 'fill', 'edges', 'background']);

/**
 * Đổi màu/font của visual từ theme `from` (mặc định: THEME của builder) sang
 * `theme`. Builder vẽ bằng THEME cố định; thay vì luồn theme qua từng builder,
 * lượt này đổi đúng các giá trị của theme cũ (chữ, nền, nhấn, bảng màu theo vị
 * trí, font) ở các khoá màu — màu người dùng tự chọn khác thì giữ nguyên. Áp lại
 * kit khác: `from` = theme của kit cũ.
 */
export function rebrand<T>(nodes: T, theme: Theme, from: Theme = THEME): T {
	if (theme === from) return nodes;
	const map = new Map<string, string>();
	from.palette.forEach((color, index) => map.set(color.toLowerCase(), theme.palette[index] ?? color));
	map.set(from.accent.toLowerCase(), theme.accent);
	map.set(from.text.toLowerCase(), theme.text);
	map.set(from.panel.toLowerCase(), theme.panel);
	const fromFont = from.font ?? 'Inter';
	const visit = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(visit);
		if (!value || typeof value !== 'object') return value;
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (COLOR_KEYS.has(key) && typeof item === 'string') out[key] = map.get(item.toLowerCase()) ?? item;
			else if (key === 'fontFamily' && item === fromFont) out[key] = theme.font ?? 'Inter';
			else out[key] = visit(item);
		}
		return out;
	};
	return visit(nodes) as T;
}
