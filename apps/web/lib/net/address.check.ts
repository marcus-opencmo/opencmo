/**
 * Runs for real, not only at typecheck:
 *
 *     cd apps/web && npx tsx lib/net/address.check.ts
 *
 * The cases come from `packages/contracts/private-addresses.json`, the same file
 * `packages/engine/tests/test_addresses.py` reads, so the web guard and the worker guard cannot
 * disagree on any of them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";

import { blockedName, checkUrl, privateAddress, refused } from "./address";

type Case = { input: string; blocked: boolean; why: string };

export const ADDRESS_CASES: Case[] = JSON.parse(
  readFileSync(new URL("../../../../packages/contracts/private-addresses.json", import.meta.url), "utf8"),
);

const failures: string[] = [];

function check(name: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

for (const { input, blocked, why } of ADDRESS_CASES) {
  check(`${input} (${why})`, () => {
    for (const scheme of ["http", "https"]) {
      const result = checkUrl(new URL(`${scheme}://${input}/v.mp4`));
      assert.equal(refused(result), blocked, `checkUrl ${scheme}: ${JSON.stringify(result)}`);
    }
    const literal = input.replace(/^\[|\]$/g, "");
    if (isIP(literal)) assert.equal(privateAddress(literal), blocked, "privateAddress");
  });
}

check("the fixture covers every case the plan names", () => {
  assert.ok(ADDRESS_CASES.length >= 25);
  assert.ok(ADDRESS_CASES.some((c) => !c.blocked) && ADDRESS_CASES.some((c) => c.blocked));
});

check("only ports 80 and 443, whatever the scheme", () => {
  assert.deepEqual(checkUrl(new URL("https://example.com/")), { host: "example.com", port: 443 });
  assert.deepEqual(checkUrl(new URL("http://example.com/")), { host: "example.com", port: 80 });
  assert.deepEqual(checkUrl(new URL("https://example.com:80/")), { host: "example.com", port: 80 });
  for (const url of ["https://example.com:8080/", "http://example.com:22/", "https://example.com:6379/"]) {
    assert.deepEqual(checkUrl(new URL(url)), { refused: "port" }, url);
  }
});

check("userinfo and non-web schemes are refused", () => {
  assert.deepEqual(checkUrl(new URL("https://user:pass@example.com/")), { refused: "userinfo" });
  assert.deepEqual(checkUrl(new URL("https://user@example.com/")), { refused: "userinfo" });
  for (const url of ["file:///etc/passwd", "ftp://example.com/", "gopher://example.com/"]) {
    assert.deepEqual(checkUrl(new URL(url)), { refused: "scheme" }, url);
  }
});

check("blockedName: single labels and private suffixes", () => {
  for (const name of ["intranet", "router.lan", "printer.home.arpa", "x.onion", "db.internal.", "LOCALHOST"]) {
    assert.equal(blockedName(name), true, name);
  }
  for (const name of ["example.com", "internal.example.com", "local.news"]) assert.equal(blockedName(name), false, name);
});

check("privateAddress: unparsable and zone-scoped addresses", () => {
  assert.equal(privateAddress("not-an-ip"), true);
  assert.equal(privateAddress("fe80::1%eth0"), true);
  assert.equal(privateAddress("2001:db8::1"), true);
  assert.equal(privateAddress("2a00:1450:4001::200e"), false);
  assert.equal(privateAddress("::ffff:8.8.8.8"), false);
  assert.equal(privateAddress("203.0.113.9"), true);
});

if (failures.length > 0) {
  console.error(`${failures.length} checks failed:`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`address: ${ADDRESS_CASES.length} shared cases and every check green`);
