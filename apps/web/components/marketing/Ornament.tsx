/**
 * Hoa văn khảm: lưới bốn cánh (quatrefoil) như sàn mosaic La Mã, nét vàng.
 * SVG inline chứ không phải background-image — một file .svg riêng thì không
 * đổi được màu theo token. Mỗi chỗ dùng cần `id` riêng vì <pattern> sống
 * chung một không gian id trong trang.
 */
export function Arabesque({ id, className = "" }: { id: string; className?: string }) {
  return (
    <svg className={`arabesque ${className}`} aria-hidden="true" focusable="false">
      <defs>
        <pattern id={id} width="64" height="64" patternUnits="userSpaceOnUse">
          <g fill="none" stroke="currentColor" strokeWidth="1.2">
            <circle cx="32" cy="21" r="11" />
            <circle cx="43" cy="32" r="11" />
            <circle cx="32" cy="43" r="11" />
            <circle cx="21" cy="32" r="11" />
            <path d="M0 12a12 12 0 0 0 12-12M52 0a12 12 0 0 0 12 12M64 52a12 12 0 0 0-12 12M12 64a12 12 0 0 0-12-12" />
          </g>
          <circle cx="32" cy="32" r="2.2" fill="currentColor" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
