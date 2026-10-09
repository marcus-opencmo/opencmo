"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function Notice({
  tone = "error",
  children,
}: {
  tone?: "error" | "info";
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`workspace-notice ${tone}`}
    >
      {children}
    </div>
  );
}

/**
 * Hộp xác nhận dùng `<dialog>` gốc: trình duyệt tự giữ focus trong hộp và đóng
 * bằng Esc. Nút an toàn nhận focus trước để Enter không xoá nhầm.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      <p>{body}</p>
      <div className="dialog-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          autoFocus
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className="danger-button"
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

export function Toast({
  message,
  onDone,
  action,
  tone = "info",
}: {
  message: string | null;
  onDone: () => void;
  /** Một việc làm tiếp ngay từ toast, ví dụ "Open" project vừa xong. */
  action?: { label: string; onClick: () => void };
  tone?: "info" | "warning";
}) {
  useEffect(() => {
    if (!message) return;
    // Có nút thì cho thêm thời gian để kịp bấm.
    const timer = setTimeout(onDone, action ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [message, onDone, action]);

  // Vùng aria-live luôn nằm trong DOM để trình đọc màn hình nhận được thay đổi.
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {message && (
        <div className={`toast ${tone === "warning" ? "is-warning" : ""}`}>
          <span>{message}</span>
          {action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                action.onClick();
                onDone();
              }}
            >
              {action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
