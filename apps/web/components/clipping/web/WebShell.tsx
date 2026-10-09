"use client";

/**
 * Khung điều hướng của `/app`.
 *
 * Khác bản local ở một điểm: mỗi màn có URL riêng (`/app`, `/app/projects`,
 * `/app/projects/<id>`, …) thay vì `?view=` trong một trang duy nhất. Deep link
 * là thứ người dùng gửi cho nhau và bookmark — và là thứ Playwright mở thẳng.
 *
 * Component này do `app/app/layout.tsx` render, nên nó sống xuyên suốt điều
 * hướng. Hai hệ quả kéo theo, cả hai đều được xử lý ở đây:
 *
 *   1. Mục đang sáng không thể đến từ prop của trang nữa — prop tới cùng lúc
 *      với trang mới, tức là sau một vòng server. Suy từ segment thì rail sáng
 *      ngay khi router nhận cú bấm.
 *   2. Số credit không còn được làm mới nhờ remount. Phải tự đọc lại đúng lúc
 *      nó đổi: khi tạo job và khi job kết toán.
 */

import { useRouter, useSearchParams, useSelectedLayoutSegment } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useApplyTheme } from "@/components/theme";

import { api } from "../api";
import { WorkspaceShell, type WorkspaceNavView } from "../WorkspaceShell";

const HREF: Record<WorkspaceNavView, string> = {
  home: "/app",
  plan: "/app?doc=product",
  // "New clips" không còn trên rail (G1-c); phím N vẫn mở tab Clips của editor.
  video: "/app/editor?panel=clips",
  editor: "/app/editor",
  projects: "/app/projects",
  brand: "/app/brand",
  settings: "/app/settings",
  billing: "/app/billing",
};

/**
 * Segment ngay dưới `app/app/` — đúng độ mịn rail cần.
 *
 * `/app/projects/<id>` gom về `"projects"`, `/app/editor/<clip>` về `"editor"`,
 * nên không cần chuỗi `startsWith` nào, và `/app` không thể sáng cùng lúc với
 * `/app/projects` như khi so khớp đường dẫn bằng tiền tố.
 */
const NAV_BY_SEGMENT: Record<string, WorkspaceNavView> = {
  cmo: "plan",
  video: "editor",
  editor: "editor",
  projects: "projects",
  brand: "brand",
  settings: "settings",
  billing: "billing",
};

function navViewFor(segment: string | null, doc: string | null): WorkspaceNavView | null {
  // Marketing plan là sheet trên `/app` (`?doc=`), không phải trang riêng.
  if (segment === null) return doc ? "plan" : "home";
  // `jobs/<id>` là redirect cũ: không mục nào sáng còn hơn sáng nhầm.
  return NAV_BY_SEGMENT[segment] ?? null;
}

/** Chỉ `credits` và `plan` đổi trong một phiên; email và userId thì không. */
type ShellAccountState = {
  credits: number | null;
  plan: string | null;
  userId: string | null;
  refreshAccount: () => void;
};

const ShellAccountContext = createContext<ShellAccountState | null>(null);

/** Dùng ở màn tạo job để số credit trừ ngay, không đợi tới lần điều hướng sau. */
export function useShellAccount(): ShellAccountState {
  const value = useContext(ShellAccountContext);
  if (!value) throw new Error("useShellAccount must be used inside WebShell");
  return value;
}

type AccountSummary = { credits: number; plan: string; cmo_pending: number | null };

export function WebShell({
  credits,
  plan,
  email,
  userId,
  pending,
  children,
}: {
  // Số credit hiện ở MỌI màn hình, không giấu trong trang billing —
  // OPUSCLIP.md §5: khan hiếm thường trực là cơ chế bán hàng rẻ nhất.
  credits?: number | null;
  plan?: string | null;
  email?: string | null;
  /** Dùng để nghe job đang chạy của chính người này qua Realtime. */
  userId?: string | null;
  /** Việc CMO chờ duyệt (dòng phụ của Dashboard trên rail). */
  pending?: number | null;
  children: ReactNode;
}) {
  useApplyTheme();
  const router = useRouter();
  const segment = useSelectedLayoutSegment();
  const doc = useSearchParams().get("doc");
  // Server đã đặt số đúng vào HTML đầu tiên; state chỉ giữ các lần đổi sau đó.
  const [live, setLive] = useState<{ credits: number | null; plan: string | null; pending: number | null }>({
    credits: credits ?? null,
    plan: plan ?? null,
    pending: pending ?? null,
  });
  const reading = useRef(false);

  const refreshAccount = useCallback(() => {
    if (reading.current) return;
    reading.current = true;
    // `account_summary` dựng `credits` bằng đúng hàm `credit_balance()` mà
    // query server của shell gọi, nên hai mặt không thể lệch nhau.
    void api<AccountSummary>("/account")
      .then((account) => setLive({ credits: account.credits, plan: account.plan, pending: account.cmo_pending }))
      .catch(() => {
        // Chỉ báo phụ: hỏng thì giữ số cũ. Một banner lỗi ở khung ngoài sẽ che
        // mất lỗi thật của màn hình người dùng đang làm việc.
      })
      .finally(() => {
        reading.current = false;
      });
  }, []);

  // Quay lại tab là lúc số dư dễ cũ nhất: Realtime và polling đều bị trình duyệt
  // hãm khi tab ẩn, nên một lần kết toán có thể trôi qua mà shell không hay.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshAccount();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refreshAccount]);

  return (
    <ShellAccountContext.Provider
      value={{ credits: live.credits, plan: live.plan, userId: userId ?? null, refreshAccount }}
    >
      <WorkspaceShell
        activeView={navViewFor(segment, doc)}
        credits={live.credits}
        plan={live.plan}
        pending={live.pending}
        email={email}
        userId={userId}
        hrefFor={(item) => HREF[item]}
        onSettled={refreshAccount}
        onOpenProject={(id) => router.push(`/app/projects/${id}`)}
      >
        {children}
      </WorkspaceShell>
    </ShellAccountContext.Provider>
  );
}
