/**
 * 32 họ font tự host mà người dùng chọn được (checklist TXT-02; 22 họ sau thêm
 * cho Brand Kit bằng `apps/web/scripts/fetch-fonts.mts`, giấy phép ở
 * `LICENSE-OFL.txt`). File variable woff2 subset latin, dải weight đo từ bảng
 * `fvar` của chính file; các họ một weight là font display tĩnh. Chỉ Inter có mặt NGHIÊNG THẬT (`italic`), như trong editor fork, nơi giao
 * diện khai báo sẵn nó. Các họ khác nghiêng giả do trình vẽ tự làm.
 *
 * File nằm ở `packages/clip-media/fonts` (trình duyệt nạp bản chép ở `/fonts/`, worker đọc
 * thẳng thư mục đó — `OPENCMO_EDITOR_FONTS`).
 */

/**
 * `emTop`: đỉnh hộp em nằm trên baseline chữ bao nhiêu, tính theo cỡ chữ. Đo
 * bằng Chromium (`measureText(…).alphabeticBaseline` với `textBaseline = "top"`).
 * Hộp em luôn cao đúng một cỡ chữ, nên `middle` = emTop − ½ và `bottom` =
 * emTop − 1. Skia của Node đặt `top` theo cách khác (lệch tới 16 px ở 100 px), nên
 * ở Node renderer vẽ theo baseline chữ rồi tự dời bằng con số này. Phần lớn
 * font thì emTop = ascent / (ascent + descent). Chewy thì không: Chromium lấy
 * hộp em từ bảng số đo khác của font. Vì vậy bảng giữ số đo được, không tự tính.
 */
export const FONTS = {
  Inter: { file: 'inter.woff2', italic: 'inter-italic.ttf', weights: [100, 900], emTop: 0.8006 },
  Montserrat: { file: 'montserrat.woff2', weights: [100, 900], emTop: 0.7941 },
  Bangers: { file: 'bangers.woff2', weights: [400, 400], emTop: 0.8298 },
  Chewy: { file: 'chewy.woff2', weights: [400, 400], emTop: 0.7223 },
  Figtree: { file: 'figtree.woff2', weights: [300, 900], emTop: 0.7917 },
  Geologica: { file: 'geologica.woff2', weights: [100, 900], emTop: 0.78 },
  Lora: { file: 'lora.woff2', weights: [400, 700], emTop: 0.7859 },
  Nunito: { file: 'nunito.woff2', weights: [200, 1000], emTop: 0.7413 },
  'Source Code Pro': { file: 'source-code-pro.woff2', weights: [200, 900], emTop: 0.7828 },
  Urbanist: { file: 'urbanist.woff2', weights: [100, 900], emTop: 0.7917 },
	'Anton': { file: 'anton.woff2', weights: [400, 400], emTop: 0.7814 },
	'Bebas Neue': { file: 'bebas-neue.woff2', weights: [400, 400], emTop: 0.75 },
	'Archivo Black': { file: 'archivo-black.woff2', weights: [400, 400], emTop: 0.807 },
	'DM Serif Display': { file: 'dm-serif-display.woff2', weights: [400, 400], emTop: 0.7556 },
	'Caveat Brush': { file: 'caveat-brush.woff2', weights: [400, 400], emTop: 0.7619 },
	'Pacifico': { file: 'pacifico.woff2', weights: [400, 400], emTop: 0.742 },
	'Oswald': { file: 'oswald.woff2', weights: [200, 700], emTop: 0.805 },
	'Raleway': { file: 'raleway.woff2', weights: [100, 900], emTop: 0.8006 },
	'Rubik': { file: 'rubik.woff2', weights: [300, 900], emTop: 0.7891 },
	'Work Sans': { file: 'work-sans.woff2', weights: [100, 900], emTop: 0.7928 },
	'Manrope': { file: 'manrope.woff2', weights: [200, 800], emTop: 0.7803 },
	'Plus Jakarta Sans': { file: 'plus-jakarta-sans.woff2', weights: [200, 800], emTop: 0.8238 },
	'Sora': { file: 'sora.woff2', weights: [100, 800], emTop: 0.7698 },
	'Outfit': { file: 'outfit.woff2', weights: [100, 900], emTop: 0.7936 },
	'Lexend': { file: 'lexend.woff2', weights: [100, 900], emTop: 0.8 },
	'Space Grotesk': { file: 'space-grotesk.woff2', weights: [300, 700], emTop: 0.7711 },
	'DM Sans': { file: 'dm-sans.woff2', weights: [100, 1000], emTop: 0.7619 },
	'Playfair Display': { file: 'playfair-display.woff2', weights: [400, 900], emTop: 0.8117 },
	'Archivo': { file: 'archivo.woff2', weights: [100, 900], emTop: 0.807 },
	'Unbounded': { file: 'unbounded.woff2', weights: [200, 900], emTop: 0.8023 },
	'Fraunces': { file: 'fraunces.woff2', weights: [100, 900], emTop: 0.7931 },
	'Caveat': { file: 'caveat.woff2', weights: [400, 700], emTop: 0.7619 },
} as const satisfies Record<string, { file: string; italic?: string; weights: readonly [number, number]; emTop: number }>;

export type FontFamily = keyof typeof FONTS;
