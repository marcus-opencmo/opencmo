// wawoff2 (MIT) không kèm kiểu: chỉ dùng `decompress` woff2 → TTF.
declare module 'wawoff2' {
	export function decompress(input: Uint8Array): Promise<Uint8Array>;
}
