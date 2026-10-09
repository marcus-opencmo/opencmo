import { AccountUsageLoader } from "@/components/clipping/web/AccountUsage";
import { LocalTime } from "@/components/LocalTime";

import { PLANS, checkoutUrlFor, planById } from "@/lib/pricing";
import { createServerClient } from "@/lib/supabase/server";
import type { LedgerEntry } from "@/lib/types";

/**
 * Trang này KHÔNG tự kiểm đăng nhập và KHÔNG tự đọc số dư: `app/app/layout.tsx`
 * đã redirect và đã nạp cả hai cho shell. Đọc lại ở đây là thêm một `getUser()`
 * và một `credit_balance()` cho mỗi lần mở trang, để ra đúng con số shell đang
 * hiển thị. Ô "Balance" bên dưới đọc `/api/v1/account` phía client như cũ.
 *
 * RLS đã lọc theo người đăng nhập, nên sổ cái không cần điều kiện `user_id`.
 */
export default async function BillingPage() {
  const supabase = await createServerClient();

  const [{ data: profile }, { data: ledger }] = await Promise.all([
    // `id` và `email` để dựng link checkout: xem `checkoutUrlFor`. RLS chỉ trả
    // đúng hàng của người đang đăng nhập, nên không cần thêm một `getUser()`.
    supabase
      .from("profiles")
      .select("id, email, plan")
      .maybeSingle<{ id: string; email: string | null; plan: string }>(),
    supabase
      .from("credit_ledger")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(30)
      .returns<LedgerEntry[]>(),
  ]);

  const planId = profile?.plan ?? "free";
  const current = planById(planId);

  return (
    <section className="billing-view">
      <h1 className="page-title">Credits and plan</h1>
      <p className="page-sub">
        1 credit = 1 minute of source video.
        {current?.watermark ? " Free clips carry a watermark." : ""}
      </p>

      <div className="acct">
        <div className="settings-card">
          <h2>Balance</h2>
          <AccountUsageLoader emphasizeCredits />
        </div>
      </div>

      <h2 className="section-label">Plans</h2>
      <div className="plan-grid">
        {PLANS.map((plan) => {
          const isCurrent = plan.id === planId;
          const checkoutUrl = profile
            ? checkoutUrlFor(plan, profile.id, profile.email)
            : undefined;
          return (
            <div
              key={plan.id}
              className={plan.highlight ? "settings-card is-featured" : "settings-card"}
            >
              <h2>
                {plan.name}
                {plan.highlight && !isCurrent && <span className="plan-tag">Recommended</span>}
              </h2>
              <p className="plan-price">
                {/* Giá gạch ngang là THƯỜNG TRỰC, không phải khuyến mãi có hạn
                    — OPUSCLIP.md §3.10. */}
                {plan.listPrice ? <del>${plan.listPrice}</del> : null}
                <strong>${plan.price}</strong>
                <span>/mo</span>
              </p>
              {plan.interval === "year" && <p className="plan-billed">Billed ${plan.billedPrice} once a year</p>}
              <ul className="acct-list">
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              {isCurrent ? (
                <p className="plan-cta is-current">Current plan</p>
              ) : checkoutUrl ? (
                <a href={checkoutUrl} className="primary-button plan-cta">
                  Upgrade
                </a>
              ) : (
                // Chưa cấu hình link Polar: nói thật thay vì để nút chết. Tạo
                // sản phẩm trên Polar rồi điền POLAR_CHECKOUT_* là nút sống lại.
                <p className="plan-cta is-soon">Coming soon</p>
              )}
            </div>
          );
        })}
      </div>

      <h2 className="section-label">Credit history</h2>

      {!ledger?.length ? (
        <p className="empty-state">No transactions yet.</p>
      ) : (
        <ul className="history">
          {ledger.map((row) => (
            <li key={row.id}>
              <LocalTime iso={row.created_at} />
              <span>{row.reason}</span>
              <b className={row.delta > 0 ? "is-credit" : undefined}>
                {row.delta > 0 ? `+${row.delta}` : row.delta}
              </b>
            </li>
          ))}
        </ul>
      )}
  </section>
  );
}
