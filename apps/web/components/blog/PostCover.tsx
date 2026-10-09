import { Arabesque } from "@/components/marketing/Ornament";
import { findCategory } from "@/content/blog/categories";

/**
 * Ảnh bìa của bài dựng bằng CSS + hoa văn, không phải file ảnh: lịch tự động
 * viết bài không phải tạo ảnh, mọi bìa cùng một hệ, và không tốn byte nào.
 * Mỗi category một phối màu để lưới bài nhìn ra nhóm ngay.
 */
export function PostCover({ slug, category, size = "card" }: { slug: string; category: string; size?: "card" | "feature" }) {
  const name = findCategory(category)?.name ?? category;
  return (
    <div className={`post-cover is-${category} is-${size}`} aria-hidden="true">
      <Arabesque id={`cover-${size}-${slug}`} />
      <span className="post-cover-seal">{name.charAt(0)}</span>
      <span className="post-cover-label">{name}</span>
    </div>
  );
}
