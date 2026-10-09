/**
 * Chạy THẬT, không chỉ kiểm lúc typecheck.
 *
 *     cd apps/web && npx tsx lib/api/shapes.check.ts
 *
 * Hợp đồng API là thứ giao diện đã chạy thật vài ngày trên bản local; đổi một
 * tên khoá ở tầng dịch là làm hỏng một màn hình mà typecheck không thấy — vì
 * route trả `unknown` cho fetch phía client.
 *
 * Ở đây hàng database GIẢ được đẩy qua đúng các hàm dịch của route, rồi so bộ
 * khoá với JSON mẫu dùng chung (`tests/contracts/clipping/*.json`). Không cần
 * Supabase, nên nó chạy được ở mọi máy và trong CI.
 *
 * Chiều còn lại — route nối đúng dữ liệu vào các hàm này — kiểm ở
 * `contract.check.ts`, và nó cần một stack Supabase thật.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { clipShape, projectShape, encodeCursor, decodeCursor } from "./shapes";
import { aspectOfSize, latestExportByRevision } from "./projects";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "..", "..", "tests", "contracts", "clipping");

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Record<string, unknown>;

const failures: string[] = [];

function check(name: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Mọi khoá của mẫu phải có mặt, và kiểu của nó phải khớp. */
function sameShape(actual: unknown, expected: unknown, path = ""): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path || "root"}: phải là mảng`);
    if (expected.length && (actual as unknown[]).length) {
      sameShape((actual as unknown[])[0], expected[0], `${path}[0]`);
    }
    return;
  }
  if (expected && typeof expected === "object") {
    assert.ok(
      actual && typeof actual === "object" && !Array.isArray(actual),
      `${path || "root"}: phải là object`,
    );
    for (const [key, value] of Object.entries(expected)) {
      const next = `${path}.${key}`;
      assert.ok(key in (actual as Record<string, unknown>), `thiếu khoá ${next}`);
      sameShape((actual as Record<string, unknown>)[key], value, next);
    }
    return;
  }
  if (expected === null) return; // Mẫu để null: kiểu thật là `T | null`.
  assert.equal(typeof actual, typeof expected, `${path}: sai kiểu`);
}

const JOB = {
  id: "5da1af8e-b287-4f05-b6ff-1646b316abc0",
  source_url: "storage://user-1/founder-interview__abc.mp4",
  name: "Founder interview",
  title: "probe title",
  pinned: false,
  status: "done",
  stage: "done",
  // PostgREST trả `numeric` dưới dạng CHUỖI — mẫu cố ý để chuỗi ở đây.
  duration_seconds: "44.419",
  clips_requested: 1,
  clip_length: "auto",
  mode: "clip",
  aspect: "9:16",
  layout: "auto",
  captions: true,
  segments: null,
  error: null,
  created_at: "2026-09-12T14:02:11.120Z",
  finished_at: "2026-09-12T14:02:27.030Z",
  attempt_started_at: "2026-09-12T14:02:11.410Z",
};

const CLIP = {
  id: "8b0f6a52-3c1d-4e7a-9f5b-2d6c8e1a4b70",
  idx: 0,
  hook: "We built it in a weekend",
  start_seconds: "12.5",
  end_seconds: "30.935",
  score: "8.5",
  reason: "Clear founder story with a concrete result.",
  storage_path: "user-1/job-1/1/00-clip.mp4",
  preview_path: "user-1/job-1/1/00-clip.preview.mp4",
};

check("project khớp project.json", () => {
  const clip = clipShape(CLIP, {
    revision: 1,
    previewAspect: "16:9",
    previewWidth: 1920,
    previewHeight: 1080,
    previewUrl: "https://storage.example/preview",
    downloadUrl: "https://storage.example/download",
    exportUrl: "/api/v1/exports/e41b7c09/file?kind=mp4",
    exportRevision: 3,
  });
  const project = projectShape(JOB, [clip], true);
  sameShape(project, fixture("project"));

  // Số phải là SỐ: `numeric` của PostgREST là chuỗi, và cộng chuỗi trong UI cho
  // ra "1020" thay vì 30.
  assert.equal(project.duration, 44.419);
  assert.equal(project.clips[0].moment.end, 30.935);
  assert.equal(project.clips[0].moment.score, 8.5);
  // Tên người dùng đặt thắng tiêu đề probe ghi mỗi lần chạy lại.
  assert.equal(project.title, "Founder interview");
  assert.equal(project.source_name, "founder-interview.mp4");
});

check("export revision mới nhất thắng task hoàn tất muộn", () => {
  const latest = latestExportByRevision([
    { id: "old-finishes-last", clip_id: CLIP.id, revision: 2 },
    { id: "new-revision", clip_id: CLIP.id, revision: 3 },
    { id: "other-clip", clip_id: "other", revision: 9 },
  ]);
  assert.equal(latest.get(CLIP.id)?.id, "new-revision");
});

check("tỷ lệ preview đọc từ kích thước thật của bản xuất từ editor", () => {
  assert.equal(aspectOfSize(1080, 1920), "9:16");
  assert.equal(aspectOfSize(1080, 1080), "1:1");
  assert.equal(aspectOfSize(1920, 1080), "16:9");
  // 4:5 nằm ngoài ba tỷ lệ của trang: lấy tỷ lệ gần nhất, không về 9:16 mặc định.
  assert.equal(aspectOfSize(1080, 1350), "1:1");
  assert.equal(aspectOfSize(null, 1920), undefined);
});

check("segments của project: null nghĩa là để AI chọn", () => {
  // `numeric` của PostgREST là chuỗi ở đây nữa — mốc thời gian đi thẳng vào
  // phép tính vị trí trên thanh bar, nên cộng chuỗi sẽ vẽ sai khối.
  const picked = projectShape({
    ...JOB,
    segments: [{ start: "12.5", end: "42.25" }],
  });
  assert.deepEqual(picked.segments, [{ start: 12.5, end: 42.25 }]);

  // `[]` và null nói cùng một chuyện: người dùng không chọn đoạn nào.
  assert.equal(projectShape({ ...JOB, segments: [] }).segments, null);
  assert.equal(projectShape(JOB).segments, null);
});

check("project_page khớp project_page.json", () => {
  const page = { items: [projectShape(JOB)], next_cursor: null };
  sameShape(page, fixture("project_page"));
});

check("con trỏ phân trang đi và về nguyên vẹn", () => {
  const cursor = encodeCursor("2026-09-12T14:02:11.120Z", JOB.id);
  assert.deepEqual(decodeCursor(cursor), {
    createdAt: "2026-09-12T14:02:11.120Z",
    id: JOB.id,
  });
  // Con trỏ hỏng không được làm sập route — nó tới từ query string.
  assert.equal(decodeCursor("khong-phai-base64!!"), null);
  assert.equal(decodeCursor(""), null);
});

check("clip chưa có file thì `available` là false", () => {
  const clip = clipShape(
    { ...CLIP, storage_path: null, preview_path: null },
    {
      revision: null,
      previewAspect: "9:16",
      previewWidth: 1080,
      previewHeight: 1920,
      previewUrl: "",
      downloadUrl: "",
      exportUrl: null,
      exportRevision: null,
    },
  );
  assert.equal(clip.available, false);
});

if (failures.length > 0) {
  console.error(`${failures.length} kiểm tra hỏng:`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log("hợp đồng API: mọi kiểm tra xanh");
