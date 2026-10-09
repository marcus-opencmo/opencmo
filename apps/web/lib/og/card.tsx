import fs from "node:fs/promises";
import path from "node:path";

import { ImageResponse } from "next/og";

/**
 * Ảnh chia sẻ 1200×630 cho landing và từng bài (Lapis & Marble).
 *
 * Satori không đọc woff2, và đọc font BIẾN THIÊN (variable) thì vỡ
 * (`Cannot read properties of undefined (reading '257')`). Nên `assets/fonts/`
 * giữ bản TTF TĨNH của chính hai font trang đang dùng (Fraunces 420, Inter
 * 600 — OFL): giải nén `packages/clip-media/fonts/*.woff2` rồi cắt một instance bằng
 * fontTools `varLib.instancer`.
 * Ảnh dựng lúc build (route tĩnh), không tốn compute khi bot lấy ảnh.
 */
export const OG_SIZE = { width: 1200, height: 630 };

async function fonts() {
  const dir = path.join(process.cwd(), "assets/fonts");
  const [fraunces, inter] = await Promise.all([
    fs.readFile(path.join(dir, "fraunces.ttf")),
    fs.readFile(path.join(dir, "inter.ttf")),
  ]);
  return [
    { name: "Fraunces", data: fraunces, weight: 400 as const, style: "normal" as const },
    { name: "Inter", data: inter, weight: 600 as const, style: "normal" as const },
  ];
}

const LAPIS = "#1b2a8c";
const GOLD = "#c6a15b";
const MARBLE = "#fbf8f2";
const INK = "#111116";

export async function ogCard({ kicker, title, footer }: { kicker: string; title: string; footer: string }) {
  const size = title.length > 60 ? 64 : title.length > 40 ? 74 : 86;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: MARBLE, fontFamily: "Inter" }}>
        <div style={{ width: 28, height: "100%", background: LAPIS, display: "flex" }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "72px 84px 64px 76px", borderTop: `6px solid ${GOLD}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18, color: GOLD, fontSize: 24, letterSpacing: 5, textTransform: "uppercase" }}>
            <div style={{ width: 48, height: 2, background: GOLD }} />
            {kicker}
          </div>
          <div style={{ display: "flex", fontFamily: "Fraunces", fontSize: size, lineHeight: 1.06, color: INK, letterSpacing: -1.5 }}>{title}</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 26, color: "#55586b" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ width: 44, height: 44, borderRadius: 8, background: LAPIS, display: "flex", alignItems: "center", justifyContent: "center", color: GOLD, fontFamily: "Fraunces", fontSize: 30 }}>O</div>
              <span style={{ fontFamily: "Fraunces", fontSize: 32, color: INK }}>OpenCMO</span>
            </div>
            <span>{footer}</span>
          </div>
        </div>
      </div>
    ),
    { ...OG_SIZE, fonts: await fonts() },
  );
}
