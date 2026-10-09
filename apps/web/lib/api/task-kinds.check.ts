/**
 * `packages/contracts/task-kinds.json` là nguồn duy nhất của task kind (R2).
 * SQL và TypeScript không sinh từ nó được (migration bất biến), nên check này
 * báo khi chúng lệch: CHECK `tasks_kind_check` ở migration MỚI NHẤT phải có đúng
 * tập kind của JSON, và mọi kind web đọc phải có trong JSON.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RENDER_TASK_KINDS } from "./tasks";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const contract = JSON.parse(readFileSync(join(ROOT, "packages", "contracts", "task-kinds.json"), "utf8")) as {
  kinds: { kind: string; handler: string }[];
};
const kinds = contract.kinds.map((entry) => entry.kind);
assert.equal(new Set(kinds).size, kinds.length, "task-kinds.json có kind trùng");

/** Tập kind trong `add constraint tasks_kind_check check (kind in (...))` của một migration. */
export function checkKinds(sql: string): string[] | null {
  const matches = [...sql.matchAll(/add constraint tasks_kind_check\s+check\s*\(\s*kind\s+in\s*\(([^)]*)\)/gi)];
  const last = matches.at(-1);
  if (!last) return null;
  return [...last[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

const dir = join(ROOT, "supabase", "migrations");
let latest: string[] | null = null;
let latestFile = "";
for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
  const found = checkKinds(readFileSync(join(dir, file), "utf8"));
  if (found) {
    latest = found;
    latestFile = file;
  }
}
assert.ok(latest, "không tìm thấy tasks_kind_check trong migration nào");
assert.deepEqual(
  [...latest].sort(),
  [...kinds].sort(),
  `tasks_kind_check ở ${latestFile} lệch task-kinds.json — thêm migration đổi CHECK hoặc sửa JSON`,
);
for (const kind of RENDER_TASK_KINDS) {
  assert.ok(kinds.includes(kind), `RenderTaskKind "${kind}" không có trong task-kinds.json`);
}

// Parser tự kiểm: câu nhiều dòng như migration thật.
assert.deepEqual(
  checkKinds("alter table public.tasks\n  add constraint tasks_kind_check\n  check (kind in ('zip',\n 'probe_media'));"),
  ["zip", "probe_media"],
);

console.log(`task kinds: ${kinds.length} kind khớp ${latestFile} và lib/api/tasks.ts.`);
