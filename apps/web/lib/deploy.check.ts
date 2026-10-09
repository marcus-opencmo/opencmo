/**
 * `.vercelignore` không được cắt mất mã nguồn.
 *
 *     cd apps/web && npx tsx lib/deploy.check.ts
 *
 * Vì sao cần script này: Vercel CLI tải lên từ GỐC repo (xem ghi chú đầu
 * `.vercelignore`), và các luật ở đó theo cú pháp gitignore — một dòng trần như
 * `clips` khớp MỌI thư mục tên `clips` ở mọi độ sâu, không chỉ thư mục render ở
 * gốc. Ngày 21/09 đúng chuyện đó đã xảy ra: sáu thư mục route biến mất khỏi bản
 * tải lên, `next build` trên Vercel vẫn xanh vì nó không hề thấy chúng, và
 * production trả 404 cho preview, tải clip, editor và export.
 *
 * Build local KHÔNG bao giờ bắt được lỗi này — nó không đọc `.vercelignore`.
 * Đây là chỗ duy nhất kiểm được nó trước khi deploy.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");

/** Thư mục mã nguồn phải có mặt nguyên vẹn trong bản tải lên. */
const SOURCE_ROOTS = [
  "apps/web/app/",
  "apps/web/components/",
  "apps/web/lib/",
  "packages/contracts/",
  // Route `/api/v1/editor/ops` import nguồn TypeScript của package này.
  "packages/editor-core/",
  // Document của clip (spec editor-rewrite A1); export trên server và editor đọc nó.
  "packages/clip-doc/",
  // Editor vẽ preview và quản thư viện bằng hai package này ngay trong trình duyệt.
  "packages/clip-render/",
  "packages/clip-assets/",
];

/**
 * Luật nguy hiểm là luật KHÔNG neo: một tên trần (`clips`) hoặc `**​/tên`.
 * Luật có `/` ở đầu chỉ khớp gốc repo; luật có `/` ở giữa là đường dẫn cụ thể.
 * Cả hai loại sau đều không thể vô tình khớp một thư mục route trùng tên.
 */
function unanchoredNames(rules: string[]): string[] {
  const names = new Set<string>();
  for (const rule of rules) {
    if (rule.startsWith("/")) continue;
    const bare = rule.startsWith("**/") ? rule.slice(3) : rule;
    if (bare.includes("/")) continue;
    names.add(bare);
  }
  return [...names];
}

/** `*` và `?` theo nghĩa glob, phần còn lại khớp nguyên văn. */
function matches(name: string, pattern: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return name === pattern;
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(name);
}

/**
 * Vercel chạy lệnh cài trong Root Directory (`apps/web`). Ở đó `npm install`
 * chỉ cài dependency của MỘT workspace, nên các package nguồn trong
 * `packages/*` không được liên kết. Preview PR #17 đỏ đúng vì chuyện này trong
 * khi CI xanh: CI chạy `npm ci` ở gốc repo. Lệnh cài phải đi từ gốc monorepo.
 */
function checkInstallCommand(): void {
  const config = JSON.parse(readFileSync(join(ROOT, "apps/web/vercel.json"), "utf8"));
  assert.equal(
    config.installCommand,
    "cd ../.. && npm ci",
    "apps/web/vercel.json phải cài từ gốc monorepo (`cd ../.. && npm ci`).",
  );
}

function main(): void {
  checkInstallCommand();

  const rules = readFileSync(join(ROOT, ".vercelignore"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));

  const patterns = unanchoredNames(rules);
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((path) => SOURCE_ROOTS.some((root) => path.startsWith(root)));

  assert.ok(tracked.length > 0, "Không liệt kê được file nguồn — chạy script từ trong repo git.");

  const casualties: string[] = [];
  for (const path of tracked) {
    // Bỏ tên file, chỉ xét các segment THƯ MỤC: một luật gitignore trần khớp cả
    // file lẫn thư mục, nhưng thư mục là thứ kéo theo cả cây con.
    for (const segment of path.split("/").slice(0, -1)) {
      const hit = patterns.find((pattern) => matches(segment, pattern));
      if (hit) casualties.push(`${path}  ← luật "${hit}"`);
    }
  }

  assert.deepEqual(
    casualties,
    [],
    `.vercelignore cắt mất mã nguồn khỏi bản tải lên Vercel.\n` +
      `Neo luật bằng dấu "/" ở đầu (ví dụ "/clips" thay cho "clips").\n\n` +
      casualties.slice(0, 20).join("\n"),
  );

  console.log(
    `.vercelignore: ${patterns.length} luật không neo, không luật nào chạm ` +
      `${tracked.length} file nguồn.`,
  );
}

main();
