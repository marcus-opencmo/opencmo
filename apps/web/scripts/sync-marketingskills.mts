/**
 * Chép skill marketing/sales/SEO từ repo marketingskills (MIT, Corey Haines — fork
 * trungthanh01/marketingskills) vào `lib/cmo/skills/library/` làm "thư viện" của CMO chat.
 *
 * Chỉ chép SKILL.md: `references/`, `scripts/` là phần nặng nhất và CMO không chạy được script.
 * Không chạy trong CI — chạy tay khi muốn cập nhật từ fork, rồi `build-cmo-skills.mts`.
 *
 *   tsx scripts/sync-marketingskills.mts /đường/dẫn/marketingskills
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Skill CMO được dùng: chiến lược, kênh, sales, SEO (nhận xét website). Bỏ các skill kiểu coding
 * agent (cài tracking, sửa UI trang/sản phẩm) và skill không hợp khách: analytics, ab-testing,
 * free-tools, marketing-loops, popups, paywalls, signup, onboarding, aso, sms, image, video.
 */
export const INCLUDE = [
  // Chiến lược & kế hoạch
  "marketing-plan",
  "marketing-ideas",
  "marketing-council",
  "marketing-psychology",
  "product-marketing",
  "customer-research",
  "competitor-profiling",
  "competitors",
  "content-strategy",
  "launch",
  "offers",
  "pricing",
  "attribution",
  "churn-prevention",
  // Nội dung & kênh
  "social",
  "copywriting",
  "copy-editing",
  "cro",
  "emails",
  "lead-magnets",
  "ai-seo",
  "ads",
  "ad-creative",
  "community-marketing",
  "co-marketing",
  "influencer-marketing",
  "public-relations",
  "events",
  "directory-submissions",
  "referrals",
  // Sales
  "cold-email",
  "prospecting",
  "sales-enablement",
  "revops",
  // SEO: nhận xét và đề xuất, không sửa code
  "seo-audit",
  "site-architecture",
  "programmatic-seo",
  "schema",
] as const;

const repo = process.argv[2];
if (!repo || !existsSync(join(repo, "skills"))) {
  console.error("Cách dùng: tsx scripts/sync-marketingskills.mts <đường-dẫn-repo-marketingskills>");
  process.exit(1);
}

const OUT = join(import.meta.dirname, "..", "lib", "cmo", "skills", "library");
for (const file of readdirSync(OUT)) if (file.endsWith(".md")) rmSync(join(OUT, file));

for (const name of INCLUDE) {
  const src = join(repo, "skills", name, "SKILL.md");
  if (!existsSync(src)) throw new Error(`thiếu ${src}`);
  writeFileSync(join(OUT, `${name}.md`), readFileSync(src, "utf8"));
}

const git = (...args: string[]) => {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  } catch {
    return "?";
  }
};
writeFileSync(
  join(OUT, "SOURCE.md"),
  `# Nguồn thư viện skill của CMO

- Repo: ${git("config", "--get", "remote.origin.url").replace(/^.*github\.com[/:]/, "github.com/").replace(/\.git$/, "")}
- Commit: ${git("rev-parse", "HEAD")}
- Ngày chép: ${new Date().toISOString().slice(0, 10)}
- Giấy phép: MIT — Copyright (c) 2025 Corey Haines (bản đầy đủ ở ../LICENSE.md)

Chỉ chép SKILL.md của ${INCLUDE.length} skill trong \`INCLUDE\` (scripts/sync-marketingskills.mts).
Đừng sửa tay các file ở đây: chép lại bằng script rồi chạy \`npx tsx scripts/build-cmo-skills.mts\`.
`,
);
console.log(`marketingskills: chép ${INCLUDE.length} skill → lib/cmo/skills/library/`);
