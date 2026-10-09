import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { MarketingNav } from "@/components/marketing/MarketingNav";

/**
 * Khung blog: cùng nav/footer với landing nhưng KHÔNG đọc phiên đăng nhập —
 * mọi trang blog render tĩnh lúc build và phục vụ thẳng từ CDN.
 */
export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="marketing blog">
      <MarketingNav section="blog" />
      {children}
      <MarketingFooter />
    </div>
  );
}
