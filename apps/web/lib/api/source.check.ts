/**
 * Chạy THẬT, không chỉ kiểm lúc typecheck.
 *
 *     cd apps/web && npx tsx lib/api/source.check.ts
 *
 * `sourceProblem` là hai chốt chặn cùng lúc: SSRF qua yt-dlp, và "job trỏ vào
 * file của người khác". Cả hai đều hỏng LẶNG LẼ nếu sai — job vẫn chạy, clip
 * vẫn ra, chỉ là từ nguồn đáng lẽ không được chạm tới.
 */
import assert from "node:assert/strict";

import { sourceProblem } from "./source";
import { rejectReason, storageExtension } from "../upload";

const ME = "11111111-1111-4111-8111-111111111111";
const THEM = "22222222-2222-4222-8222-222222222222";

const failures: string[] = [];

function check(name: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

check("nguồn upload của chính mình được chấp nhận", () => {
  assert.equal(sourceProblem(`storage://${ME}/talk__abc.mp4`, ME), null);
});

check("nguồn upload của người khác bị chặn", () => {
  assert.equal(
    sourceProblem(`storage://${THEM}/talk__abc.mp4`, ME),
    "That upload is no longer available. Please try again.",
  );
});

check("đường dẫn vượt thư mục bị chặn dù segment đầu đúng", () => {
  // Ba segment, bắt đầu bằng uid hợp lệ — chỉ so segment đầu là không đủ.
  assert.notEqual(sourceProblem(`storage://${ME}/../${THEM}/x.mp4`, ME), null);
  assert.notEqual(sourceProblem(`storage://${ME}/sub/x.mp4`, ME), null);
});

check("link HTTPS công khai được chấp nhận (trừ Vimeo, xem dưới)", () => {
  assert.equal(sourceProblem("https://www.youtube.com/watch?v=abc", ME), null);
  assert.equal(sourceProblem("https://youtu.be/abc", ME), null);
  assert.equal(sourceProblem("https://www.tiktok.com/@creator/video/123", ME), null);
  assert.equal(sourceProblem("https://cdn.example.com/video.mp4", ME), null);
  assert.equal(sourceProblem("http://cdn.example.com/video.mp4", ME), null);
});

check("scheme không phải web và URL có credential bị chặn", () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com/video.mp4",
    "https://user:pass@example.com/video.mp4",
  ]) {
    assert.notEqual(sourceProblem(url, ME), null, `phải chặn: ${url}`);
  }
});

check("IP và host nội bộ bị chặn trước khi tạo job", () => {
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "https://127.0.0.1/video.mp4",
    "https://localhost/video.mp4",
    "https://192.168.1.20/video.mp4",
  ]) {
    assert.match(sourceProblem(url, ME) ?? "", /private|local/);
  }
});

check("upload không bị giới hạn theo container hay phần mở rộng", () => {
  assert.equal(rejectReason("concert.mts", 1024), null);
  assert.equal(rejectReason("camera-file.weird-container", 1024), null);
  assert.equal(rejectReason("video-without-extension", 1024), null);
  assert.equal(storageExtension("../../video.bad/ext"), "video");
  assert.equal(storageExtension("concert.MTS"), "mts");
});

check("link Vimeo bị chặn trước khi giữ credit (DRM, UAT production 29/09)", () => {
  for (const link of ["https://vimeo.com/76979871", "https://player.vimeo.com/video/1", "https://www.vimeo.com/2"]) {
    assert.match(sourceProblem(link, ME) ?? "", /Vimeo links can't be imported/);
  }
  assert.equal(sourceProblem("https://notvimeo.com/1", ME), null);
});

if (failures.length > 0) {
  console.error(`${failures.length} kiểm tra hỏng:`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log("sourceProblem: mọi kiểm tra xanh");
