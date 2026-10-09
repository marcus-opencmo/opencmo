"use client";

/**
 * Menu thả xuống nhỏ gọn cho shell: mục, mục con (mở khi rê chuột hay bấm),
 * phím tắt in bên phải, mục tắt. Dùng cho menu dự án và menu chuột phải.
 * Đóng khi bấm ra ngoài hay Esc.
 */

import { useEffect, useRef, useState } from "react";

export type MenuItem =
  | { kind?: "item"; label: string; shortcut?: string | null; disabled?: boolean; onSelect: () => void; testid?: string }
  | { kind: "sub"; label: string; items: MenuItem[]; testid?: string }
  | { kind: "separator" };

export function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <ul className="ed2-menu" role="menu">
      {items.map((item, index) => {
        if (item.kind === "separator") return <li key={index} className="ed2-menu-sep" role="separator" />;
        if (item.kind === "sub") {
          return (
            <li key={index} className="ed2-menu-sub" onMouseEnter={() => setOpen(index)} onMouseLeave={() => setOpen(null)}>
              <button
                type="button"
                role="menuitem"
                className="ed2-menu-item"
                aria-haspopup="menu"
                aria-expanded={open === index}
                data-testid={item.testid}
                onClick={() => setOpen(open === index ? null : index)}
              >
                <span>{item.label}</span>
                <span className="ed2-menu-key">›</span>
              </button>
              {open === index ? <MenuList items={item.items} onClose={onClose} /> : null}
            </li>
          );
        }
        return (
          <li key={index}>
            <button
              type="button"
              role="menuitem"
              className="ed2-menu-item"
              disabled={item.disabled}
              data-testid={item.testid}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              <span>{item.label}</span>
              {item.shortcut ? <span className="ed2-menu-key">{item.shortcut}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Nút mở menu + lớp menu. */
export function DropdownMenu({
  label,
  items,
  testid,
  children,
}: {
  label: string;
  items: MenuItem[];
  testid?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !box.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className="ed2-menu-root" ref={box}>
      <button
        type="button"
        className="ed2-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testid}
        onClick={() => setOpen(!open)}
      >
        {children}
      </button>
      {open ? <MenuList items={items} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** Menu chuột phải tại chỗ bấm. */
export function ContextMenu({ at, items, onClose }: { at: { x: number; y: number }; items: MenuItem[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !box.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return (
    <div ref={box} className="ed2-context" style={{ left: at.x, top: at.y }} data-testid="context-menu">
      <MenuList items={items} onClose={onClose} />
    </div>
  );
}
