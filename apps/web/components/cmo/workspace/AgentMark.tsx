/**
 * Huy hiệu tròn của department: đĩa lapis viền vàng, glyph màu đá. Cố ý không dùng
 * màu thương hiệu X (đen) hay Reddit (cam) làm trang trí — chỉ giữ hình logo X.
 */

import { Icon } from "@/components/icons";
import type { Department } from "@/lib/cmo/workspace";

// Logo X (simple-icons, CC0). Lucide không có logo thương hiệu.
const X_PATH =
  "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z";

export function AgentMark({ department, size = 30 }: { department: Department; size?: number }) {
  return (
    <span className={`cmo-mark is-${department}`} style={{ width: size, height: size }} aria-hidden="true">
      {department === "post" ? (
        <svg viewBox="0 0 24 24" width={size * 0.42} height={size * 0.42} fill="currentColor">
          <path d={X_PATH} />
        </svg>
      ) : (
        <Icon name={department === "sales" ? "message-circle" : "film"} size={Math.round(size * 0.48)} />
      )}
    </span>
  );
}
