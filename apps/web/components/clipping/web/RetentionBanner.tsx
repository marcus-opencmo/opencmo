"use client";

/**
 * Báo trước luật xoá tài khoản free (09/10/2026): chưa từng mua thì 30 ngày sau bị xoá cùng mọi
 * dữ liệu. Không gửi email, nên dải này là lời báo duy nhất — luôn hiện cho tới khi mua.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import { api } from "../api";

const DAY = 86_400_000;

export function RetentionBanner({ billingHref }: { billingHref: string }) {
  const [deleteAfter, setDeleteAfter] = useState<Date | null>(null);

  useEffect(() => {
    void api<{ paid: boolean; delete_after: string | null }>("/account/retention")
      .then((body) => setDeleteAfter(body.paid || !body.delete_after ? null : new Date(body.delete_after)))
      .catch(() => setDeleteAfter(null));
  }, []);

  if (!deleteAfter) return null;
  const days = Math.max(0, Math.ceil((deleteAfter.getTime() - Date.now()) / DAY));
  const date = deleteAfter.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  return (
    <div className={`retention-banner${days <= 7 ? " is-urgent" : ""}`} role="status" data-testid="retention-banner">
      <span>
        Free accounts are deleted 30 days after sign-up. Yours and all its projects will be deleted on <strong>{date}</strong>
        {` (${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} left`})`} unless you buy a plan.
      </span>
      <Link href={billingHref}>See plans</Link>
    </div>
  );
}
