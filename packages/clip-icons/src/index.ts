/**
 * Thư viện icon của visual (spec visuals-2 L2): Lucide (ISC), mỗi icon một
 * chuỗi `d` trong hệ 24×24, nét dày 2 — vẽ bằng node `path` của clip-doc, kể
 * cả animation vẽ nét.
 *
 * Dữ liệu (~1.800 icon) nạp LƯỜI: editor chỉ tải khi mở tìm icon hay chạy
 * `add_icon`, không nằm trong bundle đầu của trang.
 */

export type IconData = { d: string; tags: string[] };
type Library = { source: string; license: string; icons: Record<string, IconData> };

let loaded: Promise<Library> | null = null;
function library(): Promise<Library> {
	loaded ??= import('../data/icons.json', { with: { type: 'json' } }).then((module) => (module as { default: Library }).default);
	return loaded;
}

/** Hệ toạ độ và nét của mọi icon. */
export const ICON_BOX = 24;
export const ICON_STROKE = 2;

export async function iconPath(name: string): Promise<string | null> {
	return (await library()).icons[name]?.d ?? null;
}

export type IconMatch = { name: string; tags: string[] };

/**
 * Tìm theo tên và tag: khớp nguyên tên > tên chứa từ > tag chứa từ. Nhiều từ
 * thì icon phải khớp mọi từ ("bow arrow" → bow-arrow trước arrow-*).
 */
export async function findIcons(query: string, limit = 24): Promise<IconMatch[]> {
	const words = query.toLowerCase().split(/[\s,-]+/).filter(Boolean);
	if (!words.length) return [];
	const scored: { name: string; tags: string[]; score: number }[] = [];
	for (const [name, icon] of Object.entries((await library()).icons)) {
		const parts = name.split('-');
		let score = 0;
		let all = true;
		for (const word of words) {
			if (parts.includes(word)) score += 10;
			else if (name.includes(word)) score += 5;
			else if (icon.tags.some((tag) => tag === word)) score += 4;
			else if (icon.tags.some((tag) => tag.includes(word))) score += 2;
			else all = false;
		}
		if (!all) continue;
		if (name === words.join('-')) score += 50;
		// Tên ngắn hơn là icon "chính" (arrow-up trước arrow-up-from-dot).
		scored.push({ name, tags: icon.tags, score: score - parts.length * 0.5 });
	}
	return scored
		.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
		.slice(0, limit)
		.map(({ name, tags }) => ({ name, tags }));
}

export async function iconCount(): Promise<number> {
	return Object.keys((await library()).icons).length;
}
