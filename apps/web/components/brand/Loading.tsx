/**
 * Trạng thái chờ có mặt nhân vật.
 *
 * Trước đây mọi chỗ chờ đều là một dòng `<p>Loading…</p>`. Nó đúng nhưng đứng
 * im, mà đứng im là tín hiệu người dùng đọc thành "hỏng rồi" — nhất là ở màn
 * xử lý, nơi phải chờ hai tới ba phút.
 *
 * Ảnh động dùng WebP trong thẻ `<img>`, KHÔNG dùng `.webm`: `<img>` không cần
 * autoplay, không cần JS, và `img-src 'self'` trong CSP đã cho phép sẵn.
 *
 * `prefers-reduced-motion` xử lý bằng `<picture>` chứ không bằng CSS: công tắc
 * `animation: none !important` ở `styles/design-system.css` chỉ tắt được CSS
 * animation, nó KHÔNG dừng được ảnh WebP động. Đổi hẳn `src` sang ảnh tĩnh là
 * cách duy nhất thật sự dừng chuyển động ở đây.
 */

export function MascotSpinner({ size = 64 }: { size?: number }) {
  return (
    <picture>
      <source srcSet="/mascot/loading-poster.png" media="(prefers-reduced-motion: reduce)" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="mascot-spinner"
        src="/mascot/opencmo-loading.webp"
        width={size}
        height={size}
        alt=""
      />
    </picture>
  );
}

/** Chờ có kèm một câu trạng thái. `label` là chữ người dùng đọc, nên để tiếng Anh. */
export function Loading({ label, size = 64 }: { label: string; size?: number }) {
  return (
    <p className="loading-state" role="status">
      <MascotSpinner size={size} />
      <span>{label}</span>
    </p>
  );
}
