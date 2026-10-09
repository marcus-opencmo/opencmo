"use client";

import * as React from "react";
import { useEffect, useState } from "react";

import {
  accountUsageRows,
  formatQuotaReset,
  type AccountUsageInput,
} from "@/lib/format";
import { formatBytes } from "@/lib/upload";

import { ApiError, api } from "../api";
import { Skeleton } from "../Skeleton";

export type AccountSummary = AccountUsageInput & {
  email: string;
  resets_at: string;
  quota: AccountUsageInput["quota"] & {
    storage: { bytes: number; limit: number; objects: number; objectLimit: number };
  };
};

export function AccountUsage({
  account,
  showIdentity = false,
  showStorage = false,
  emphasizeCredits = false,
}: {
  account: AccountSummary;
  showIdentity?: boolean;
  showStorage?: boolean;
  emphasizeCredits?: boolean;
}) {
  const rows = accountUsageRows(account, formatQuotaReset(account.resets_at));
  const visibleRows = emphasizeCredits
    ? rows.filter((row) => row.label !== "Credits left")
    : rows;

  return (
    <>
      {emphasizeCredits && <p className="acct-figure">{account.credits}</p>}
      {/* Đổi con số ra thứ người dùng hiểu: bao nhiêu phút video. Sắp hết thì
          nói thẳng, ngay chỗ họ đang nhìn. */}
      {emphasizeCredits && (
        <p className={`acct-hint ${account.credits < account.job_hold_credits * 2 ? "is-low" : ""}`}>
          {account.credits < account.job_hold_credits
            ? `A new project needs ${account.job_hold_credits} credits. Pick a plan below to keep clipping.`
            : `Enough for about ${account.credits} ${account.credits === 1 ? "minute" : "minutes"} of video.`}
        </p>
      )}
      <ul className="acct-list">
        {showIdentity && (
          <li>
            Signed in as <strong>{account.email}</strong>
          </li>
        )}
        {visibleRows.map((row) => (
          <li key={row.label}>
            {row.label} <strong>{row.value}</strong>
          </li>
        ))}
        {showStorage && (
          <li>
            Storage{" "}
            <strong>
              {formatBytes(account.quota.storage.bytes)} / {formatBytes(account.quota.storage.limit)}
            </strong>
          </li>
        )}
      </ul>
    </>
  );
}

/** Billing đọc cùng hợp đồng /account như Settings và editor. */
export function AccountUsageLoader({ emphasizeCredits = false }: { emphasizeCredits?: boolean }) {
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<AccountSummary>("/account")
      .then((summary) => {
        if (!cancelled) setAccount(summary);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Could not load your usage.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="field-error">{error}</p>;
  if (!account) return <Skeleton height={72} radius="var(--ds-radius-lg)" />;
  return <AccountUsage account={account} emphasizeCredits={emphasizeCredits} />;
}
