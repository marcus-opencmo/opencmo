import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { MarketingNav } from "@/components/marketing/MarketingNav";

/**
 * Khung bốn trang pháp lý: cùng nav/footer với landing, render tĩnh, không đọc
 * phiên đăng nhập — người duyệt của bên thanh toán phải mở được khi chưa có tài
 * khoản (docs/cmo/san-pham.md §2, luật 6).
 */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="marketing legal">
      <MarketingNav />
      {children}
      <MarketingFooter />
    </div>
  );
}
