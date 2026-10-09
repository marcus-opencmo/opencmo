/**
 * Khối giữ chỗ trong lúc chờ dữ liệu.
 *
 * Thay cho dòng `Loading…` trần. Một dòng chữ nói "đang chờ" nhưng không nói
 * sắp có gì, nên màn hình vẫn nhảy một cái khi dữ liệu về; khối giữ chỗ mang
 * đúng hình dạng của thứ sắp thay nó, nên bố cục đứng yên.
 *
 * Không có `"use client"`: đây là markup thuần, và `loading.tsx` — server
 * component — cũng dùng chính nó.
 */

export function Skeleton({
  width,
  height = 14,
  radius,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
}) {
  return (
    <span
      className="skeleton"
      aria-hidden="true"
      style={{ width, height, borderRadius: radius }}
    />
  );
}

type Variant = "library" | "settings" | "project" | "billing" | "create";

/**
 * Khung giữ chỗ cho cả một màn. Dùng ở hai chỗ khác nhau nhưng cùng hình dạng:
 * `loading.tsx` (trong lúc server trả về) và trạng thái rỗng của view (trong
 * lúc `api()` chạy ngay sau đó). Hai lỗ khác nhau, một bộ hình dạng.
 */
export function PageSkeleton({ variant }: { variant: Variant }) {
  if (variant === "library") {
    return (
      <div className="skeleton-page" role="status" aria-label="Loading">
        <Skeleton width={180} height={28} />
        <div className="skeleton-grid">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} height={168} radius="var(--ds-radius-panel)" />
          ))}
        </div>
      </div>
    );
  }
  if (variant === "project") {
    return (
      <div className="skeleton-page" role="status" aria-label="Loading">
        <Skeleton width={220} height={13} />
        <Skeleton width={320} height={24} />
        <Skeleton height={220} radius="var(--ds-radius-panel)" />
      </div>
    );
  }
  return (
    <div className="skeleton-page" role="status" aria-label="Loading">
      <Skeleton width={200} height={28} />
      <Skeleton height={140} radius="var(--ds-radius-panel)" />
      <Skeleton height={140} radius="var(--ds-radius-panel)" />
    </div>
  );
}
