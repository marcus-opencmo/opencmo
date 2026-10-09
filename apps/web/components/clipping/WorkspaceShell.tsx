"use client";

/**
 * Khung của phần đăng nhập: rail bên trái + top bar + vùng nội dung.
 *
 * Trước 18/09 đây là header ngang. Đổi sang rail vì hai lý do, không phải vì
 * đẹp hơn: (1) rail còn chỗ cho nhóm "Agents" của v2 mà không phải xếp lại
 * điều hướng, (2) top bar giữ được số credit và banner gói ở đúng một chỗ trên
 * MỌI màn hình — OPUSCLIP.md §5 gọi đây là cơ chế bán hàng rẻ nhất.
 *
 * Rail chỉ liệt kê thứ đã chạy được — không có mục "Soon" (luật sản phẩm 1).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Icon, type IconName } from "@/components/icons";
import { ThemeSwitch } from "@/components/theme";
import { JOB_HOLD_CREDITS } from "@/lib/credits";

import { ActiveJobChip, useActiveJobs } from "./ActiveJobs";
import { Toast } from "./ui";
import { RetentionBanner } from "./web/RetentionBanner";

export type WorkspaceNavView = "home" | "plan" | "video" | "editor" | "projects" | "brand" | "settings" | "billing";

type NavEntry = { view: WorkspaceNavView; label: string; icon: IconName };

/**
 * Hai cửa chính của sản phẩm (design 06/10/2026): Dashboard là AI CMO, Editor
 * là chỗ làm video. Chúng to hơn mục thường và có dòng phụ, vì người không
 * chuyên cần biết NGAY nên bấm vào đâu. "Marketing plan" không còn trên rail:
 * nó là sheet mở trên Dashboard (`?doc=`), vào từ menu dự án và cột Brief.
 */
const MAIN: (NavEntry & { hint: string })[] = [
  { view: "home", label: "Dashboard", icon: "chart-column", hint: "AI CMO" },
  { view: "editor", label: "Editor", icon: "clapperboard", hint: "Clips, captions, timeline" },
];

const VIDEO: NavEntry[] = [
  { view: "projects", label: "My projects", icon: "folder" },
  { view: "brand", label: "Brand kit", icon: "palette" },
];

const FOOT: NavEntry[] = [
  { view: "billing", label: "Credits & plan", icon: "zap" },
  { view: "settings", label: "Settings", icon: "settings" },
];

const RAIL_STORAGE_KEY = "opencmo.rail";
const BANNER_KEY = "opencmo.plan-banner-hidden";

/** Đang gõ ở đâu đó: phím tắt một chữ cái phải nhường cho ô nhập. */
function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

function initials(email: string | null | undefined): string {
  const name = email?.split("@")[0] ?? "";
  const parts = name.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name.slice(0, 2) || "OC").toUpperCase();
}

export function WorkspaceShell({
  activeView,
  children,
  hrefFor,
  credits,
  plan,
  pending = null,
  email,
  userId = null,
  onSettled,
  onOpenProject,
}: {
  /** Null khi URL không thuộc mục nào — thà không sáng còn hơn sáng nhầm. */
  activeView: WorkspaceNavView | null;
  children: ReactNode;
  /** Đường dẫn web thật cho từng mục. */
  hrefFor: (view: WorkspaceNavView) => string;
  credits?: number | null;
  plan?: string | null;
  /** Việc CMO chờ duyệt; null khi chưa biết — khi đó dòng phụ chỉ ghi "AI CMO". */
  pending?: number | null;
  email?: string | null;
  /** Null khi chưa đăng nhập — khi đó không nghe job của ai cả. */
  userId?: string | null;
  /** Gọi khi một job vừa kết toán: lúc đó và chỉ lúc đó số credit mới đổi. */
  onSettled?: () => void;
  onOpenProject?: (projectId: string) => void;
}) {
  const router = useRouter();
  const { active, toast, clearToast } = useActiveJobs(userId, onSettled);
  const accountMenu = useRef<HTMLDetailsElement>(null);
  const [bannerHidden, setBannerHidden] = useState(false);
  useLayoutEffect(() => {
    try {
      if (window.sessionStorage.getItem(BANNER_KEY) === "1") setBannerHidden(true);
    } catch {
      // Storage bị chặn: banner hiện như cũ.
    }
  }, []);

  const hrefRef = useRef(hrefFor);
  hrefRef.current = hrefFor;

  // Phím tắt: "N" tạo clip mới, "/" tìm project. Không chạy trong editor (nó có
  // bảng phím riêng) và không chạy khi người dùng đang gõ.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (typingIn(event.target) || document.querySelector(".ed2")) return;
      if (event.key === "n" || event.key === "N") {
        event.preventDefault();
        router.push(hrefRef.current("video"));
      } else if (event.key === "/") {
        event.preventDefault();
        const search = document.querySelector<HTMLInputElement>("[data-project-search]");
        if (search) search.focus();
        else router.push(hrefRef.current("projects"));
      } else if (event.key === "Escape" && accountMenu.current?.open) {
        accountMenu.current.open = false;
      }
    }
    // Bấm ra ngoài thì đóng menu tài khoản.
    function onClick(event: MouseEvent) {
      const menu = accountMenu.current;
      if (menu?.open && !menu.contains(event.target as Node)) menu.open = false;
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [router]);
  const toastAction = useMemo(
    () => (toast && onOpenProject ? { label: "Open", onClick: () => onOpenProject(toast.projectId) } : undefined),
    // `onOpenProject` là hàm mới mỗi lần cha render; hành động chỉ đổi theo toast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast],
  );

  // Tab đang ẩn khi job xong: tiêu đề tab là chỗ duy nhất người dùng còn nhìn
  // thấy. Trả lại tiêu đề cũ ngay khi họ quay về.
  useEffect(() => {
    if (!toast || !document.hidden) return;
    const original = document.title;
    document.title = `${toast.tone === "warning" ? "⚠" : "✓"} ${toast.text}`;
    const restore = () => {
      if (!document.hidden) {
        document.title = original;
        document.removeEventListener("visibilitychange", restore);
      }
    };
    document.addEventListener("visibilitychange", restore);
    return () => document.removeEventListener("visibilitychange", restore);
  }, [toast]);
  // Mặc định mở. Người dùng thu lại thì nhớ — nhưng chỉ sau khi mount, nếu
  // không HTML của server và của client sẽ khác nhau.
  const [open, setOpen] = useState(true);
  useLayoutEffect(() => {
    try {
      if (window.localStorage.getItem(RAIL_STORAGE_KEY) === "closed") setOpen(false);
    } catch {
      // Trình duyệt chặn storage: cứ để rail mở.
    }
  }, []);

  // Màn AI CMO (`home`) cần đủ bề rộng cho 4 cột: rail luôn thu thành cột icon
  // ở đó, và bấm mở chỉ có hiệu lực trong lượt xem — không ghi đè lựa chọn đã lưu
  // cho các màn khác.
  // "plan" là sheet marketing plan mở NGAY TRÊN màn này (`/app?doc=`), cùng 4 cột.
  // Editor (E0) cũng cần cả bề ngang: timeline, canvas, inspector đứng cạnh nhau.
  const bleed = activeView === "home" || activeView === "plan" || activeView === "editor";
  const [homeOpen, setHomeOpen] = useState(false);
  const railOpen = bleed ? homeOpen : open;

  function toggle() {
    if (bleed) {
      setHomeOpen((was) => !was);
      return;
    }
    setOpen((was) => {
      const next = !was;
      // Thuộc tính trên `<html>` là thứ script khởi động đọc ở lần tải sau;
      // giữ nó khớp ngay tại đây thay vì đợi lần mount kế tiếp.
      if (next) delete document.documentElement.dataset.rail;
      else document.documentElement.dataset.rail = "closed";
      try {
        window.localStorage.setItem(RAIL_STORAGE_KEY, next ? "open" : "closed");
      } catch {
        // Không lưu được thì thôi, trạng thái vẫn đúng trong phiên này.
      }
      return next;
    });
  }

  const planName = plan ? plan[0].toUpperCase() + plan.slice(1) : "Free";
  const isFree = (plan ?? "free") === "free";

  // Marketing plan là sheet trên Dashboard, nên mở nó vẫn sáng Dashboard.
  const isCurrent = (view: WorkspaceNavView) => activeView === view || (view === "home" && activeView === "plan");

  const mainItem = (entry: NavEntry & { hint: string }) => (
    <Link
      key={entry.view}
      className="rail-main"
      href={hrefFor(entry.view)}
      aria-current={isCurrent(entry.view) ? "page" : undefined}
      title={railOpen ? undefined : entry.label}
    >
      <span className="rail-main-chip">
        <Icon name={entry.icon} size={18} />
      </span>
      <span className="rail-label rail-main-text">
        <b>{entry.label}</b>
        <small>{entry.view === "home" && pending ? `${entry.hint} · ${pending} waiting` : entry.hint}</small>
      </span>
    </Link>
  );

  const item = (entry: NavEntry) => {
    const current = isCurrent(entry.view);
    return (
      <Link
        key={entry.view}
        className="rail-item"
        href={hrefFor(entry.view)}
        aria-current={current ? "page" : undefined}
        title={railOpen ? undefined : entry.label}
      >
        <span className="rail-glyph">
          <Icon name={entry.icon} size={17} />
        </span>
        <span className="rail-label">{entry.label}</span>
        {entry.view === "projects" && active.length > 0 && (
          <span className="rail-badge" aria-label={`${active.length} processing`}>
            {active.length}
          </span>
        )}
        {entry.view === "billing" && credits !== null && credits !== undefined && (
          <span className="rail-label rail-count" aria-label={`${credits} credits left`}>
            {credits}
          </span>
        )}
      </Link>
    );
  };

  return (
    <div className="ws" data-bleed={bleed || undefined} data-view={activeView ?? undefined}>
      <aside className={railOpen ? "rail is-open" : "rail"}>
        <div className="rail-top">
          <Link className="rail-mark" href={hrefFor("home")}>
            <img src="/icon.svg" alt="" width={24} height={24} />
            <span className="rail-label">OpenCMO</span>
          </Link>
          <button
            type="button"
            className="rail-toggle"
            aria-label={railOpen ? "Collapse sidebar" : "Expand sidebar"}
            aria-expanded={railOpen}
            onClick={toggle}
          >
            <Icon name={railOpen ? "panel-left-close" : "panel-left-open"} size={15} />
          </button>
        </div>

        {/* Khối tài khoản mở một menu nhỏ: trước đây nó chỉ để nhìn, và không
            có chỗ nào trong app để đăng xuất. */}
        <details className="rail-account-menu" ref={accountMenu}>
          <summary className="rail-account" aria-label="Account menu">
            <span className="rail-avatar" aria-hidden="true">
              {initials(email)}
            </span>
            <span className="rail-label rail-account-text">
              <b>{email ?? "Signed in"}</b>
              <small>{planName} plan</small>
            </span>
          </summary>
          <div className="account-menu" role="menu">
            <Link role="menuitem" href={hrefFor("settings")} onClick={() => accountMenu.current?.removeAttribute("open")}>
              Settings
            </Link>
            <Link role="menuitem" href={hrefFor("billing")} onClick={() => accountMenu.current?.removeAttribute("open")}>
              {isFree ? "Upgrade plan" : "Credits & plan"}
            </Link>
            <form action="/auth/signout" method="post">
              <button type="submit" role="menuitem">Sign out</button>
            </form>
          </div>
        </details>

        <nav className="rail-nav" aria-label="Workspace">
          <div className="rail-mains">{MAIN.map(mainItem)}</div>

          <p className="rail-group-label rail-label">Video</p>
          <div className="rail-group">{VIDEO.map(item)}</div>

          <div className="rail-foot">{FOOT.map(item)}</div>
        </nav>
      </aside>

      <div className="ws-body">
        <header className="topbar">
          {isFree && !bannerHidden && (
            <p className="plan-banner">
              <b>You are on the Free plan — clips carry a watermark.</b>
              <Link className="secondary-button" href={hrefFor("billing")}>
                Upgrade
              </Link>
              <button
                type="button"
                className="plan-banner-close"
                aria-label="Hide this message"
                onClick={() => {
                  setBannerHidden(true);
                  try {
                    window.sessionStorage.setItem(BANNER_KEY, "1");
                  } catch {
                    // Không nhớ được thì chỉ ẩn trong lần xem này.
                  }
                }}
              >
                ×
              </button>
            </p>
          )}
          <ActiveJobChip jobs={active} onOpen={(id) => onOpenProject?.(id)} />
          <div className="topbar-credits">
            <ThemeSwitch />
            {credits === null || credits === undefined ? null : (
              <Link
                className="credit-chip"
                href={hrefFor("billing")}
                aria-label={`${credits} credits left`}
                title="1 credit = 1 minute of source video"
              >
                <Icon name="zap" size={15} />
                <b>{credits}</b>
              </Link>
            )}
            {/* Chỉ mời nạp khi thật sự sắp hết — còn nhiều thì chip credit (bấm
                được) là đủ, và một nút mua thường trực là tiếng ồn. */}
            {credits !== null && credits !== undefined && credits < JOB_HOLD_CREDITS * 2 && (
              <Link className="secondary-button" href={hrefFor("billing")}>
                Add credits
              </Link>
            )}
          </div>
        </header>
        <RetentionBanner billingHref={hrefFor("billing")} />
        <main className="page">{children}</main>
      </div>
      {/* Toast của khung ngoài: nó sống lâu hơn từng màn, nên "clip xong rồi"
          tới được kể cả khi người dùng đang ở Settings hay Billing. */}
      <Toast message={toast?.text ?? null} onDone={clearToast} action={toastAction} tone={toast?.tone} />
    </div>
  );
}
