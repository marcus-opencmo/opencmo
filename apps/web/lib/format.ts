export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function formatDuration(seconds: number | null): string {
  if (!seconds) return "—";
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type AccountUsageInput = {
  plan: string;
  credits: number;
  job_hold_credits: number;
  quota: {
    previews: { used: number; limit: number };
    exports: { used: number; limit: number };
  };
};

/** Đổi mốc reset UTC của API sang múi giờ máy đang mở giao diện. */
export function formatQuotaReset(
  iso: string,
  options: { locale?: string; timeZone?: string } = {},
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(options.locale ?? "en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: options.timeZone,
  }).format(date);
}

function quotaLeft({ used, limit }: { used: number; limit: number }): number {
  return Math.max(0, limit - used);
}

/** Một nguồn copy/số liệu cho Settings và Billing; mọi giới hạn đến từ /account. */
export function accountUsageRows(
  account: AccountUsageInput,
  resetLabel: string,
): Array<{ label: string; value: string }> {
  return [
    { label: "Plan", value: account.plan },
    { label: "Credits left", value: String(account.credits) },
    { label: "Held per video", value: String(account.job_hold_credits) },
    {
      label: "Exports left today",
      value: `${quotaLeft(account.quota.exports)} of ${account.quota.exports.limit}`,
    },
    { label: "Daily quotas reset", value: resetLabel },
  ];
}

/** Số ngày còn lại trước khi clip bị xoá. Đây là đòn bẩy bán hàng (OPUSCLIP.md §5). */
export function daysLeft(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}
