/**
 * Chạy THẬT, không chỉ kiểm lúc typecheck.
 *
 * Khác `clipping-contract.check.ts` — file đó chỉ bắt lệch KIỂU, và kiểu thì
 * không nói được "hai bản cài đặt ra cùng một hash". Ở đây fixture được nạp lúc
 * chạy, đẩy qua `parseSettings`/`settingsHash` của bản TypeScript, rồi so với
 * kết quả mà bản Python đã ghi sẵn vào chính những file đó.
 *
 *     cd apps/web && npm run check:contracts
 *
 * Thoát mã khác 0 khi lệch, kèm chỗ lệch. Cùng bộ fixture được bản Python chạy
 * ở `packages/engine/tests/test_settings_contract.py`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RENDER_PROFILE_VERSION,
  SettingsError,
  canonicalJson,
  parseSettings,
  settingsHash,
} from "./settings-schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "..", "tests", "contracts", "settings");
const SCHEMA = join(HERE, "..", "..", "..", "packages", "contracts", "revision-settings.schema.json");

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ""): void {
  if (!condition) failures.push(detail ? `${label}\n    ${detail}` : label);
}

function load<T>(folder: string): Array<{ name: string; data: T }> {
  const dir = join(FIXTURES, folder);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      name: file.replace(/\.json$/, ""),
      data: JSON.parse(readFileSync(join(dir, file), "utf8")) as T,
    }));
}

type ValidFixture = { source_duration: number; settings: unknown; canonical?: string };
type InvalidFixture = ValidFixture & { error: string };
type HashFixture = {
  render_profile: number;
  settings: unknown;
  canonical: string;
  expected_hash: string;
};

async function main(): Promise<void> {
  // -------------------------------------------------- phiên bản render profile
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as Record<string, unknown>;
  check(
    "render profile lệch giữa schema và bản TypeScript",
    schema["x-render-profile"] === RENDER_PROFILE_VERSION,
    `schema=${String(schema["x-render-profile"])} ts=${RENDER_PROFILE_VERSION}`,
  );

  // ------------------------------------------------------------------ hợp lệ
  const valid = load<ValidFixture>("valid");
  check("không tìm thấy fixture hợp lệ nào", valid.length >= 6, `có ${valid.length}`);

  for (const { name, data } of valid) {
    try {
      const parsed = parseSettings(data.settings, data.source_duration);
      // Parse lại bản đã chuẩn hoá phải ra đúng nó: mở một clip rồi bấm Save mà
      // không sửa gì thì không được đẻ ra một revision mới.
      const again = parseSettings(parsed, data.source_duration);
      check(
        `valid/${name}: parse lại không ổn định`,
        canonicalJson(parsed) === canonicalJson(again),
        `${canonicalJson(parsed)}\n    ${canonicalJson(again)}`,
      );
      // `canonical` là tuỳ chọn, và chỉ có mặt ở những fixture mà hai bản parse
      // ĐÃ TỪNG lệch nhau (ví dụ: cắt lề của `texts[].text`). "Parse lại ổn
      // định" chỉ đo một bên với chính nó, nên nó không bắt được lệch đó.
      if (data.canonical !== undefined) {
        check(
          `valid/${name}: JSON chuẩn hoá lệch với bản Python`,
          canonicalJson(parsed) === data.canonical,
          `python: ${data.canonical}\n    ts:     ${canonicalJson(parsed)}`,
        );
      }
    } catch (err) {
      check(`valid/${name}: bị từ chối nhầm`, false, String(err));
    }
  }

  // -------------------------------------------------------------- không hợp lệ
  const invalid = load<InvalidFixture>("invalid");
  check("không đủ fixture không hợp lệ", invalid.length >= 15, `có ${invalid.length}`);

  for (const { name, data } of invalid) {
    let thrown: unknown;
    try {
      parseSettings(data.settings, data.source_duration);
    } catch (err) {
      thrown = err;
    }
    if (thrown === undefined) {
      check(`invalid/${name}: được chấp nhận nhầm`, false, `chờ: ${data.error}`);
      continue;
    }
    check(
      `invalid/${name}: sai loại lỗi`,
      thrown instanceof SettingsError,
      String(thrown),
    );
    // Trùng TỪNG CHỮ với Python: chuỗi này hiện thẳng lên màn hình người dùng.
    check(
      `invalid/${name}: message lệch với bản Python`,
      (thrown as Error).message === data.error,
      `python: ${data.error}\n    ts:     ${(thrown as Error).message}`,
    );
  }

  // ----------------------------------------------------------------- hash
  const hashes = load<HashFixture>("hash");
  check("không tìm thấy fixture hash nào", hashes.length > 0);

  for (const { name, data } of hashes) {
    check(
      `hash/${name}: render profile lệch`,
      data.render_profile === RENDER_PROFILE_VERSION,
      `fixture=${data.render_profile} ts=${RENDER_PROFILE_VERSION}`,
    );
    const canonical = canonicalJson({
      render_profile: RENDER_PROFILE_VERSION,
      settings: data.settings,
    });
    check(
      `hash/${name}: JSON chuẩn hoá lệch`,
      canonical === data.canonical,
      `python: ${data.canonical}\n    ts:     ${canonical}`,
    );
    const digest = await settingsHash(data.settings);
    check(
      `hash/${name}: sha256 lệch`,
      digest === data.expected_hash,
      `python: ${data.expected_hash}\n    ts:     ${digest}`,
    );
  }

  const total = valid.length + invalid.length + hashes.length;
  if (failures.length > 0) {
    console.error(`\nHợp đồng settings LỆCH — ${failures.length} chỗ:\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error("");
    process.exit(1);
  }
  console.log(
    `Hợp đồng settings khớp: ${valid.length} hợp lệ, ${invalid.length} không hợp lệ, ` +
      `${hashes.length} hash (${total} fixture), render profile ${RENDER_PROFILE_VERSION}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
