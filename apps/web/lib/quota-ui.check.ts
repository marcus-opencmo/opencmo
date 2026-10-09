/**
 * Quota hiện ra đúng: định dạng mốc reset và khối Usage.
 *
 * Phần kiểm `ExportQuotaAction` / `requestExportAndRefresh` đã bị gỡ cùng
 * `ExportPanel` ở GĐ 5: nút Export của editor cũ không còn tồn tại. Editor mới
 * trần theo gói bằng `task.resolution` (SQL quyết) và watermark do worker đóng
 * lúc vẽ document, nên cùng luật giờ được `100_render_document.test.sql` và
 * `test_worker_render_document_task.py` giữ — gần chỗ quyết định hơn một lần
 * render React.
 */
import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AccountUsage,
  type AccountSummary,
} from "../components/clipping/web/AccountUsage";
import * as FormatModule from "./format";

const formatQuotaReset = (FormatModule as unknown as {
  formatQuotaReset?: (
    value: string,
    options?: { locale?: string; timeZone?: string },
  ) => string;
}).formatQuotaReset;

async function main() {
  assert.equal(
    typeof formatQuotaReset,
    "function",
    "quota reset must be formatted by a reusable client-time helper",
  );
  assert.equal(
    formatQuotaReset!("2026-09-20T00:00:00Z", {
      locale: "en-US",
      timeZone: "Asia/Ho_Chi_Minh",
    }),
    "Sep 20, 7:00 AM",
  );
  assert.equal(
    formatQuotaReset!("2026-09-20T00:00:00Z", {
      locale: "en-US",
      timeZone: "America/New_York",
    }),
    "Sep 19, 8:00 PM",
  );

  const account: AccountSummary = {
    plan: "free",
    email: "marcus@example.com",
    credits: 17,
    job_hold_credits: 3,
    resets_at: "2026-09-20T00:00:00Z",
    quota: {
      previews: { used: 2, limit: 9 },
      exports: { used: 3, limit: 4 },
      storage: { bytes: 1024, limit: 4096, objects: 1, objectLimit: 20 },
    },
  };
  const usage = renderToStaticMarkup(
    createElement(AccountUsage, { account, showIdentity: true, showStorage: true }),
  );
  for (const text of [
    "Signed in as",
    "marcus@example.com",
    "Plan",
    "Credits left",
    "Exports left today",
    "1 of 4",
    "Daily quotas reset",
    "Storage",
  ]) {
    assert.match(usage, new RegExp(text));
  }
  // Preview phía server đã gỡ (R1): không hiện hạn mức cho thứ không còn bán.
  assert.doesNotMatch(usage, /Previews left/);

  console.log(
    "Quota UI: mốc reset và khối Usage đều đúng.",
  );
}

void main();
