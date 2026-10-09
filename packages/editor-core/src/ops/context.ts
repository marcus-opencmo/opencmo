/**
 * Chỗ một op chạm ra ngoài document. Trình duyệt và server trả lời khác nhau
 * (OPFS + route transcript ở editor; bảng `editor_transcripts` ở route ops),
 * nhưng op thì chỉ có một bản.
 */

import type { AssetInput } from '@opencmo/clip-doc';
import type { Transcript as RenderTranscript } from '@opencmo/clip-render';

import type { Viewport } from '../reframe';
import type { Transcript } from '../transcript';

export type OpContext = {
	/** Kích thước THẬT của `master.mp4` — `set_frame` giữ đúng tỉ lệ này. Null khi chưa biết. */
	master: { width: number; height: number } | null;
	/** Đọc một transcript theo đường dẫn trong project (`assets/transcript.json`, `assets/transcripts/<hash>.json`). */
	readTranscript: (path: string) => Promise<Transcript>;
	/** Lưu một transcript, trả đường dẫn `<captions src>` trỏ tới được. */
	saveTranscript: (transcript: Transcript) => Promise<string>;
	/** Vùng canvas thật, chỉ editor có; thiếu thì camera theo công thức của bộ sinh TSX. */
	viewport?: Viewport;
	/**
	 * Độ dài nguồn và transcript đã nạp (đồng bộ) — op của timeline giải thời
	 * gian bằng đúng luật của clip-render. Thiếu thì nguồn coi như chưa biết độ
	 * dài (16 giây), như renderer.
	 */
	media?: { duration(src: AssetInput): number | null; transcript?(src: string): RenderTranscript | null };
};

/**
 * Lỗi của một op mà người dùng (hoặc agent) đọc được: câu tiếng Anh, không
 * phải stack trace. Mọi lỗi khác bị `applyOps` bọc lại thành một câu chung.
 */
export class OpFailure extends Error {
	override name = 'OpFailure';
}

/** Op thứ `index` hỏng; không có document nửa vời nào được trả về. */
export class OpError extends Error {
	override name = 'OpError';
	constructor(
		readonly index: number,
		readonly op: string,
		message: string,
	) {
		super(message);
	}
}
