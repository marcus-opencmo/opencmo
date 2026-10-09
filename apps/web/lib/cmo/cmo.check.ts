/**
 * Kiểm phần thuần của W0 Onboarding: chặn SSRF, rút chữ HTML, cắt document,
 * bản giả của bước LLM. Không mạng, không database.
 *
 *     cd apps/web && NODE_OPTIONS=--conditions=react-server npx tsx lib/cmo/cmo.check.ts
 */
import assert from "node:assert/strict";

import { clampDocument, DOCUMENT_KINDS, OnboardingSchema } from "./documents";
import { draftDocuments } from "./generate";
import { extractPage, normalizeSite, privateAddress, readSite, SiteError } from "./site";
import { suggestFixes } from "./suggest";

async function main(): Promise<void> {
  // normalizeSite: chuẩn hoá ô nhập, chặn mọi thứ không phải tên miền công khai.
  assert.equal(normalizeSite("acme.com").toString(), "https://acme.com/");
  assert.equal(normalizeSite("  https://Acme.com/pricing?x=1 ").toString(), "https://acme.com/");
  assert.equal(normalizeSite("http://acme.io").toString(), "http://acme.io/");
  for (const bad of ["localhost", "127.0.0.1", "http://10.0.0.1", "http://[::1]/", "ftp://acme.com", "https://a:b@acme.com", "https://acme.com:8080", "intranet", "printer.local", "x", "javascript:alert(1)"]) {
    assert.throws(() => normalizeSite(bad), SiteError, `phải chặn: ${bad}`);
  }

  // privateAddress: dải riêng, loopback, link-local (metadata cloud), CGNAT, IPv6.
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"]) {
    assert.equal(privateAddress(ip), true, `phải coi là riêng: ${ip}`);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111"]) assert.equal(privateAddress(ip), false, `công khai: ${ip}`);

  // readSite không bao giờ đi tới địa chỉ nội bộ.
  await assert.rejects(readSite("http://localhost:3000"), SiteError);
  await assert.rejects(readSite("169.254.169.254"), SiteError);

  // extractPage: bỏ script/style, giải mã entity, lấy heading và mô tả.
  const page = extractPage(
    "https://acme.com/",
    `<html><head><title>Acme &amp; Co | Invoices</title><meta name="description" content="Send invoices in 10 seconds."><script>var secret = 1</script><style>.x{}</style></head>
     <body><nav>Menu</nav><h1>Get paid faster</h1><p>Acme sends&nbsp;invoices.</p><h2>For freelancers</h2></body></html>`,
  );
  assert.equal(page.title, "Acme & Co | Invoices");
  assert.equal(page.description, "Send invoices in 10 seconds.");
  assert.deepEqual(page.headings, ["Get paid faster", "For freelancers"]);
  assert.ok(page.text.includes("Acme sends invoices."));
  assert.ok(!page.text.includes("secret") && !page.text.includes("Menu"), "không lấy script và nav");

  // clampDocument: cắt chuỗi dài, bỏ dòng trống, giới hạn số nhóm, bỏ field lạ.
  const clamped = clampDocument("competitors", {
    competitors: Array.from({ length: 12 }, (_, i) => ({ name: ` C${i} `, website: "", difference: "x".repeat(5000), extra: 1 })),
    injected: "nope",
  }) as { competitors: { name: string; difference: string }[] };
  assert.equal(clamped.competitors.length, 8);
  assert.equal(clamped.competitors[0].name, "C0");
  assert.equal(clamped.competitors[0].difference.length, 1500);
  assert.ok(!("injected" in clamped) && !("extra" in clamped.competitors[0]));
  const product = clampDocument("product", { name: "A", problems: ["one", "  ", "", "two"] }) as { problems: string[]; pricing: string };
  assert.deepEqual(product.problems, ["one", "two"]);
  assert.equal(product.pricing, "");

  // Bản giả (CI/E2E) ra đúng schema và đủ bốn document.
  process.env.OPENCMO_AGENT_FAKE = "1";
  const drafts = await draftDocuments({ url: "https://acme.com/", pages: [page] });
  OnboardingSchema.parse(drafts);
  for (const kind of DOCUMENT_KINDS) assert.ok(drafts[kind], `thiếu ${kind}`);
  assert.equal(drafts.product.name, "Acme & Co");

  // suggestFixes: chỉ gợi ý chỗ thật sự thiếu, đúng thứ tự ảnh hưởng, trỏ đúng thẻ.
  const thin = suggestFixes({
    product: { createdBy: "agent", version: 1, body: { name: "A", category: "", one_liner: "Short", audience: "Not stated on the website", pricing: "$9" } },
    strategy: { createdBy: "agent", version: 1, body: { icp: "", pains: ["late payments", "awkward emails"], voice: "Plain and friendly, a bit dry." } },
  });
  assert.deepEqual(thin.map((s) => s.label), ["Describe your ideal customer", "Add who buys it", "Sharpen your one-liner"]);
  assert.equal(thin[0].href, "/app?doc=strategy");
  assert.deepEqual(suggestFixes({}), [], "chưa có document thì không gợi ý gì");
  assert.equal(suggestFixes({ product: drafts.product ? { createdBy: "agent", version: 1, body: drafts.product as Record<string, unknown> } : undefined }, 10).some((s) => s.label === "Add a category"), true);

  console.log("cmo.check — onboarding: SSRF, rút chữ, cắt document, bản giả, gợi ý sửa đều đúng.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
