/** Đầu cột: tên bằng Fraunces + viên kim cương trạng thái (vàng = có dữ liệu), nút phụ bên phải. */

import type { ReactNode } from "react";

import { Icon, type IconName } from "@/components/icons";

export function PanelHead({
  id,
  icon,
  title,
  live,
  onCollapse,
  children,
}: {
  id: string;
  icon: IconName;
  title: string;
  /** true = có dữ liệu thật/đang chạy; false = chưa nối; undefined = không hiện. */
  live?: boolean;
  onCollapse?: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="cmo-head-bar">
      <h2 id={id}>
        <Icon name={icon} size={16} />
        {title}
        {live === undefined ? null : (
          <span className={`cmo-gem ${live ? "is-on" : ""}`} title={live ? "Connected" : "Not connected yet"}>
            <span className="sr-only">{live ? "Connected" : "Not connected yet"}</span>
          </span>
        )}
      </h2>
      <div className="cmo-head-tools">
        {children}
        {onCollapse ? (
          <button type="button" className="cmo-icon-btn" onClick={onCollapse} aria-label={`Collapse ${title}`}>
            <Icon name="chevron-left" size={16} />
          </button>
        ) : null}
      </div>
    </header>
  );
}
