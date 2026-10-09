"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { ApiError, api } from "../api";
import { Skeleton } from "../Skeleton";
import { formatBytes } from "@/lib/upload";

import { type AccountSummary } from "./AccountUsage";
import { ApiKeys } from "./ApiKeys";

type KitRow = { id: string; name: string; is_default: boolean };

/**
 * Tài khoản + Brand kit.
 *
 * Brand preset cũ đã gỡ hẳn (thẻ 01/10, bảng + API ở R7): Brand kit thay thế.
 *
 * Quota và credit nằm ở Billing — ở đây chỉ còn danh tính, dung lượng và một
 * lối sang Billing, để hai trang không lặp cùng một bảng số.
 */
export function SettingsView() {
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [kits, setKits] = useState<KitRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<AccountSummary>("/account")
      .then((value) => {
        if (!cancelled) setAccount(value);
      })
      .catch((err) => {
        if (!cancelled) {
          setAccountError(err instanceof ApiError ? err.message : "Could not load your account.");
        }
      });
    void api<{ kits: KitRow[] }>("/brand-kits")
      .then((value) => {
        if (!cancelled) setKits(value.kits);
      })
      .catch(() => {
        // Thẻ Brand kit chỉ là lối tắt; không đọc được thì vẫn dẫn sang trang kit.
        if (!cancelled) setKits([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const defaultKit = kits?.find((kit) => kit.is_default) ?? kits?.[0] ?? null;

  return (
    <section className="settings-view">
      <h1 className="page-title">Settings</h1>

      <div className="acct">
        <div className="settings-card">
          <h2>Account</h2>
          {accountError ? (
            <p className="field-error" role="alert">
              {accountError}
            </p>
          ) : !account ? (
            <Skeleton height={96} radius="var(--ds-radius-lg)" />
          ) : (
            <ul className="acct-list">
              <li>
                Signed in as <strong>{account.email}</strong>
              </li>
              <li>
                Plan <strong className="is-capitalized">{account.plan}</strong>
              </li>
              <li>
                Storage{" "}
                <strong>
                  {formatBytes(account.quota.storage.bytes)} / {formatBytes(account.quota.storage.limit)}
                </strong>
              </li>
              <li>
                Credits and daily limits <Link href="/app/billing">View in Billing →</Link>
              </li>
            </ul>
          )}
          <p>
            Clips and uploads are removed 7 days after a project finishes; downloads of
            whole videos are removed after 24 hours. Export what you want to keep before
            then. You are responsible for the rights to the videos you submit.
          </p>
          <form action="/auth/signout" method="post" className="settings-signout">
            <button type="submit" className="secondary-button">
              Sign out
            </button>
          </form>
        </div>

        <div className="settings-card">
          <h2>Brand kit</h2>
          {kits === null ? (
            <Skeleton height={56} radius="var(--ds-radius-lg)" />
          ) : defaultKit ? (
            <p>
              New clips use <strong>{defaultKit.name}</strong>
              {kits.length > 1 ? ` · ${kits.length} kits saved` : ""}.
            </p>
          ) : (
            <p>Set your colors, fonts, captions and logo once. Every new clip follows them.</p>
          )}
          <Link className="secondary-button" href="/app/brand">
            {defaultKit ? "Edit brand kit" : "Create a brand kit"}
          </Link>
        </div>

        <ApiKeys />
      </div>
    </section>
  );
}
