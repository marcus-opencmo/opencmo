"use client";

/**
 * Chọn kiểu phụ đề bằng ô xem trước thay vì dropdown tên.
 *
 * Người không chuyên không biết "Cascade" hay "Stark" trông ra sao; nhìn một ô
 * chữ mẫu thì biết ngay. Dùng ở Brand kit và ở inspector của editor. Ô chỉ là
 * gợi ý hình dáng (font, hoa/thường, hộp nền, màu nhấn) — bản xem trước thật
 * vẫn là canvas `clip-render` cạnh đó.
 *
 * Font trong ô là font clip tự host (`packages/clip-media/fonts`, phục vụ ở `/fonts/`), nạp bằng `loadFonts()`
 * của editor; chưa nạp xong thì trình duyệt tạm dùng font hệ thống.
 */

import { CAPTION_STYLES } from "@opencmo/editor-core";

export type CaptionStyle = (typeof CAPTION_STYLES)[number];

type Look = {
  label: string;
  family: string;
  weight: number;
  transform?: "uppercase" | "lowercase";
  spacing?: string;
  /** Hộp màu nhấn sau TỪ ĐANG ĐỌC. */
  box?: boolean;
  /** Cả câu nằm trên dải trắng, chữ đen. */
  paper?: boolean;
  /** Cả câu nằm trên dải đen. */
  stark?: boolean;
};

const LOOKS: Record<CaptionStyle, Look> = {
  classic: { label: "Classic", family: "Urbanist", weight: 600 },
  cascade: { label: "Cascade", family: "Montserrat", weight: 800, transform: "uppercase" },
  spotlight: { label: "Spotlight", family: "Inter", weight: 800, transform: "uppercase", box: true },
  whisper: { label: "Whisper", family: "Figtree", weight: 500, transform: "lowercase" },
  paper: { label: "Paper", family: "Inter", weight: 800, paper: true },
  guinea: { label: "Guinea", family: "Bangers", weight: 400, transform: "uppercase", spacing: ".04em" },
  stark: { label: "Stark", family: "Figtree", weight: 800, transform: "uppercase", stark: true },
};

export function captionStyleLabel(style: string): string {
  return LOOKS[style as CaptionStyle]?.label ?? style;
}

export function CaptionStylePicker({
  value,
  accent,
  onChange,
  styles = CAPTION_STYLES,
  testId,
}: {
  value: string;
  /** Màu nhấn của kit: tô từ đang đọc, như phụ đề thật. */
  accent: string;
  onChange: (style: CaptionStyle) => void;
  styles?: readonly CaptionStyle[];
  testId?: string;
}) {
  return (
    <div className="caption-styles" role="radiogroup" aria-label="Caption style" data-testid={testId}>
      {styles.map((style) => {
        const look = LOOKS[style];
        const dark = look.paper ? "#111111" : "#ffffff";
        return (
          <button
            key={style}
            type="button"
            role="radio"
            aria-checked={value === style}
            className="caption-style"
            data-style={style}
            onClick={() => onChange(style)}
          >
            <span className="caption-style-stage">
              <span
                className="caption-style-sample"
                style={{
                  fontFamily: `"${look.family}", sans-serif`,
                  fontWeight: look.weight,
                  textTransform: look.transform ?? "none",
                  letterSpacing: look.spacing ?? "0",
                  color: dark,
                  background: look.paper ? "#ffffff" : look.stark ? "#000000" : "transparent",
                  padding: look.paper || look.stark ? "2px 6px" : 0,
                }}
              >
                Grow{" "}
                <span
                  style={{
                    color: look.box || look.paper ? "#111111" : accent,
                    background: look.box ? accent : "transparent",
                    padding: "0 3px",
                    borderRadius: 3,
                  }}
                >
                  fast
                </span>
              </span>
            </span>
            <span className="caption-style-name">{look.label}</span>
          </button>
        );
      })}
    </div>
  );
}
