"use client";

/**
 * Theme của workspace: System / Light / Dark.
 *
 * Lựa chọn nằm ở `localStorage['opencmo.theme']`; thứ CSS đọc là
 * `html[data-theme]` (`styles/design-system.css`). Có hai đường đặt thuộc tính:
 *
 *   1. `THEME_BOOT` (`lib/theme-boot.ts`) chạy inline trước khung hình đầu khi
 *      tải thẳng `/app/...` — đợi React hydrate thì người dùng chọn Dark đã kịp
 *      thấy trang sáng nháy.
 *   2. `useApplyTheme()` trong `WebShell`: script inline KHÔNG chạy lại khi điều
 *      hướng phía client (landing → /app), và khi rời `/app` phải gỡ thuộc tính
 *      để landing quay về bảng màu của nó.
 *
 * Nhiều công tắc cùng lúc (top bar chung, top bar CMO, top bar editor) đọc một
 * store duy nhất qua `useSyncExternalStore`, nên bấm ở chỗ này thì chỗ kia đổi
 * theo.
 */

import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";

import { DARK_QUERY, THEME_KEY as KEY } from "@/lib/theme-boot";

export type ThemePref = "system" | "light" | "dark";

const EVENT = "opencmo-theme";

function readPref(): ThemePref {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function resolve(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useThemePref(): ThemePref {
  // Server luôn trả "system": HTML đầu không biết localStorage, và thuộc tính
  // màu thật đã do THEME_BOOT đặt nên không có nháy.
  return useSyncExternalStore(subscribe, readPref, () => "system");
}

export function setThemePref(pref: ThemePref) {
  try {
    window.localStorage.setItem(KEY, pref);
  } catch {
    // Không lưu được thì vẫn đổi trong phiên này.
  }
  document.documentElement.dataset.theme = resolve(pref);
  window.dispatchEvent(new Event(EVENT));
}

/** Đặt `html[data-theme]` khi vào phần đăng nhập, gỡ khi rời đi. */
export function useApplyTheme() {
  const pref = useThemePref();
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolve(readPref());
  }, [pref]);
  useLayoutEffect(() => () => {
    delete document.documentElement.dataset.theme;
  }, []);
  // "System" phải đi theo máy khi người dùng đổi giao diện hệ điều hành.
  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      if (readPref() === "system") document.documentElement.dataset.theme = resolve("system");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
}

const OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemeSwitch({ className = "" }: { className?: string }) {
  const pref = useThemePref();
  return (
    <div className={`theme-switch ${className}`} role="radiogroup" aria-label="Theme">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={pref === option.value}
          onClick={() => setThemePref(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
