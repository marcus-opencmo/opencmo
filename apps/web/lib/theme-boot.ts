/**
 * Script khởi động theme, tách khỏi `components/theme.tsx`: hằng số export từ
 * một file "use client" tới server component dưới dạng client reference chứ
 * không phải chuỗi, nên `app/app/layout.tsx` không nhúng nó được.
 */

export const THEME_KEY = "opencmo.theme";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

export const THEME_BOOT =
  "try{var p=localStorage.getItem('" + THEME_KEY + "');" +
  "var d=p==='dark'||(p!=='light'&&matchMedia('" + DARK_QUERY + "').matches);" +
  "document.documentElement.dataset.theme=d?'dark':'light'}" +
  "catch(e){document.documentElement.dataset.theme='light'}";
