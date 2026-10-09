"use client";

/**
 * Lỗi của một màn không được kéo theo cả khung.
 *
 * Từ lúc rail và top bar chuyển lên `layout.tsx`, một throw trong page sẽ hạ cả
 * tài liệu nếu không có ranh giới nào chặn. Đặt ranh giới ở khe `children` giữ
 * rail sống, và người dùng còn đường đi tiếp thay vì một trang trắng.
 */
export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <section className="empty-state">
      <p>Something went wrong on this screen.</p>
      <button type="button" className="primary-button" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
