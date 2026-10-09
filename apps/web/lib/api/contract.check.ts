/**
 * Kiểm hợp đồng API trên một stack THẬT.
 *
 *     cd apps/web
 *     supabase start && supabase db reset
 *     npm run dev &            # hoặc npm run build && npm run start
 *     npm run check:api
 *
 * Khác `shapes.check.ts` — file đó kiểm tầng dịch bằng hàng giả và chạy ở mọi
 * máy. Ở đây mọi thứ đi qua đúng đường mà trình duyệt đi: cookie phiên, route
 * handler, RLS, RPC. Đó là cách duy nhất bắt được các lỗi kiểu "route quên gắn
 * clip vào project" hay "RLS chặn mất một cột".
 *
 * Ba biến môi trường cần có (đọc từ `.env.local` hoặc từ shell):
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 * và `CHECK_API_BASE` nếu server không chạy ở http://127.0.0.1:3000.
 *
 * Script này KHÔNG tự chạy `supabase db reset`: nó tạo user mới mỗi lượt chạy
 * và dọn sạch phần của mình ở cuối. Reset một database đang được dùng cho việc
 * khác là mất dữ liệu của người khác.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createClient } from "@supabase/supabase-js";

import { isLoopbackUrl } from "../local-supabase";

const BASE = process.env.CHECK_API_BASE ?? "http://127.0.0.1:3000";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_ || !ANON || !SERVICE) {
  console.error(
    "Thiếu NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / " +
      "SUPABASE_SERVICE_ROLE_KEY — chạy `supabase start` rồi nạp .env.local.",
  );
  process.exit(2);
}

if (!isLoopbackUrl(URL_)) {
  console.error("API contract chỉ chạy với Supabase local (127.0.0.1, localhost hoặc ::1).");
  process.exit(2);
}

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });

const failures: string[] = [];
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type Session = { cookie: string; userId: string; email: string; accessToken: string };

/**
 * Tạo user rồi đổi lấy cookie phiên mà route handler đọc được.
 *
 * Đăng nhập bằng mật khẩu (không phải magic link): script không có hộp thư, và
 * `withApi` chỉ quan tâm cookie hợp lệ chứ không quan tâm nó tới từ đâu.
 */
async function signIn(label: string): Promise<Session> {
  const email = `check-${label}-${crypto.randomUUID()}@test.local`;
  const password = crypto.randomUUID();
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !created.user) throw new Error(`Không tạo được user: ${error?.message}`);

  const anon = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { data, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  if (signInError || !data.session) {
    throw new Error(`Không đăng nhập được: ${signInError?.message}`);
  }

  // `@supabase/ssr` đọc cookie tên `sb-<ref>-auth-token`; giá trị là JSON của
  // phiên, mã base64 với tiền tố `base64-` như thư viện ghi ra.
  const ref = new URL(URL_!).hostname.split(".")[0];
  const value = Buffer.from(
    JSON.stringify({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      token_type: "bearer",
      user: data.user,
    }),
    "utf8",
  ).toString("base64");
  return {
    cookie: `sb-${ref}-auth-token=base64-${value}`,
    userId: created.user.id,
    email,
    accessToken: data.session.access_token,
  };
}

async function callApi(
  session: Session | null,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${BASE}/api/v1${path}`, {
    ...init,
    redirect: "manual",
    headers: {
      ...(init.headers ?? {}),
      ...(session ? { cookie: session.cookie } : {}),
      ...(init.body ? { "content-type": "application/json", origin: BASE } : {}),
      host: new URL(BASE).host,
    },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // 303 tới signed URL không có body.
  }
  return { status: response.status, body };
}

// -------------------------------------------------------------- document
// Từ C3 server chỉ lưu document JSON: kiểm trên cây, không soi chuỗi TSX.
type DocNode = { kind?: string; [key: string]: unknown };
type Doc = { version: number; stage: { children: DocNode[] } };
/** Mọi object trong document (node, track, keyframe, paint…), theo chiều sâu. */
function everything(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) value.forEach((item) => everything(item, out));
  else if (value && typeof value === "object") {
    out.push(value as Record<string, unknown>);
    Object.values(value).forEach((item) => everything(item, out));
  }
  return out;
}
type SceneNode = DocNode & { width: number; height: number; children?: DocNode[]; workarea?: [number, number] | null };
const sceneOf = (doc: Doc) => (doc.stage.children.find((node) => node.active) ?? doc.stage.children[0]) as SceneNode;
const frameOf = (doc: Doc) => `${sceneOf(doc).width}x${sceneOf(doc).height}`;
async function documentOf(session: Session | null, clip: string): Promise<Doc> {
  const res = await callApi(session, `/editor/document?clip_id=${clip}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body as { document: Doc }).document;
}

/** Gọi một route SSE, đọc hết stream, trả danh sách event. */
async function callSse(
  session: Session,
  path: string,
  payload: unknown,
): Promise<{ status: number; events: { event: string; data: Record<string, unknown> }[]; body: unknown }> {
  const response = await fetch(`${BASE}/api/v1${path}`, {
    method: "POST",
    headers: {
      cookie: session.cookie,
      "content-type": "application/json",
      origin: BASE,
      host: new URL(BASE).host,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // giữ chữ thô
    }
    return { status: response.status, events: [], body };
  }
  const events = text
    .split("\n\n")
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? "";
      const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? "null") as Record<string, unknown>;
      return { event, data };
    });
  return { status: response.status, events, body: null };
}

/** Một project `done` với một clip, dựng bằng service role như worker vẫn làm. */
async function seedProject(
  userId: string,
): Promise<{
  jobId: string;
  clipId: string;
  clipPath: string;
  proxyPath: string;
}> {
  const { data: job, error } = await admin
    .from("jobs")
    .insert({
      user_id: userId,
      source_url: "https://youtu.be/seed",
      status: "done",
      stage: "done",
      duration_seconds: 120,
      clips_requested: 1,
      title: "Seeded project",
      finished_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error || !job) throw new Error(`seed job: ${error?.message}`);

  const clipPath = `${userId}/${job.id}/1/00-seeded.mp4`;
  const { error: uploadError } = await admin.storage
    .from("clips")
    .upload(clipPath, Buffer.from("OpenCMO API contract fixture"), {
      contentType: "video/mp4",
      upsert: false,
    });
  if (uploadError) throw new Error(`seed clip object: ${uploadError.message}`);

  // Proxy cho editor. Nó phải nằm dưới `/proxy/` — `signedObjectUrl` từ chối
  // ký mọi đường dẫn `sources` khác, và thiếu nó thì `GET /editor/project`
  // không dựng được project nào.
  const proxyPath = `${userId}/${job.id}/proxy/${crypto.randomUUID()}/seeded.mp4`;
  const { error: proxyError } = await admin.storage
    .from("sources")
    .upload(proxyPath, Buffer.from("OpenCMO editor proxy fixture"), {
      contentType: "video/mp4",
      upsert: false,
    });
  if (proxyError) throw new Error(`seed proxy object: ${proxyError.message}`);

  const { data: clip, error: clipError } = await admin
    .from("clips")
    .insert({
      job_id: job.id,
      idx: 0,
      hook: "Seeded clip",
      start_seconds: 10,
      end_seconds: 30,
      source_start: 10,
      source_end: 30,
      storage_path: clipPath,
    })
    .select()
    .single();
  if (clipError || !clip) throw new Error(`seed clip: ${clipError?.message}`);

  const { error: settingsError } = await admin
    .from("clips")
    .update({ settings: { source_start: 10, source_end: 30 }, settings_hash: "a".repeat(64) })
    .eq("id", clip.id);
  if (settingsError) throw new Error(`seed settings: ${settingsError.message}`);

  await admin.from("artifacts").insert({
    job_id: job.id,
    kind: "transcript",
    version: 1,
    data: {
      version: 1,
      language: "en",
      source: "subs",
      segments: [
        {
          start: 10,
          end: 12,
          text: "seeded words",
          words: [
            { start: 10, end: 11, text: "seeded" },
            { start: 11, end: 12, text: "words" },
          ],
        },
      ],
    },
  });

  // `media_manifest.proxies[clipId]` là thứ `editorSource()` đọc. Chiều thật
  // của nguồn nằm ở đây, và bộ sinh TSX đặt khung crop theo nó.
  const { error: manifestError } = await admin
    .from("jobs")
    .update({
      media_manifest: {
        proxies: {
          [clip.id]: {
            bucket: "sources",
            object: proxyPath,
            width: 960,
            height: 540,
            duration: 22,
            offset: 9,
          },
        },
      },
    })
    .eq("id", job.id);
  if (manifestError) throw new Error(`seed manifest: ${manifestError.message}`);

  return { jobId: job.id, clipId: clip.id, clipPath, proxyPath };
}

async function main(): Promise<void> {
  const a = await signIn("a");
  const b = await signIn("b");
  const { jobId, clipId, clipPath, proxyPath } = await seedProject(a.userId);

  await check("chưa đăng nhập: 401 với câu tiếng Anh", async () => {
    const res = await callApi(null, "/projects");
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { detail: "Please sign in again." });
  });

  await check("GET /projects trả trang keyset", async () => {
    const res = await callApi(a, "/projects");
    assert.equal(res.status, 200);
    const page = res.body as {
      items: { id: string; thumbnail_url?: string | null }[];
      next_cursor: string | null;
    };
    const project = page.items.find((item) => item.id === jobId);
    assert.ok(project);
    assert.equal(project.thumbnail_url, `/api/v1/clips/${clipId}/file?preview=1`);
    assert.ok("next_cursor" in page);
  });

  await check("GET /projects/[id] có clip và cờ transcript", async () => {
    const res = await callApi(a, `/projects/${jobId}`);
    assert.equal(res.status, 200);
    const project = res.body as {
      clips: { id: string; revision: number | null }[];
      has_transcript: boolean;
    };
    assert.equal(project.clips.length, 1);
    assert.equal(project.clips[0].id, clipId);
    assert.equal(project.clips[0].revision, 1);
    assert.equal(project.has_transcript, true);
  });

  await check("clip downloads refresh signatures and respect ownership", async () => {
    const download = await callApi(a, `/clips/${clipId}/file?resolve=1`);
    assert.equal(download.status, 200);
    assert.equal(typeof (download.body as { url: string }).url, "string");
    assert.equal((await callApi(a, `/clips/${clipId}/file`)).status, 303);
    assert.equal((await callApi(a, `/clips/${clipId}/file?preview=1`)).status, 303);
    assert.equal((await callApi(b, `/clips/${clipId}/file?resolve=1`)).status, 404);
    assert.equal((await callApi(null, `/clips/${clipId}/file`)).status, 401);
  });

  await check("GET /projects/[id]/transcript trả artifact", async () => {
    const res = await callApi(a, `/projects/${jobId}/transcript`);
    assert.equal(res.status, 200);
    assert.ok((res.body as { transcript: unknown }).transcript);
  });

  // Không gọi YouTube thật ở đây (CI có thể không có mạng ra ngoài): chỉ kiểm
  // hai chốt chặn — phải đăng nhập, và host ngoài YouTube bị từ chối (chống SSRF).
  await check("GET /source-preview cần đăng nhập và chỉ nhận link YouTube", async () => {
    assert.equal((await callApi(null, "/source-preview?url=https%3A%2F%2Fyoutu.be%2Fx")).status, 401);
    const other = await callApi(a, `/source-preview?url=${encodeURIComponent("http://169.254.169.254/latest")}`);
    assert.equal(other.status, 400);
    assert.equal((await callApi(a, "/source-preview?url=not-a-url")).status, 400);
  });

  await check("GET /account trả account, quota ngày và mốc reset UTC", async () => {
    const res = await callApi(a, "/account");
    assert.equal(res.status, 200);
    const account = res.body as {
      email: string;
      credits: number;
      plan: string;
      quota: {
        previews: { used: number; limit: number };
        exports: { used: number; limit: number };
        storage: { limit: number };
      };
      resets_at: string;
    };
    assert.equal(account.email, a.email);
    assert.equal(typeof account.credits, "number");
    assert.equal(account.plan, "free");
    assert.deepEqual(account.quota.previews, { used: 0, limit: 20 });
    assert.deepEqual(account.quota.exports, { used: 0, limit: 5 });
    assert.ok(account.quota.storage.limit > 0);
    assert.match(account.resets_at, /T00:00:00(?:\.000)?(?:Z|\+00:00)$/);
    // User mới chưa có việc CMO nào: 0 chứ không phải null (null = đếm lỗi).
    assert.equal((account as { cmo_pending?: unknown }).cmo_pending, 0);
    const reset = new Date(account.resets_at);
    assert.ok(reset.getTime() > Date.now());
    assert.ok(reset.getTime() - Date.now() <= 24 * 60 * 60 * 1000);
    assert.equal(reset.getUTCHours(), 0);
    assert.equal(reset.getUTCMinutes(), 0);
  });

  await check("PATCH favorite được lưu thật", async () => {
    const res = await callApi(a, `/projects/${jobId}`, {
      method: "PATCH",
      body: JSON.stringify({ favorite: true }),
    });
    assert.equal(res.status, 200);
    assert.equal((res.body as { favorite: boolean }).favorite, true);
    const { data } = await admin.from("jobs").select("pinned").eq("id", jobId).single();
    assert.equal(data?.pinned, true);
  });

  await check("/uploads tạo reservation và Storage chặn path tự chế", async () => {
    const reservation = await callApi(a, "/uploads", {
      method: "POST",
      body: JSON.stringify({ name: "source.mp4", size: 100, kind: "source" }),
    });
    assert.equal(reservation.status, 200);
    const objectName = (reservation.body as { objectName: string }).objectName;
    const { data: row } = await admin
      .from("upload_reservations")
      .select("object_name,declared_size")
      .eq("object_name", objectName)
      .single();
    assert.equal(row?.declared_size, 100);

    const userStorage = createClient(URL_!, ANON!, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${a.accessToken}` } },
    });
    const forged = await userStorage.storage
      .from("sources")
      .upload(`${a.userId}/forged.mp4`, Buffer.alloc(10), { contentType: "video/mp4" });
    assert.ok(forged.error);
    const wrongSize = await userStorage.storage
      .from("sources")
      .upload(objectName, Buffer.alloc(101), { contentType: "video/mp4" });
    assert.ok(wrongSize.error);
  });

  await check("Brand kit: lưu qua RPC, logo chỉ trong thư mục mình, người khác không thấy", async () => {
    const userStorage = createClient(URL_!, ANON!, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${a.accessToken}` } },
    });
    const logo = `${a.userId}/logo-${crypto.randomUUID()}.png`;
    // PNG 1×1 thật: bucket `brand` chỉ nhận image/png.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
    assert.equal((await userStorage.storage.from("brand").upload(logo, png, { contentType: "image/png" })).error, null);
    const forged = await userStorage.storage.from("brand").upload(`${b.userId}/logo-${crypto.randomUUID()}.png`, png, { contentType: "image/png" });
    assert.ok(forged.error, "không ghi được vào thư mục người khác");

    const kit = {
      version: 1,
      colors: { primary: "#22C55E", secondary: "#A78BFA", accent: "#FF5A1F", text: "#FFF7ED", background: "#1B1A3A" },
      fonts: { heading: "Anton", body: "DM Sans" },
      captions: { preset: "spotlight" },
      layout: { aspect: "9:16", fit: "fill" },
      logo: { object: logo, width: 64, height: 64, corner: "top-right", size: 0.18, opacity: 1 },
    };
    const saved = await callApi(a, "/brand-kits", { method: "POST", body: JSON.stringify({ name: "Contract brand", kit }) });
    assert.equal(saved.status, 200);
    const row = saved.body as { id: string; is_default: boolean };
    assert.equal(row.is_default, true);
    const bad = await callApi(a, "/brand-kits", { method: "POST", body: JSON.stringify({ name: "Bad", kit: { ...kit, fonts: { heading: "Comic Sans", body: "Inter" } } }) });
    assert.equal(bad.status, 422);
    const stolen = await callApi(a, "/brand-kits", {
      method: "POST",
      body: JSON.stringify({ name: "Stolen", kit: { ...kit, logo: { ...kit.logo, object: `${b.userId}/logo-${crypto.randomUUID()}.png` } } }),
    });
    assert.equal(stolen.status, 422, "logo của người khác bị chặn ở RPC");

    assert.equal(((await callApi(a, "/brand-kits")).body as { kits: unknown[] }).kits.length, 1);
    assert.equal(((await callApi(b, "/brand-kits")).body as { kits: unknown[] }).kits.length, 0);
    assert.equal((await callApi(b, `/brand-kits/${row.id}`, { method: "DELETE" })).status, 404);
    assert.equal((await callApi(a, `/brand-kits/logo?object=${encodeURIComponent(logo)}&resolve=1`)).status, 200);
    assert.equal((await callApi(b, `/brand-kits/logo?object=${encodeURIComponent(logo)}&resolve=1`)).status, 404);
    assert.equal((await callApi(a, `/brand-kits/${row.id}`, { method: "DELETE" })).status, 200);
  });

  // ------------------------------------------------- cách ly giữa hai người
  await check("B không đọc được project của A", async () => {
    assert.equal((await callApi(b, `/projects/${jobId}`)).status, 404);
  });

  await check("B không ghim được project của A", async () => {
    const res = await callApi(b, `/projects/${jobId}`, {
      method: "PATCH",
      body: JSON.stringify({ favorite: false }),
    });
    assert.equal(res.status, 404);
  });

  await check("B không đọc được transcript của A", async () => {
    assert.equal((await callApi(b, `/projects/${jobId}/transcript`)).status, 404);
  });

  // Mutant caught: route hard-deletes without calling the ownership-checked
  // RPC, or leaves DELETE unavailable after durable retention manifests exist.
  await check("DELETE /projects/[id] giữ ownership rồi xoá project đã dừng", async () => {
    const candidate = await seedProject(a.userId);
    const foreign = await callApi(b, `/projects/${candidate.jobId}`, { method: "DELETE" });
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, { detail: "Project not found." });

    const deleted = await callApi(a, `/projects/${candidate.jobId}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body, { deleted: true });
    const { data, error } = await admin.from("jobs").select("id").eq("id", candidate.jobId).maybeSingle();
    assert.equal(error, null);
    assert.equal(data, null, "the project leaves the current list only after the server confirms deletion");
    // Manifest cố ý sống sau hard-delete để cron dọn Storage; contract fixture
    // không chạy cron nên tự dọn hàng test để không làm bẩn stack local chung.
    await admin.from("storage_deletions").delete().eq("job_id", candidate.jobId);
    await admin.storage.from("clips").remove([candidate.clipPath]);
  });

  await check("B không tải được export của A", async () => {
    // Export chưa có: id giả vẫn phải ra 404, không phải 403 hay 500.
    const res = await callApi(b, `/tasks/${crypto.randomUUID()}/file`);
    assert.equal(res.status, 404);
  });

  // ======================================================== editor mới
  //
  // Ba route của Phase 2. Thứ tự có ý nghĩa: project phải được TẠO ở lượt GET
  // đầu tiên, và mọi assertion sau đó dựa vào version mà lượt đó trả về.
  let editorVersion = 0;
  let editorRevisionId = "";

  await check("GET /editor/project sinh project lần đầu và ký URL media", async () => {
    const res = await callApi(a, `/editor/project?clip_id=${clipId}`);
    assert.equal(res.status, 200);
    const body = res.body as {
      version: number;
      document: Doc;
      document_hash: string;
      media: {
        project_id: string;
        master: { url: string; width: number; height: number };
        transcript: string | null;
      };
    };
    editorVersion = body.version;
    assert.equal(body.version, 1);

    // Bốn thứ hỏng IM LẶNG nếu bộ sinh viết sai — không cái nào ném lỗi.
    assert.equal(body.document.version, 1);
    assert.equal(sceneOf(body.document).active, true, "thiếu `active` thì không có scene nào để export");
    assert.equal(sceneOf(body.document).workarea?.[0], 0, "thiếu `workarea` thì export sai độ dài");
    assert.ok(
      everything(body.document).some((node) => node.kind === "video" && node.src === "assets/master.mp4"),
      "signed URL không được nằm trong src",
    );
    assert.doesNotMatch(JSON.stringify(body.document), /https?:\/\//, "không có URL tuyệt đối nào lọt vào document");
    assert.match(body.document_hash, /^[0-9a-f]{64}$/, "vân tay để chụp revision cho Export");

    assert.match(body.media.master.url, /^http/);
    assert.equal(body.media.master.width, 960);
    assert.equal(body.media.master.height, 540);
    assert.ok(body.media.transcript, "clip có transcript thì media phải trỏ tới nó");
    // Id của JOB: B-roll thuộc về project, và editor chỉ biết clip id từ URL.
    assert.equal(body.media.project_id, jobId);
  });

  // Master của Phase 3: nguyên liệu THẬT của editor mới. Clip thứ hai vì clip
  // đầu đã có project sinh từ proxy — và cùng một job mang cả hai là đúng cái
  // trạng thái sẽ có thật trong ngày Phase 3 chạy, khi thư viện của người dùng
  // có cả clip cũ lẫn clip mới.
  await check("GET /editor/project dùng master và bám mặt động khi có", async () => {
    const masterPath = `${a.userId}/${crypto.randomUUID()}/master/att.mp4`;
    const transcriptPath = `${masterPath.slice(0, -4)}.transcript.json`;

    for (const [path, body, type] of [
      [masterPath, "OpenCMO master fixture", "video/mp4"],
      [transcriptPath, JSON.stringify([{ text: "hi", words: [{ text: "hi", start: 0, end: 1 }] }]),
       "application/json"],
    ] as const) {
      const { error } = await admin.storage
        .from("renders")
        .upload(path, Buffer.from(body), { contentType: type, upsert: false });
      if (error) throw new Error(`seed master: ${error.message}`);
    }

    const { data: clip, error: clipError } = await admin
      .from("clips")
      .insert({
        job_id: jobId, idx: 1, hook: "Master clip",
        start_seconds: 40, end_seconds: 70, source_start: 40, source_end: 70,
        storage_path: `${a.userId}/${jobId}/1/01-master.mp4`,
      })
      .select()
      .single();
    if (clipError || !clip) throw new Error(`seed master clip: ${clipError?.message}`);

    await admin
      .from("clips")
      .update({
        settings: { source_start: 40, source_end: 70, layout: "fill", focus_x: 0.5 },
        settings_hash: "b".repeat(64),
      })
      .eq("id", clip.id);

    // Từ R4 worker tính sẵn tâm khung (`steps/reframe.py::editor_focus`) vào
    // `masters[clip].focus`; route chỉ đọc. Mốc theo giây của master, khúc
    // `source_start 40 − offset 38 = 2` tới hết clip; người nói đi trái sang phải.
    const points: [number, number][] = [];
    for (let t = 2; t <= 32; t += 0.5) points.push([t, t < 17 ? 0.3 : 0.75]);
    const focus = { frame: points, reframe: points };

    // GỘP, không thay: clip đầu vẫn phải mở được bằng proxy. Đè cả manifest ở
    // đây là dựng lại đúng cái mốc mà `media.ts` tồn tại để tránh — một nửa thư
    // viện của người dùng ngừng mở ra.
    const { data: current } = await admin
      .from("jobs").select("media_manifest").eq("id", jobId).single();

    const { error: manifestError } = await admin
      .from("jobs")
      .update({
        media_manifest: {
          ...((current?.media_manifest ?? {}) as Record<string, unknown>),
          masters: {
            [clip.id]: {
              bucket: "renders", object: masterPath, transcript: transcriptPath,
              width: 1920, height: 1080, duration: 34, offset: 38, focus,
            },
          },
        },
      })
      .eq("id", jobId);
    if (manifestError) throw new Error(`seed masters: ${manifestError.message}`);

    const res = await callApi(a, `/editor/project?clip_id=${clip.id}`);
    assert.equal(res.status, 200);
    const body = res.body as {
      document: Doc;
      media: { master: { width: number; height: number }; transcript: string | null };
    };

    // Master thắng proxy: độ phân giải NGUỒN, không phải 540p.
    assert.equal(body.media.master.width, 1920);
    assert.equal(body.media.master.height, 1080);
    // Transcript là một object THẬT đã ký, không còn là route dựng lại.
    assert.match(body.media.transcript ?? "", /^http/);
    assert.ok(
      (body.media.transcript ?? "").includes("transcript.json"),
      "phải ký chính file transcript của master",
    );

    // Bám mặt động — thứ `reframe.py` không làm được. Mốc là SOURCE-local, tức
    // tính từ giây 0 của master (`source_start 40 − offset 38 = 2`).
    const track = everything(body.document).find((node) => node.property === "x" && Array.isArray(node.keyframes));
    assert.ok(track, "thiếu track x");
    const stamps = (track!.keyframes as { time: number }[]).map((keyframe) => keyframe.time);
    assert.equal(stamps[0], 2, "mốc đầu phải là `sourceIn`, không phải 0 và không phải 40");
    assert.ok(stamps.every((t) => t <= 32), `mốc phải nằm trong master: ${stamps}`);
  });

  await check("GET /editor/project lần hai không sinh lại", async () => {
    const res = await callApi(a, `/editor/project?clip_id=${clipId}`);
    assert.equal(res.status, 200);
    assert.equal((res.body as { version: number }).version, editorVersion);
  });

  await check("PUT /editor/document lưu và tăng version", async () => {
    const document = await documentOf(a, clipId);
    sceneOf(document).fill = "#101010";
    const res = await callApi(a, "/editor/document", {
      method: "PUT",
      body: JSON.stringify({ clip_id: clipId, expected_version: editorVersion, document }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((res.body as { version: number }).version, editorVersion + 1);
    editorVersion += 1;
  });

  // Mutant caught: route bỏ `expected_version` xuống RPC, hoặc RPC ngừng so
  // sánh — hai tab cùng mở thì tab tới sau lặng lẽ ghi đè bài sửa của tab kia.
  await check("PUT /editor/document với version cũ trả 409 kèm bản hiện hành", async () => {
    const res = await callApi(a, "/editor/document", {
      method: "PUT",
      body: JSON.stringify({ clip_id: clipId, expected_version: 1, document: await documentOf(a, clipId) }),
    });
    assert.equal(res.status, 409);
    const detail = (res.body as { detail: { message: string; current: { version: number } } }).detail;
    assert.equal(detail.message, "This clip was changed in another tab.");
    assert.equal(detail.current.version, editorVersion);
  });

  await check("B không đọc và không ghi được project editor của A", async () => {
    assert.equal((await callApi(b, `/editor/project?clip_id=${clipId}`)).status, 404);
    const write = await callApi(b, "/editor/document", {
      method: "PUT",
      body: JSON.stringify({ clip_id: clipId, expected_version: editorVersion, document: { version: 1, stage: { children: [] } } }),
    });
    assert.equal(write.status, 404);
    // Bộ route cũ của fork đã gỡ ở C3.
    const legacy = await callApi(a, "/editor/project", {
      method: "PATCH",
      body: JSON.stringify({ clip_id: clipId, expected_version: editorVersion, source: "x" }),
    });
    assert.equal(legacy.status, 405);
  });

  await check("POST /editor/revision chụp đúng bản đang có", async () => {
    const hash = ((await callApi(a, `/editor/document?clip_id=${clipId}`)).body as { document_hash: string }).document_hash;

    const res = await callApi(a, "/editor/revision", {
      method: "POST",
      body: JSON.stringify({ clip_id: clipId, document_hash: hash }),
    });
    assert.equal(res.status, 200);
    assert.equal((res.body as { number: number }).number, 1);
    editorRevisionId = (res.body as { id: string }).id;

    // Hash của một bản KHÁC phải bị từ chối: chụp nhầm ở đây nghĩa là export ra
    // một file không ai từng nhìn thấy.
    const wrong = await callApi(a, "/editor/revision", {
      method: "POST",
      body: JSON.stringify({ clip_id: clipId, document_hash: "b".repeat(64) }),
    });
    assert.equal(wrong.status, 409);
  });

  await check("export trong trình duyệt đã gỡ (A4b): mode client, complete, upload export đều đóng", async () => {
    const client = await callApi(a, `/clips/${clipId}/exports`, {
      method: "POST",
      body: JSON.stringify({ mode: "client", revision_id: editorRevisionId, request_id: crypto.randomUUID() }),
    });
    assert.equal(client.status, 422, JSON.stringify(client.body));
    const complete = await callApi(a, `/exports/${crypto.randomUUID()}/complete`, { method: "POST", body: "{}" });
    assert.ok([404, 405].includes(complete.status), `complete: ${complete.status}`);
    const upload = await callApi(a, "/uploads", {
      method: "POST",
      body: JSON.stringify({ name: "export.mp4", size: 100, kind: "export", task_id: crypto.randomUUID() }),
    });
    assert.equal(upload.status, 422, JSON.stringify(upload.body));
  });

  await check("export document: worker vẽ document của revision, độ phân giải theo gói", async () => {
    await admin.from("rate_limits").update({ count: 0 }).eq("user_id", a.userId).eq("bucket", "export");
    const requestId = crypto.randomUUID();
    const started = await callApi(a, `/clips/${clipId}/exports`, {
      method: "POST",
      body: JSON.stringify({ mode: "document", revision_id: editorRevisionId, request_id: requestId }),
    });
    assert.equal(started.status, 200);
    const reply = started.body as { task_id: string; status: string; resolution: number };
    assert.equal(reply.status, "queued", "xếp hàng ngay, không chờ upload");
    assert.equal(reply.resolution, 720, "free plan bị kẹp ở 720p");

    const { data: task, error } = await admin
      .from("tasks")
      .select("kind,status,payload,editor_revision_id")
      .eq("id", reply.task_id)
      .single();
    if (error) throw error;
    assert.equal(task.kind, "render_document");
    assert.equal(task.editor_revision_id, editorRevisionId);
    assert.equal(task.payload.resolution, 720);
    assert.equal(task.payload.bucket, "exports");
    assert.ok(task.payload.manifest && Array.isArray(task.payload.manifest.assets), "payload chụp manifest thư viện");

    const again = await callApi(a, `/clips/${clipId}/exports`, {
      method: "POST",
      body: JSON.stringify({ mode: "document", revision_id: editorRevisionId, request_id: requestId }),
    });
    assert.equal((again.body as { task_id: string }).task_id, reply.task_id, "cùng request id là cùng task");

    const other = await callApi(b, `/clips/${clipId}/exports`, {
      method: "POST",
      body: JSON.stringify({ mode: "document", revision_id: editorRevisionId, request_id: crypto.randomUUID() }),
    });
    assert.equal(other.status, 404, "B không export được clip của A");

    // Hạn mức export/ngày của gói: câu SQL đi nguyên văn ra client thành 429.
    await admin.from("rate_limits").update({ count: 5 }).eq("user_id", a.userId).eq("bucket", "export");
    const limited = await callApi(a, `/clips/${clipId}/exports`, {
      method: "POST",
      body: JSON.stringify({ revision_id: editorRevisionId, request_id: crypto.randomUUID() }),
    });
    assert.equal(limited.status, 429, JSON.stringify(limited.body));
    assert.deepEqual(limited.body, { detail: "You have reached today's limit for this plan." });
    await admin.from("rate_limits").update({ count: 0 }).eq("user_id", a.userId).eq("bucket", "export");

    // Dọn: worker dev không chạy trong check:api, task không được treo ở hàng đợi.
    await admin.from("tasks").update({ status: "cancelled" }).eq("id", reply.task_id);
  });

  await check("GET /editor/transcript trả hình dạng native của DS", async () => {
    const res = await callApi(a, `/editor/transcript?clip_id=${clipId}`);
    assert.equal(res.status, 200);
    const body = res.body as { text: string; words: { text: string; start: number }[] }[];
    assert.ok(Array.isArray(body), "phải là MẢNG — bọc thêm một lớp là phụ đề rỗng, im lặng");
    assert.equal(body.length, 1);
    assert.equal(body[0].text, "seeded words");
    // Mốc theo thang của FILE nguồn (offset 9), không phải của video gốc.
    assert.equal(body[0].words[0].start, 1);
    assert.equal(body[0].words.length, 2);
  });

  await check("B không đọc được transcript editor của A", async () => {
    assert.equal((await callApi(b, `/editor/transcript?clip_id=${clipId}`)).status, 404);
  });

  // ------------------------------------------------ transcript đã sửa
  const edited = [{ text: "fixed words", words: [{ text: "fixed", start: 1, end: 1.4 }] }];
  let editedHash = "";
  await check("POST /editor/transcript lưu theo nội dung và trả hash sha256", async () => {
    const res = await callApi(a, "/editor/transcript", {
      method: "POST",
      body: JSON.stringify({ clip_id: clipId, transcript: edited }),
    });
    assert.equal(res.status, 200);
    editedHash = (res.body as { hash: string }).hash;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(edited)));
    const expected = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    // Client ghi bản OPFS bằng cùng `JSON.stringify`: hai phía phải ra cùng hash.
    assert.equal(editedHash, expected);
  });

  await check("GET /editor/transcript?hash trả đúng từng byte đã lưu", async () => {
    const res = await callApi(a, `/editor/transcript?clip_id=${clipId}&hash=${editedHash}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, edited);
    const missing = await callApi(a, `/editor/transcript?clip_id=${clipId}&hash=${"c".repeat(64)}`);
    assert.equal(missing.status, 404);
  });

  // Mutant caught: zod bỏ `start <= end` — một từ kết thúc trước khi bắt đầu
  // làm decoder phụ đề nhảy lùi, không ném lỗi nào.
  await check("POST /editor/transcript chặn từ có mốc ngược", async () => {
    const res = await callApi(a, "/editor/transcript", {
      method: "POST",
      body: JSON.stringify({
        clip_id: clipId,
        transcript: [{ text: "x", words: [{ text: "x", start: 2, end: 1 }] }],
      }),
    });
    assert.equal(res.status, 422);
  });

  await check("B không đọc và không ghi được transcript đã sửa của A", async () => {
    assert.equal(
      (await callApi(b, `/editor/transcript?clip_id=${clipId}&hash=${editedHash}`)).status,
      404,
    );
    const write = await callApi(b, "/editor/transcript", {
      method: "POST",
      body: JSON.stringify({ clip_id: clipId, transcript: edited }),
    });
    assert.equal(write.status, 404);
  });

  // ------------------------------------------------ lịch sử và reset
  await check("GET /editor/revisions liệt kê bản gốc và bản đã export", async () => {
    const res = await callApi(a, `/editor/revisions?clip_id=${clipId}`);
    assert.equal(res.status, 200);
    const body = res.body as { original: boolean; revisions: { id: string; number: number }[] };
    assert.equal(body.original, true);
    assert.ok(body.revisions.some((revision) => revision.id === editorRevisionId));
    assert.equal((await callApi(b, `/editor/revisions?clip_id=${clipId}`)).status, 404);
  });

  await check("GET/PUT /editor/document: đọc, ghi có khoá lạc quan, vân tay theo document", async () => {
    const got = await callApi(a, `/editor/document?clip_id=${clipId}`);
    assert.equal(got.status, 200);
    const body = got.body as { version: number; document: { stage: { children: Record<string, unknown>[] } } };
    assert.equal(body.version, editorVersion);
    const next = structuredClone(body.document);
    next.stage.children[0]!.fill = "#654321";
    const put = (payload: Record<string, unknown>, user = a) =>
      callApi(user, "/editor/document", { method: "PUT", body: JSON.stringify({ clip_id: clipId, ...payload }) });

    const saved = await put({ expected_version: editorVersion, document: next });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((saved.body as { version: number }).version, editorVersion + 1);
    editorVersion += 1;
    const project = (await callApi(a, `/editor/project?clip_id=${clipId}`)).body as { document: Doc };
    assert.equal(project.document.stage.children[0]!.fill, "#654321", "mở lại ra đúng thứ vừa lưu");
    // Client không tự tính vân tay: hash để chụp revision cho Export đến từ server.
    const hash = (saved.body as { document_hash: string }).document_hash;
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(((await callApi(a, `/editor/document?clip_id=${clipId}`)).body as { document_hash: string }).document_hash, hash);
    const revision = await callApi(a, "/editor/revision", {
      method: "POST",
      body: JSON.stringify({ clip_id: clipId, document_hash: hash }),
    });
    assert.equal(revision.status, 200, JSON.stringify(revision.body));

    const stale = await put({ expected_version: editorVersion - 1, document: next });
    assert.equal(stale.status, 409);
    const current = (stale.body as { detail: { current: { version: number; document: unknown } } }).detail.current;
    assert.equal(current.version, editorVersion, "409 mang bản hiện hành để shell tải lại");
    assert.ok(current.document, "409 mang cả document");
    const invalid = await put({ expected_version: editorVersion, document: { version: 1, stage: { kind: "rect" } } });
    assert.equal(invalid.status, 422);
    assert.equal((await put({ expected_version: editorVersion, document: next }, b)).status, 404);
    assert.equal((await callApi(b, `/editor/document?clip_id=${clipId}`)).status, 404);
  });

  await check("POST /editor/project/reset có khoá lạc quan và về đúng bản gốc", async () => {
    const original = await callApi(a, `/editor/revisions?clip_id=${clipId}&id=original`);
    assert.equal(original.status, 200);
    const stale = await callApi(a, "/editor/project/reset", {
      method: "POST",
      body: JSON.stringify({ clip_id: clipId, expected_version: 1 }),
    });
    assert.equal(stale.status, 409);

    const current = (await callApi(a, `/editor/project?clip_id=${clipId}`)).body as { version: number };
    const res = await callApi(a, "/editor/project/reset", {
      method: "POST",
      body: JSON.stringify({ clip_id: clipId, expected_version: current.version }),
    });
    assert.equal(res.status, 200);
    const reset = res.body as { document: Doc; version: number };
    assert.deepEqual(reset.document, (original.body as { document: Doc }).document);
    editorVersion = reset.version;
  });

  // ------------------------------------------- op trên server (AI Studio P1)
  const ops = (body: Record<string, unknown>) =>
    callApi(a, "/editor/ops", { method: "POST", body: JSON.stringify({ clip_id: clipId, ...body }) });

  await check("POST /editor/ops áp set_frame + set_caption_style và tăng version", async () => {
    const res = await ops({
      expected_version: editorVersion,
      ops: [
        { op: "set_frame", width: 1080, height: 1080 },
        { op: "set_caption_style", preset: "spotlight", colors: ["#FFD400"] },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = res.body as {
      project: { document: Doc; version: number };
      results: { op: string; changed: boolean }[];
      checkpoint: null;
    };
    assert.equal(body.project.version, editorVersion + 1);
    assert.equal(frameOf(body.project.document), "1080x1080");
    const styled = everything(body.project.document).find((node) => node.kind === "captions");
    assert.equal(styled?.preset, "spotlight");
    assert.deepEqual(styled?.colors, ["#FFD400"]);
    assert.deepEqual(body.results.map((result) => [result.op, result.changed]), [
      ["set_frame", true],
      ["set_caption_style", true],
    ]);
    assert.equal(body.checkpoint, null);
    editorVersion = body.project.version;
  });

  await check("POST /editor/ops với version cũ trả 409 kèm bản hiện hành, không áp gì", async () => {
    const res = await ops({ expected_version: editorVersion - 1, ops: [{ op: "set_frame", width: 1920, height: 1080 }] });
    assert.equal(res.status, 409);
    assert.equal((res.body as { detail: { version: number } }).detail.version, editorVersion);
  });

  await check("B không áp được op lên project của A", async () => {
    const res = await callApi(b, "/editor/ops", {
      method: "POST",
      body: JSON.stringify({ clip_id: clipId, expected_version: editorVersion, ops: [{ op: "restore_all" }] }),
    });
    assert.equal(res.status, 404);
  });

  await check("POST /editor/ops: op sai schema hay không tồn tại là 422 kèm vị trí", async () => {
    const bad = await ops({
      expected_version: editorVersion,
      ops: [{ op: "set_caption_style", preset: "stark" }, { op: "set_frame", width: 5, height: 1080 }],
    });
    assert.equal(bad.status, 422);
    const detail = (bad.body as { detail: { index: number; op: string; message: string } }).detail;
    assert.equal(detail.index, 1);
    assert.equal(detail.op, "set_frame");
    assert.match(detail.message, /^width: /);
    // Không có "ghi nguồn thô": tên op nằm ngoài registry bị zod của route chặn.
    const raw = await ops({ expected_version: editorVersion, ops: [{ op: "write_source", source: "x" }] });
    assert.equal(raw.status, 422);
    const unchanged = (await callApi(a, `/editor/project?clip_id=${clipId}`)).body as { version: number };
    assert.equal(unchanged.version, editorVersion);
  });

  await check("remove_words theo id trên transcript gốc: lưu transcript và dựng <sequence>", async () => {
    const { normalize } = await import("@opencmo/editor-core/transcript");
    const transcript = normalize(
      (await callApi(a, `/editor/transcript?clip_id=${clipId}`)).body as Parameters<typeof normalize>[0],
    );
    const first = transcript[0].words[0];
    assert.equal(first.text, "seeded");
    const before = await admin.from("editor_transcripts").select("hash").eq("clip_id", clipId);

    const res = await ops({ expected_version: editorVersion, ops: [{ op: "remove_words", word_ids: [first.id] }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const cut = everything((res.body as { project: { document: Doc } }).project.document);
    assert.ok(cut.some((node) => node.kind === "sequence" && (node.marks as Record<string, unknown> | undefined)?.["text-cut"]));
    const document = (res.body as { project: { document: { stage: { children: { children?: { kind: string; src?: string }[] }[] } } } })
      .project.document;
    const captions = document.stage.children[0]!.children!.find((node) => node.kind === "captions");
    assert.match(String(captions?.src), /^assets\/transcripts\/[0-9a-f]{64}\.json$/);
    const after = await admin.from("editor_transcripts").select("hash").eq("clip_id", clipId);
    assert.equal((after.data ?? []).length, (before.data ?? []).length + 1, "transcript output sau cắt được lưu");
    editorVersion = (res.body as { project: { version: number } }).project.version;
  });

  await check("checkpoint: chụp bản đang lưu, gọi lại không nhân bản, hiện trong lịch sử", async () => {
    const label = "Before applying caption style";
    const first = await ops({ expected_version: editorVersion, ops: [], checkpoint: { kind: "manual", label } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const checkpoint = (first.body as { checkpoint: { id: string; kind: string; label: string } }).checkpoint;
    assert.equal(checkpoint.kind, "manual");
    assert.equal(checkpoint.label, label);
    const again = await ops({ expected_version: editorVersion, ops: [], checkpoint: { kind: "manual", label } });
    assert.equal((again.body as { checkpoint: { id: string } }).checkpoint.id, checkpoint.id);

    const history = (await callApi(a, `/editor/revisions?clip_id=${clipId}`)).body as {
      revisions: { id: string; kind: string; label: string | null }[];
    };
    assert.deepEqual(
      history.revisions.filter((revision) => revision.id === checkpoint.id).map((r) => [r.kind, r.label]),
      [["manual", label]],
    );
    const snapshot = (await callApi(a, `/editor/revisions?clip_id=${clipId}&id=${checkpoint.id}`)).body as {
      document: Doc;
    };
    assert.deepEqual(snapshot.document, await documentOf(a, clipId), "checkpoint là bản server đang giữ");
  });

  await check("op không đổi gì thì không để lại checkpoint và không tăng version", async () => {
    const res = await ops({
      expected_version: editorVersion,
      ops: [{ op: "set_caption_style", preset: "spotlight", colors: ["#FFD400"] }],
      checkpoint: { kind: "manual", label: "Before applying caption style" },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = res.body as { project: { version: number }; results: { changed: boolean }[]; checkpoint: unknown };
    assert.equal(body.checkpoint, null);
    assert.equal(body.results[0].changed, false);
    assert.equal(body.project.version, editorVersion);
  });

  await check("POST /editor/ops rỗng mà không xin checkpoint là 422", async () => {
    assert.equal((await ops({ expected_version: editorVersion, ops: [] })).status, 422);
  });

  // ------------------------------------------------ Assistant (AI Studio P2)
  // Server phải chạy với OPENCMO_AGENT_FAKE=1: Claude giả, kịch bản cố định.
  const balance = async (userId: string) =>
    ((await admin.from("profiles").select("credit_balance").eq("id", userId).single()).data as {
      credit_balance: number;
    }).credit_balance;
  let agentSession = "";
  let frameBefore = "";
  await check("Assistant: GET chưa có phiên, POST mở phiên, người khác 404", async () => {
    const empty = await callApi(a, `/agent/sessions?clip_id=${clipId}`);
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    const view = empty.body as { available: boolean; session: unknown };
    assert.equal(view.available, true, "chạy server với OPENCMO_AGENT_FAKE=1");
    assert.equal(view.session, null);

    const opened = await callApi(a, "/agent/sessions", { method: "POST", body: JSON.stringify({ clip_id: clipId }) });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    agentSession = (opened.body as { id: string }).id;
    const again = await callApi(a, "/agent/sessions", { method: "POST", body: JSON.stringify({ clip_id: clipId }) });
    assert.equal((again.body as { id: string }).id, agentSession, "mở lại là cùng phiên");

    assert.equal((await callApi(b, `/agent/sessions?clip_id=${clipId}`)).status, 404);
    const foreign = await callApi(b, "/agent/sessions", { method: "POST", body: JSON.stringify({ clip_id: clipId }) });
    assert.equal(foreign.status, 404);
  });

  await check("Assistant: thiếu credit bị chặn trước khi stream mở", async () => {
    const res = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Make it vertical" });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(JSON.stringify(res.body), /Not enough credits/);
  });

  await admin.from("credit_ledger").insert({ user_id: a.userId, delta: 20, reason: "contract check grant" });

  await check("Assistant: một lượt gọi set_frame qua op, chốt credit thật, stream đủ event", async () => {
    // Các check ops ở trên đã để clip ở 1:1: "vertical" chắc chắn đổi khung.
    frameBefore = frameOf(await documentOf(a, clipId));
    const before = await balance(a.userId);
    const res = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Make it vertical" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const names = res.events.map((event) => event.event);
    assert.deepEqual(names.filter((name) => name !== "text" && name !== "thinking"), [
      "turn",
      "tool_start",
      "tool_result",
      "project_changed",
      "done",
    ]);
    const result = res.events.find((event) => event.event === "tool_result")!.data;
    assert.equal(result.name, "set_frame");
    assert.equal(result.ok, true);
    const done = res.events.at(-1)!.data;
    assert.equal(done.status, "done");
    // Hai bước × (1200 vào + 80 ra) = 16 000 micro-USD → 1 credit.
    assert.equal(done.credits, 1);
    assert.equal(await balance(a.userId), before - 1, "giữ 5, hoàn 4");

    const project = (await callApi(a, `/editor/project?clip_id=${clipId}`)).body as { document: Doc; version: number };
    assert.equal(frameOf(project.document), "1080x1920");
    editorVersion = project.version;
  });

  await check("Assistant: tool input sai thành tool_result lỗi, project không đổi", async () => {
    const before = (await callApi(a, `/editor/project?clip_id=${clipId}`)).body as { version: number };
    const res = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "broken frame" });
    const result = res.events.find((event) => event.event === "tool_result")!.data;
    assert.equal(result.ok, false);
    assert.equal(res.events.some((event) => event.event === "project_changed"), false);
    assert.equal(res.events.at(-1)!.data.status, "done");
    const after = (await callApi(a, `/editor/project?clip_id=${clipId}`)).body as { version: number };
    assert.equal(after.version, before.version);
  });

  await check("Assistant: lịch sử phiên, và Undo đưa khung về như trước lượt", async () => {
    const view = (await callApi(a, `/agent/sessions?clip_id=${clipId}`)).body as {
      session: { turns: { number: number; prompt: string; reply: string; actions: { name: string }[]; can_undo: boolean }[] };
    };
    const [first, second] = view.session.turns;
    assert.equal(first.prompt, "Make it vertical");
    assert.match(first.reply, /vertical/);
    assert.deepEqual(first.actions.map((action) => action.name), ["set_frame"]);
    assert.equal(first.can_undo, true);
    assert.equal(second.can_undo, false, "lượt không ghi gì thì không có Undo");

    const undo = await callApi(a, `/agent/sessions/${agentSession}/turns/1/undo`, { method: "POST" });
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.equal(frameOf((undo.body as { project: { document: Doc } }).project.document), frameBefore);
    editorVersion = (undo.body as { project: { version: number } }).project.version;

    const history = (await callApi(a, `/editor/revisions?clip_id=${clipId}`)).body as {
      revisions: { kind: string; label: string | null }[];
    };
    assert.ok(history.revisions.some((r) => r.kind === "agent" && r.label === "Before assistant: Make it vertical"));
    assert.ok(history.revisions.some((r) => r.label === "Before undoing assistant request 1"));
    const after = (await callApi(a, `/agent/sessions?clip_id=${clipId}`)).body as {
      session: { turns: { undone: boolean; can_undo: boolean }[] };
    };
    assert.equal(after.session.turns[0].undone, true);
    assert.equal(after.session.turns[0].can_undo, false);
  });

  await check("Assistant: Undo đi từ lượt ghi mới nhất về", async () => {
    // Sau Undo lượt 1 khung đã về 1:1, nên "vertical" chắc chắn là một lượt ghi.
    await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Make it vertical again" });
    await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Add a title" });
    const older = await callApi(a, `/agent/sessions/${agentSession}/turns/3/undo`, { method: "POST" });
    assert.equal(older.status, 409, JSON.stringify(older.body));
    let view = (await callApi(a, `/agent/sessions?clip_id=${clipId}`)).body as {
      session: { turns: { number: number; can_undo: boolean }[] };
    };
    assert.deepEqual(view.session.turns.filter((t) => t.can_undo).map((t) => t.number), [4]);
    assert.equal((await callApi(a, `/agent/sessions/${agentSession}/turns/4/undo`, { method: "POST" })).status, 200);
    view = (await callApi(a, `/agent/sessions?clip_id=${clipId}`)).body as typeof view;
    assert.deepEqual(view.session.turns.filter((t) => t.can_undo).map((t) => t.number), [3]);
    const project = await documentOf(a, clipId);
    assert.doesNotMatch(JSON.stringify(project), /Watch this/, "undo lượt 4 gỡ chữ vừa thêm");
    assert.equal(frameOf(project), "1080x1920", "lượt 3 vẫn còn");
    editorVersion = project.version;
  });

  await check("Assistant: request_export dừng ở thẻ duyệt; Approve xếp bản 9:16 + bản 1:1, project giữ khung", async () => {
    const exportTasks = async () =>
      ((await admin.from("tasks").select("id, status, editor_revision_id").eq("clip_id", clipId).eq("kind", "render_document").order("created_at")).data ?? []) as { id: string; status: string; editor_revision_id: string }[];
    const before = (await exportTasks()).length;
    const first = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Export it, also as a square copy" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const request = first.events.find((event) => event.event === "approval_request");
    assert.ok(request, JSON.stringify(first.events.map((event) => event.event)));
    const card = request.data.card as { changes: string[]; credits: number };
    assert.equal(card.credits, 0);
    assert.match(card.changes[0]!, /^Export 9:16 \(Reels, TikTok, Shorts\) at (720|1080)p$/);
    assert.match(card.changes[1]!, /^Export a 1:1 \(square feed\) copy at (720|1080)p\. Your project stays as it is\.$/);
    assert.match(card.changes[2]!, /^Uses 2 of your \d+ exports a day on the \w+ plan\. No credits\.$/);

    const declined = await callSse(a, `/agent/sessions/${agentSession}/approvals`, { decisions: [{ tool_use_id: request.data.id, approved: false }] });
    assert.equal(declined.events.at(-1)!.data.status, "done");
    assert.equal((await exportTasks()).length, before, "Cancel không xếp export nào");

    const again = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Export it, also as a square copy" });
    const second = again.events.find((event) => event.event === "approval_request")!;
    const res = await callSse(a, `/agent/sessions/${agentSession}/approvals`, { decisions: [{ tool_use_id: second.data.id, approved: true }] });
    const result = res.events.find((event) => event.event === "tool_result" && event.data.name === "request_export");
    assert.ok(result, JSON.stringify(res.events.map((event) => event.event)));
    const exports = (result.data.view as { exports: { frame: string; task_id: string }[] }).exports;
    assert.deepEqual(exports.map((item) => item.frame), ["9:16", "1:1"]);
    const tasks = await exportTasks();
    assert.equal(tasks.length, before + 2);
    const { data: revisions } = await admin.from("editor_revisions").select("id, kind, label, document").in("id", tasks.slice(-2).map((task) => task.editor_revision_id));
    const square = (revisions ?? []).find((row) => row.label === "1:1");
    assert.ok(square, "bản 1:1 là một revision export riêng");
    assert.equal(frameOf(square.document as Doc), "1080x1080");
    assert.equal(frameOf(await documentOf(a, clipId)), "1080x1920", "project người dùng giữ khung 9:16");
    // Tải lại phiên: nút Download vẫn có dữ liệu (view lưu cùng kết quả tool).
    const view = (await callApi(a, `/agent/sessions?clip_id=${clipId}`)).body as { session: { turns: { actions: { name: string; view?: { exports?: unknown[] } }[] }[] } };
    assert.equal(view.session.turns.at(-1)!.actions.find((action) => action.name === "request_export")?.view?.exports?.length, 2);
    // Không để worker e2e render hai bản này.
    await admin.from("tasks").update({ status: "cancelled" }).in("id", exports.map((item) => item.task_id));
  });

  // ------------------------------------ tool trình duyệt: capture (P3, agent editor AE2)
  const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
  await check("capture: lượt dừng chờ editor, ảnh gửi về thì chạy tiếp tới hết", async () => {
    const first = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Check the frame" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const request = first.events.find((event) => event.event === "tool_request")!.data as {
      id: string;
      name: string;
      input: { times: number[] };
    };
    assert.equal(request.name, "capture");
    assert.deepEqual(request.input.times, [1, 2]);
    assert.equal(first.events.at(-1)!.data.status, "awaiting_browser");

    const view = (await callApi(a, `/agent/sessions?clip_id=${clipId}`)).body as {
      session: { locked: boolean; turns: { status: string; pending: { id: string }[] }[] };
    };
    const waiting = view.session.turns.at(-1)!;
    assert.equal(waiting.status, "awaiting_browser");
    assert.deepEqual(waiting.pending.map((item) => item.id), [request.id]);
    assert.equal(view.session.locked, true, "đang chờ editor vẫn giữ khoá");

    const second = await callSse(a, `/agent/sessions/${agentSession}/tool-results`, {
      results: [{ tool_use_id: request.id, images: [JPEG, JPEG] }],
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const result = second.events.find((event) => event.event === "tool_result")!.data;
    assert.deepEqual([result.name, result.ok, result.summary], ["capture", true, "Looked at 2 frames"]);
    assert.equal(second.events.at(-1)!.data.status, "done");
    const reply = second.events.filter((event) => event.event === "text").map((event) => event.data.text).join("");
    assert.match(reply, /looked at 2 frames/, "model giả nhận được đúng 2 ảnh");

    const again = await callSse(a, `/agent/sessions/${agentSession}/tool-results`, {
      results: [{ tool_use_id: request.id, images: [JPEG] }],
    });
    assert.equal(again.status, 409, "lượt không còn chờ thì không nhận kết quả");
  });

  await check("capture cùng bước với một tool ghi: ghép một tin nhắn, lỗi chụp báo cho model", async () => {
    const first = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Make it square and check it" });
    const names = first.events.map((event) => event.event);
    assert.ok(names.includes("project_changed"), "tool ghi cùng bước chạy ngay");
    const request = first.events.find((event) => event.event === "tool_request")!.data as { id: string };
    const second = await callSse(a, `/agent/sessions/${agentSession}/tool-results`, {
      results: [{ tool_use_id: request.id, error: "The editor could not render this frame." }],
    });
    const result = second.events.find((event) => event.event === "tool_result")!.data;
    assert.equal(result.ok, false);
    const reply = second.events.filter((event) => event.event === "text").map((event) => event.data.text).join("");
    assert.match(reply, /could not see the frames/);
    const view = (await callApi(a, `/agent/sessions?clip_id=${clipId}`)).body as {
      session: { turns: { actions: { name: string; ok: boolean }[] }[] };
    };
    assert.deepEqual(view.session.turns.at(-1)!.actions.map((action) => [action.name, action.ok]), [
      ["set_frame", true],
      ["capture", false],
    ]);
  });

  await check("capture: Stop khi đang chờ editor, người khác không gửi được kết quả", async () => {
    const first = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Check the frame" });
    const request = first.events.find((event) => event.event === "tool_request")!.data as { id: string };
    const foreign = await callSse(b, `/agent/sessions/${agentSession}/tool-results`, {
      results: [{ tool_use_id: request.id, images: [JPEG] }],
    });
    assert.equal(foreign.status, 404);
    const stop = await callApi(a, `/agent/sessions/${agentSession}/stop`, { method: "POST" });
    assert.equal((stop.body as { stopped: boolean }).stopped, true);
    const late = await callSse(a, `/agent/sessions/${agentSession}/tool-results`, {
      results: [{ tool_use_id: request.id, images: [JPEG] }],
    });
    assert.equal(late.status, 409);
  });

  // ------------------------------------------------ Agent editor (AE1–AE3)
  await admin.from("credit_ledger").insert({ user_id: a.userId, delta: 40, reason: "contract check grant agent editor" });
  type AgentView = {
    session: {
      id: string;
      turns: {
        number: number;
        status: string;
        pause_reason: string | null;
        reply: string;
        credits: number | null;
        plan: { text: string; status: string }[] | null;
        pending: { id: string; name: string; card?: { question?: string; options?: string[] } }[];
        actions: { id: string; name: string; ok: boolean; summary: string; input?: unknown }[];
      }[];
    };
    sessions: { id: string; title: string }[];
    models: { id: string }[];
  };
  const agentView = async () => (await callApi(a, `/agent/sessions?clip_id=${clipId}`)).body as AgentView;
  const replyOf = (res: { events: { event: string; data: { text?: string } }[] }) =>
    res.events.filter((event) => event.event === "text").map((event) => event.data.text).join("");

  await check("ask_user: lượt chờ câu trả lời, thẻ có câu hỏi, trả lời thì chạy tiếp", async () => {
    const first = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Ask me which style" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const request = first.events.find((event) => event.event === "input_request")!.data as { id: string; card: { question: string; options: string[] } };
    assert.equal(request.card.question, "Which caption style do you want?");
    assert.deepEqual(first.events.at(-1)!.data.status, "awaiting_input");
    const waiting = (await agentView()).session.turns.at(-1)!;
    assert.equal(waiting.status, "awaiting_input");
    assert.deepEqual(waiting.pending[0]!.card?.options, ["Classic", "Spotlight"]);
    const busy = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "something else" });
    assert.equal(busy.status, 409, "đang chờ câu trả lời thì không mở lượt mới");
    const skipped = await callSse(a, `/agent/sessions/${agentSession}/continue`, {});
    assert.equal(skipped.status, 409, "continue không được nuốt câu hỏi đang chờ (review PR 19)");

    const second = await callSse(a, `/agent/sessions/${agentSession}/tool-results`, {
      results: [{ tool_use_id: request.id, answer: { choices: ["Spotlight"] } }],
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.match(replyOf(second), /You chose: Spotlight/);
    assert.equal(second.events.at(-1)!.data.status, "done");
    const done = (await agentView()).session.turns.at(-1)!;
    assert.deepEqual(done.actions.map((action) => [action.name, action.summary]), [["ask_user", "Answered: Spotlight"]]);
  });

  await check("ask_user: Skip cũng là một câu trả lời", async () => {
    const first = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Ask me again" });
    const request = first.events.find((event) => event.event === "input_request")!.data as { id: string };
    const second = await callSse(a, `/agent/sessions/${agentSession}/tool-results`, {
      results: [{ tool_use_id: request.id, answer: { skipped: true } }],
    });
    assert.match(replyOf(second), /keep it as it is/);
  });

  await check("update_plan: danh sách việc đi kèm tool_result và nằm trong lượt", async () => {
    const res = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Make a plan for a hook" });
    const plan = res.events.find((event) => event.event === "tool_result" && event.data.name === "update_plan")!.data as {
      view: { plan: { text: string }[] };
    };
    assert.deepEqual(plan.view.plan.map((item) => item.text), ["Add a hook title", "Check the frame"]);
    assert.ok(res.events.some((event) => event.event === "project_changed"), "bước sau thêm chữ");
    const turn = (await agentView()).session.turns.at(-1)!;
    assert.deepEqual(turn.plan?.map((item) => item.status), ["active", "pending"]);
    assert.deepEqual(turn.actions.find((action) => action.name === "add_text")?.input, { text: "Watch this", start: 0, end: 3 });
  });

  await check("find_silences → remove_ranges; check + read_guide chạy ở server", async () => {
    const res = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Cut the long pauses" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const silences = res.events.find((event) => event.event === "tool_result" && event.data.name === "find_silences")!.data;
    assert.equal(silences.ok, true);
    assert.equal(res.events.at(-1)!.data.status, "done");

    const lint = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "lint the clip" });
    const results = lint.events.filter((event) => event.event === "tool_result").map((event) => [event.data.name, event.data.ok]);
    assert.deepEqual(results, [["check", true], ["read_guide", true]]);
  });

  await check("list_library đọc thư viện (kể cả video của clip)", async () => {
    const res = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Use B-roll from the library" });
    const listed = res.events.find((event) => event.event === "tool_result" && event.data.name === "list_library")!.data;
    assert.equal(listed.ok, true);
    assert.match(String(listed.summary), /^Read the library/);
  });

  await check("Hết credit giữ: dừng chờ gia hạn; continue thường 409; extend giữ thêm 10 rồi chạy tiếp", async () => {
    // Còn đủ số dư thì `agent_auto_extend` tự giữ thêm 10 một lần tới trần 60 và
    // lượt không dừng. Muốn lượt dừng hỏi "Continue?" thì sau phần giữ 5 đầu phải
    // còn dưới 10: đặt số dư đúng 14, rồi nạp 10 trước khi bấm extend.
    const start = await balance(a.userId);
    const grant = async (delta: number, reason: string) => {
      if (delta === 0) return;
      const { error } = await admin.from("credit_ledger").insert({ user_id: a.userId, delta, reason });
      if (error) throw new Error(`${reason}: ${error.message}`);
    };
    await grant(14 - start, "contract check: budget pause");
    const before = 14;
    const first = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Do something expensive" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const done = first.events.at(-1)!.data as { status: string; reason: string; extend: number };
    assert.deepEqual([done.status, done.reason, done.extend], ["awaiting_continue", "budget", 10]);
    assert.equal(await balance(a.userId), before - 5, "mới giữ 5, không tự gia hạn khi thiếu số dư");
    await grant(10, "contract check: top up to extend");
    const waiting = (await agentView()).session.turns.at(-1)!;
    assert.deepEqual([waiting.status, waiting.pause_reason], ["awaiting_continue", "budget"]);

    const plain = await callSse(a, `/agent/sessions/${agentSession}/continue`, {});
    assert.equal(plain.status, 409, "không gia hạn thì không chạy tiếp");
    const foreign = await callSse(b, `/agent/sessions/${agentSession}/continue`, { extend: true });
    assert.equal(foreign.status, 404);

    const more = await callSse(a, `/agent/sessions/${agentSession}/continue`, { extend: true });
    assert.equal(more.status, 200, JSON.stringify(more.body));
    assert.equal(more.events.at(-1)!.data.status, "done");
    const settled = (await agentView()).session.turns.at(-1)!;
    assert.equal(settled.credits, 15, "tính đúng phần đã giữ (5 + 10), không hơn");
    assert.equal(await balance(a.userId), before + 10 - 15);
    // Các ca sau tính theo số dư cũ trừ đúng lượt này.
    await grant(start - 15 - (before + 10 - 15), "contract check: restore balance");
  });

  await check("continue khi không có lượt nào chờ là 409", async () => {
    const res = await callSse(a, `/agent/sessions/${agentSession}/continue`, {});
    assert.equal(res.status, 409);
  });

  // ------------------------------------- Assistant dùng Generate (AI Studio P9)
  // Server chạy với OPENCMO_AGENT_FAKE=1 VÀ OPENCMO_AI_FAKE=1.
  await admin.from("credit_ledger").insert({ user_id: a.userId, delta: 20, reason: "contract check grant p9" });
  const lastGeneration = async () =>
    (await admin.from("generations").select("id, spec, model, credits_reserved, status").eq("clip_id", clipId).order("created_at", { ascending: false }).limit(1).maybeSingle()).data as
      | { id: string; spec: { prompt: string; voice: string; seed: number }; model: string; credits_reserved: number; status: string }
      | null;

  await check("Assistant + Generate: thẻ duyệt có giá, Cancel không tạo gì, không tốn credit sinh", async () => {
    const before = await lastGeneration();
    const first = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Add a voice-over" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const request = first.events.find((event) => event.event === "approval_request");
    assert.ok(request, JSON.stringify(first.events.map((event) => event.event)));
    const card = request.data.card as { changes: string[]; credits: number };
    assert.equal(card.credits, 1);
    assert.match(card.changes[0]!, /^Generate a voice-over: ".*" with (?:the voice .+|Test voice) · 1 credit$/);
    assert.equal(first.events.at(-1)!.data.status, "awaiting_approval");

    const declined = await callSse(a, `/agent/sessions/${agentSession}/approvals`, {
      decisions: [{ tool_use_id: request.data.id, approved: false }],
    });
    assert.equal(declined.events.at(-1)!.data.status, "done");
    assert.equal((await lastGeneration())?.id, before?.id, "Cancel không tạo generation");
  });

  await check("Assistant + Generate: Approve tạo lượt sinh + đặt khai báo lên clip; editor phân giải lại không trừ lần hai", async () => {
    const first = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Add a voice-over" });
    const request = first.events.find((event) => event.event === "approval_request")!;
    const res = await callSse(a, `/agent/sessions/${agentSession}/approvals`, {
      decisions: [{ tool_use_id: request.data.id, approved: true }],
    });
    assert.ok(res.events.some((event) => event.event === "project_changed"));
    assert.ok(res.events.some((event) => event.event === "tool_result" && event.data.summary === "Started voice-over (1 credit)"));

    const generation = (await lastGeneration())!;
    assert.equal(generation.model, "fake-voice");
    assert.equal(generation.credits_reserved, 1);
    const declared = everything(await documentOf(a, clipId)).find((node) => node.generate === "voice");
    assert.deepEqual(
      declared && { prompt: declared.prompt, voice: declared.voice, seed: declared.seed },
      { prompt: generation.spec.prompt, voice: generation.spec.voice, seed: generation.spec.seed },
      "khai báo trên clip đúng spec đã trả tiền",
    );

    // Editor phân giải khai báo đó như ô Generate: cùng spec → lượt đã có.
    const afterTurn = await balance(a.userId);
    const resolved = await callApi(a, "/generations", {
      method: "POST",
      body: JSON.stringify({
        job_id: jobId, clip_id: clipId, model: "fake-voice", request_id: crypto.randomUUID(),
        spec: { prompt: generation.spec.prompt, voice: generation.spec.voice, seed: generation.spec.seed },
      }),
    });
    assert.deepEqual(
      [(resolved.body as { reused: boolean }).reused, (resolved.body as { generation: { id: string } }).generation.id],
      [true, generation.id],
    );
    assert.equal(await balance(a.userId), afterTurn, "không trừ lần hai");
  });

  await check("Assistant + voiceover: repurpose = thẻ giá, Approve đặt giọng mới, tắt tiếng video gốc", async () => {
    const first = await callSse(a, `/agent/sessions/${agentSession}/turns`, { prompt: "Repurpose this clip with a new script" });
    const request = first.events.find((event) => event.event === "approval_request");
    assert.ok(request, JSON.stringify(first.events.map((event) => event.event)));
    const card = request.data.card as { changes: string[]; credits: number };
    assert.match(card.changes[0]!, /^Replace the voice: ".*" with (?:the voice .+|Test voice) · 1 credit$/);
    const res = await callSse(a, `/agent/sessions/${agentSession}/approvals`, {
      decisions: [{ tool_use_id: request.data.id, approved: true }],
    });
    assert.ok(res.events.some((event) => event.event === "project_changed"), JSON.stringify(res.events.map((event) => event.event)));
    const nodes = everything(await documentOf(a, clipId));
    const voice = nodes.find((node) => node.kind === "audio" && (node.marks as { voiceover?: unknown } | undefined)?.voiceover);
    assert.ok(voice, "giọng mới nằm trên clip");
    const generation = (await lastGeneration())!;
    assert.equal((voice!.src as { prompt: string }).prompt, generation.spec.prompt, "khai báo đúng spec đã trả tiền");
    assert.ok(nodes.filter((node) => node.kind === "video" && node.src === "assets/master.mp4").every((node) => node.muted === true), "tiếng gốc tắt");
    assert.ok(nodes.some((node) => node.kind === "captions" && (node.marks as { voiceover?: unknown } | undefined)?.voiceover), "phụ đề cho giọng mới");
  });

  await check("Assistant: người khác không chạy, không dừng, không undo được phiên của A", async () => {
    const turn = await callSse(b, `/agent/sessions/${agentSession}/turns`, { prompt: "Make it vertical" });
    assert.equal(turn.status, 404);
    assert.equal((await callApi(b, `/agent/sessions/${agentSession}/stop`, { method: "POST" })).status, 404);
    assert.equal((await callApi(b, `/agent/sessions/${agentSession}/turns/1/undo`, { method: "POST" })).status, 404);
    const stop = await callApi(a, `/agent/sessions/${agentSession}/stop`, { method: "POST" });
    assert.deepEqual(stop.body, { stopped: false, turn: null });
  });

  await check("New chat: phiên mới cho clip, lịch sử liệt kê phiên có lượt, mở lại phiên cũ bằng session_id", async () => {
    const fresh = await callApi(a, "/agent/sessions", { method: "POST", body: JSON.stringify({ clip_id: clipId, new: true }) });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    const freshId = (fresh.body as { id: string }).id;
    assert.notEqual(freshId, agentSession);
    const latest = await agentView();
    assert.equal(latest.session.id, freshId, "GET trả phiên mới nhất");
    assert.deepEqual(latest.sessions.map((item) => item.id), [agentSession], "phiên chưa có lượt không vào lịch sử");
    assert.equal(latest.sessions[0]!.title, "Make it vertical");
    assert.deepEqual(latest.models.map((model) => model.id), ["fake"]);
    const old = (await callApi(a, `/agent/sessions?clip_id=${clipId}&session_id=${agentSession}`)).body as AgentView;
    assert.equal(old.session.id, agentSession);
    const foreign = await callApi(b, `/agent/sessions?clip_id=${clipId}&session_id=${agentSession}`);
    assert.equal(foreign.status, 404);
  });

  // ------------------------------------------- Assistant ở trang project (P4)
  // Clip thứ hai CỐ Ý chưa có draft lẫn proxy: `apply_to_clips` phải báo nó lỗi
  // mà không làm hỏng clip kia, rồi Retry qua `/editor/ops` sau khi sửa xong.
  const { jobId: pJob, clipId: pClip, proxyPath: pProxy } = await seedProject(a.userId);
  const { data: clip2Row, error: clip2Error } = await admin
    .from("clips")
    .insert({ job_id: pJob, idx: 1, hook: "Second clip", start_seconds: 40, end_seconds: 60, source_start: 40, source_end: 60 })
    .select()
    .single();
  if (clip2Error || !clip2Row) throw new Error(`seed clip 2: ${clip2Error?.message}`);
  const clip2 = (clip2Row as { id: string }).id;
  // Document đã lưu dưới dạng chuỗi: đủ để so "có đổi không" và tìm một màu.
  const sourceOf = async (id: string) =>
    JSON.stringify(((await admin.from("editor_projects").select("document").eq("clip_id", id).maybeSingle()).data as { document: unknown } | null)?.document ?? null);
  const setStyle = async (id: string, color: string) => {
    const project = (await callApi(a, `/editor/project?clip_id=${id}`)).body as { version: number };
    const res = await callApi(a, "/editor/ops", {
      method: "POST",
      body: JSON.stringify({ clip_id: id, expected_version: project.version, ops: [{ op: "set_caption_style", preset: "classic", colors: [color] }] }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  };
  await admin.from("credit_ledger").insert({ user_id: a.userId, delta: 20, reason: "contract check grant p4" });
  await setStyle(pClip, "#FFFFFF");

  let projectSession = "";
  type ProjectView = {
    session: {
      scope: string;
      turns: {
        number: number;
        status: string;
        reply: string;
        can_undo: boolean;
        pending: { id: string; card?: { clips: unknown[]; changes: string[] } }[];
        actions: { name: string; summary: string; failed?: { clip_id: string }[]; ops?: unknown[] }[];
      }[];
    };
  };
  const projectView = async () => (await callApi(a, `/agent/sessions?job_id=${pJob}`)).body as ProjectView;

  await check("Assistant project: mở phiên theo job_id, người khác 404", async () => {
    const empty = await callApi(a, `/agent/sessions?job_id=${pJob}`);
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal((empty.body as { session: unknown }).session, null);
    const opened = await callApi(a, "/agent/sessions", { method: "POST", body: JSON.stringify({ job_id: pJob }) });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    projectSession = (opened.body as { id: string }).id;
    assert.notEqual(projectSession, agentSession, "phiên project tách khỏi phiên clip");
    assert.equal((opened.body as { scope: string }).scope, "project");
    assert.equal((await callApi(b, `/agent/sessions?job_id=${pJob}`)).status, 404);
    assert.equal((await callApi(b, "/agent/sessions", { method: "POST", body: JSON.stringify({ job_id: pJob }) })).status, 404);
  });

  await check("Assistant project: câu hỏi chỉ đọc, không thẻ duyệt, không ghi", async () => {
    const before = await sourceOf(pClip);
    const res = await callSse(a, `/agent/sessions/${projectSession}/turns`, { prompt: "Which clip has the strongest hook?" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(!res.events.some((event) => event.event === "approval_request"));
    assert.equal(res.events.at(-1)!.data.status, "done");
    assert.equal(await sourceOf(pClip), before);
  });

  let pendingId = "";
  await check("Assistant project: apply_to_clips dừng ở thẻ duyệt, chưa ghi gì", async () => {
    const before = await sourceOf(pClip);
    const res = await callSse(a, `/agent/sessions/${projectSession}/turns`, { prompt: "Use the same caption style on every clip" });
    const request = res.events.find((event) => event.event === "approval_request");
    assert.ok(request, JSON.stringify(res.events.map((event) => event.event)));
    const card = request.data.card as { clips: { id: string }[]; changes: string[] };
    assert.deepEqual(card.clips.map((clip) => clip.id).sort(), [pClip, clip2].sort());
    assert.ok(card.changes.length > 0 && card.changes.every((change) => typeof change === "string" && change.length > 0));
    assert.equal(res.events.at(-1)!.data.status, "awaiting_approval");
    pendingId = request.data.id as string;
    assert.equal(await sourceOf(pClip), before, "chưa duyệt thì chưa ghi");

    const view = await projectView();
    assert.equal(view.session.turns.at(-1)!.pending[0]!.card!.clips.length, 2, "thẻ còn sau khi tải lại");
    const busy = await callSse(a, `/agent/sessions/${projectSession}/turns`, { prompt: "again" });
    assert.equal(busy.status, 409);
    const foreign = await callSse(b, `/agent/sessions/${projectSession}/approvals`, { decisions: [{ tool_use_id: pendingId, approved: true }] });
    assert.equal(foreign.status, 404);
  });

  await check("Assistant project: Cancel không ghi, model được báo là bị từ chối", async () => {
    const before = await sourceOf(pClip);
    const res = await callSse(a, `/agent/sessions/${projectSession}/approvals`, { decisions: [{ tool_use_id: pendingId, approved: false }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.events.at(-1)!.data.status, "done");
    assert.equal(await sourceOf(pClip), before);
    const turn = (await projectView()).session.turns.at(-1)!;
    assert.match(turn.reply, /left the clips/);
    assert.equal(turn.can_undo, false, "lượt bị từ chối không có gì để undo");
  });

  let failedOps: unknown[] = [];
  let failTurn = 0;
  await check("Assistant project: Approve ghi clip tốt, liệt kê clip lỗi kèm op để Retry", async () => {
    const first = await callSse(a, `/agent/sessions/${projectSession}/turns`, { prompt: "Use the same caption style on every clip" });
    const id = first.events.find((event) => event.event === "approval_request")!.data.id as string;
    const res = await callSse(a, `/agent/sessions/${projectSession}/approvals`, { decisions: [{ tool_use_id: id, approved: true }] });
    assert.ok(res.events.some((event) => event.event === "project_changed"));
    assert.ok(res.events.some((event) => event.event === "tool_result" && event.data.summary === "Changed 1 of 2 clips"));
    assert.match(await sourceOf(pClip), /FFD400/i);
    const turn = (await projectView()).session.turns.at(-1)!;
    assert.match(turn.reply, /Updated 1 of 2 clips/);
    const action = turn.actions.find((item) => item.name === "apply_to_clips")!;
    assert.deepEqual(action.failed!.map((clip) => clip.clip_id), [clip2]);
    assert.ok(action.ops!.length > 0);
    failedOps = action.ops!;
    failTurn = turn.number;
    assert.equal(turn.can_undo, true);
  });

  // Sửa clip 2 như worker làm: settings gốc + proxy trong manifest.
  await admin
    .from("clips")
    .update({ settings: { source_start: 40, source_end: 60 }, settings_hash: "b".repeat(64) })
    .eq("id", clip2);
  const { data: jobRow } = await admin.from("jobs").select("media_manifest").eq("id", pJob).single();
  const manifest = (jobRow as { media_manifest: { proxies: Record<string, unknown> } }).media_manifest;
  await admin
    .from("jobs")
    .update({ media_manifest: { ...manifest, proxies: { ...manifest.proxies, [clip2]: { bucket: "sources", object: pProxy, width: 960, height: 540, duration: 22, offset: 39 } } } })
    .eq("id", pJob);

  await check("Assistant project: Retry clip lỗi = cùng op qua /editor/ops, không gọi model", async () => {
    const project = (await callApi(a, `/editor/project?clip_id=${clip2}`)).body as { version: number };
    const res = await callApi(a, "/editor/ops", {
      method: "POST",
      body: JSON.stringify({
        clip_id: clip2,
        expected_version: project.version,
        ops: failedOps,
        checkpoint: { kind: "manual", label: `Before retrying assistant request ${failTurn}` },
      }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(await sourceOf(clip2), /FFD400/i);
  });

  await check("Assistant project: Undo chỉ trả lại clip lượt đó đã đổi", async () => {
    const res = await callApi(a, `/agent/sessions/${projectSession}/turns/${failTurn}/undo`, { method: "POST" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((res.body as { clips: { clip_id: string; ok: boolean }[] }).clips, [{ clip_id: pClip, ok: true }]);
    assert.doesNotMatch(await sourceOf(pClip), /FFD400/i);
    assert.match(await sourceOf(clip2), /FFD400/i, "Retry là sửa tay của người dùng, không thuộc lượt");
  });

  await check("Assistant project: Undo một lượt đổi hai clip trả lại cả hai", async () => {
    await setStyle(clip2, "#00FF00");
    const first = await callSse(a, `/agent/sessions/${projectSession}/turns`, { prompt: "Use the same caption style on every clip" });
    const id = first.events.find((event) => event.event === "approval_request")!.data.id as string;
    const res = await callSse(a, `/agent/sessions/${projectSession}/approvals`, { decisions: [{ tool_use_id: id, approved: true }] });
    assert.ok(res.events.some((event) => event.event === "tool_result" && event.data.summary === "Changed 2 of 2 clips"));
    const turn = (await projectView()).session.turns.at(-1)!;
    const undo = await callApi(a, `/agent/sessions/${projectSession}/turns/${turn.number}/undo`, { method: "POST" });
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.doesNotMatch(await sourceOf(pClip), /FFD400/i);
    assert.match(await sourceOf(clip2), /00FF00/i);
    assert.doesNotMatch(await sourceOf(clip2), /FFD400/i);
    assert.equal((await callApi(b, `/agent/sessions/${projectSession}/turns/${turn.number}/undo`, { method: "POST" })).status, 404);
  });

  // ------------------------------------------------ Generate (AI Studio P5)
  // Server phải chạy với OPENCMO_AI_FAKE=1: model giả, không tốn tiền.
  await check("Generate: catalog JSON và bảng ai_models là một", async () => {
    const catalog = JSON.parse(
      readFileSync(join(process.cwd(), "..", "..", "packages", "contracts", "ai-models.json"), "utf8"),
    ) as { models: { id: string; kind: string; provider: string; name: string; price: unknown; limits: unknown }[] };
    const { data } = await admin.from("ai_models").select("id, kind, provider, name, price, limits").order("id");
    const rows = (data ?? []) as typeof catalog.models;
    const pick = (model: (typeof catalog.models)[number]) => ({
      id: model.id, kind: model.kind, provider: model.provider, name: model.name, price: model.price, limits: model.limits,
    });
    assert.deepEqual(rows.map(pick), [...catalog.models].sort((x, y) => x.id.localeCompare(y.id)).map(pick));
  });

  const genBody = (spec: Record<string, unknown>, model = "fake-image") => ({
    method: "POST",
    body: JSON.stringify({ job_id: jobId, clip_id: clipId, model, spec, request_id: crypto.randomUUID() }),
  });
  let generationId = "";
  await check("Generate: models chỉ liệt kê model bật được, giá đi kèm", async () => {
    const res = await callApi(a, "/generations/models");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const models = (res.body as { models: { id: string; price: { credits: number } }[] }).models;
    assert.ok(models.some((model) => model.id === "fake-image"), "chạy server với OPENCMO_AI_FAKE=1");
  });

  await check("Generate: spec sai, model lạ, project người khác bị chặn", async () => {
    const ratio = await callApi(a, "/generations", genBody({ prompt: "x", aspectRatio: "2:1" }));
    assert.equal(ratio.status, 422);
    assert.match(JSON.stringify(ratio.body), /does not support that aspect ratio/);
    const extra = await callApi(a, "/generations", genBody({ prompt: "x", aspectRatio: "1:1", duration: 3 }));
    assert.equal(extra.status, 422);
    const model = await callApi(a, "/generations", genBody({ prompt: "x", aspectRatio: "1:1" }, "gpt-image-9"));
    assert.equal(model.status, 422);
    assert.match(JSON.stringify(model.body), /This model is not available/);
    const foreign = await callApi(b, "/generations", genBody({ prompt: "x", aspectRatio: "1:1" }));
    assert.equal(foreign.status, 404);
  });

  await check("Generate: lời bị kiểm duyệt chặn → 422 tiếng Anh, không đặt credit, không có lượt sinh", async () => {
    const before = await balance(a.userId);
    const latest = await lastGeneration();
    const blocked = await callApi(a, "/generations", genBody({ prompt: `a scene [[flag]] ${crypto.randomUUID()}`, aspectRatio: "1:1" }));
    assert.equal(blocked.status, 422, JSON.stringify(blocked.body));
    assert.match(JSON.stringify(blocked.body), /goes against our content policy/);
    assert.equal(await balance(a.userId), before, "không đặt credit");
    assert.equal((await lastGeneration())?.id, latest?.id, "không tạo generation");
  });

  await check("Generate: tạo đặt trước credit, cùng spec thì dùng lại, người khác không đọc/huỷ được", async () => {
    const before = await balance(a.userId);
    const spec = { prompt: `  contract ${crypto.randomUUID()}  `, aspectRatio: "9:16", seed: 3 };
    const created = await callApi(a, "/generations", genBody(spec));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const first = created.body as { generation: { id: string; status: string; credits: number; spec: { prompt: string } }; reused: boolean };
    assert.equal(first.reused, false);
    assert.equal(first.generation.credits, 1);
    assert.equal(first.generation.spec.prompt, spec.prompt.trim(), "prompt được chuẩn hoá trước khi băm");
    generationId = first.generation.id;
    assert.equal(await balance(a.userId), before - 1);

    // Khác khoảng trắng đầu/cuối và thứ tự khoá: vẫn là cùng một spec.
    const again = await callApi(a, "/generations", genBody({ seed: 3, aspectRatio: "9:16", prompt: spec.prompt.trim() }));
    assert.deepEqual(
      [(again.body as typeof first).reused, (again.body as typeof first).generation.id],
      [true, generationId],
    );
    assert.equal(await balance(a.userId), before - 1, "không trừ lần hai");

    // Worker dev đang chạy có thể đã nhận task: queued hay running đều đúng ở đây.
    const { data: task } = await admin.from("tasks").select("kind, status").eq("payload->>generation_id", generationId).single();
    assert.equal((task as { kind: string }).kind, "generate");

    assert.equal((await callApi(b, `/generations/${generationId}`)).status, 404);
    assert.equal((await callApi(b, `/generations/${generationId}/cancel`, { method: "POST" })).status, 404);
    const read = (await callApi(a, `/generations/${generationId}`)).body as { status: string; asset: { url: string } | null };
    assert.ok(["queued", "running", "done"].includes(read.status), read.status);
    assert.equal(read.asset === null, read.status !== "done", "chỉ lượt xong mới có file");
  });

  await check("Generate: huỷ lúc worker đang chạy hoàn credit một lần, worker chốt muộn thì thua", async () => {
    // Lượt mới, rồi giả một worker đang giữ task NGAY: worker dev thật (nếu đang
    // chạy) không nhận được task `running`, nên kết quả không phụ thuộc ai nhanh hơn.
    const created = await callApi(a, "/generations", genBody({ prompt: `cancel ${crypto.randomUUID()}`, aspectRatio: "1:1" }));
    const id = (created.body as { generation: { id: string } }).generation.id;
    const attempt = crypto.randomUUID();
    const { data: held } = await admin
      .from("tasks")
      .update({ status: "running", attempt_id: attempt, lease_until: new Date(Date.now() + 300_000).toISOString() })
      .eq("payload->>generation_id", id)
      .eq("status", "queued")
      .select("id");
    assert.equal(held?.length, 1, "worker dev đã nhận task trước — chạy lại khi dừng worker");
    const taskId = (held as { id: string }[])[0]!.id;

    const before = await balance(a.userId);
    const cancelled = await callApi(a, `/generations/${id}/cancel`, { method: "POST" });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal((cancelled.body as { status: string }).status, "cancelled");
    await callApi(a, `/generations/${id}/cancel`, { method: "POST" });
    assert.equal(await balance(a.userId), before + 1, "hoàn đúng một lần");

    const { data: won } = await admin.rpc("complete_generation", {
      p_task_id: taskId, p_attempt_id: attempt,
      p_object_name: `${a.userId}/${jobId}/gen-${id}.png`, p_name: "late.png",
      p_duration: null, p_width: 1, p_height: 1, p_credits: 1,
    });
    assert.equal(won, false, "worker chốt sau khi bị huỷ phải thua (và tự xoá file)");
  });

  await check("Voiceover: mốc từng chữ của giọng đọc về tới trình duyệt qua GET generation", async () => {
    const created = await callApi(a, "/generations", genBody({ prompt: `hello brave world ${crypto.randomUUID().slice(0, 8)}`, voice: "Test B" }, "fake-voice"));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = (created.body as { generation: { id: string } }).generation.id;
    const attempt = crypto.randomUUID();
    const { data: held } = await admin
      .from("tasks")
      .update({ status: "running", attempt_id: attempt, lease_until: new Date(Date.now() + 300_000).toISOString() })
      .eq("payload->>generation_id", id)
      .eq("status", "queued")
      .select("id");
    assert.equal(held?.length, 1, "worker dev đã nhận task trước — chạy lại khi dừng worker");
    const words = [{ text: "hello", start: 0, end: 0.4 }, { text: "brave", start: 0.45, end: 0.8 }, { text: "world", start: 0.85, end: 1.3 }];
    // File phải có thật: GET ký link tải cho nó.
    const uploaded = await admin.storage.from("media").upload(`${a.userId}/${jobId}/gen-${id}.m4a`, new Blob([new Uint8Array(16)], { type: "audio/mp4" }));
    assert.equal(uploaded.error, null, uploaded.error?.message);
    const { data: won, error } = await admin.rpc("complete_generation", {
      p_task_id: (held as { id: string }[])[0]!.id, p_attempt_id: attempt,
      p_object_name: `${a.userId}/${jobId}/gen-${id}.m4a`, p_name: "hello.m4a",
      p_duration: 1.4, p_width: null, p_height: null, p_credits: 1, p_words: words,
    });
    assert.equal(won, true, error?.message);
    const read = (await callApi(a, `/generations/${id}`)).body as { status: string; asset: { duration: number; words: typeof words } | null };
    assert.equal(read.status, "done");
    assert.deepEqual(read.asset?.words, words);
    assert.equal(read.asset?.duration, 1.4);
    assert.equal((await callApi(b, `/generations/${id}`)).status, 404);
  });

  // ------------------------------------------------------- xoá B-roll
  await check("DELETE /projects/:id/media/:asset chỉ cho chủ file, và dọn Storage", async () => {
    const assetId = crypto.randomUUID();
    const path = `media/${a.userId}/${jobId}/${assetId}.mp4`;
    const inserted = await admin.from("media_assets").insert({
      id: assetId,
      user_id: a.userId,
      job_id: jobId,
      storage_path: path,
      name: "broll.mp4",
      status: "ready",
    });
    assert.equal(inserted.error, null);

    assert.equal(
      (await callApi(b, `/projects/${jobId}/media/${assetId}`, { method: "DELETE", headers: { origin: BASE } })).status,
      404,
    );
    const res = await callApi(a, `/projects/${jobId}/media/${assetId}`, {
      method: "DELETE",
      headers: { origin: BASE },
    });
    assert.equal(res.status, 200);
    const { count } = await admin
      .from("media_assets")
      .select("id", { count: "exact", head: true })
      .eq("id", assetId);
    assert.equal(count, 0);
    const { data: queued } = await admin.from("storage_deletions").select("path").like("path", `%${assetId}.mp4`);
    assert.equal(queued?.length, 1, "object phải vào hàng xoá Storage");
  });

  await check("clip không có nguồn sửa được trả 409, không phải 500", async () => {
    const bare = await seedProject(a.userId);
    await admin.from("jobs").update({ media_manifest: {} }).eq("id", bare.jobId);
    const res = await callApi(a, `/editor/project?clip_id=${bare.clipId}`);
    assert.equal(res.status, 409);
    assert.match((res.body as { detail: string }).detail, /no editable source/);
    await admin.from("jobs").delete().eq("id", bare.jobId);
    await admin.from("storage_deletions").delete().eq("job_id", bare.jobId);
    await admin.storage.from("clips").remove([bare.clipPath]);
    await admin.storage.from("sources").remove([bare.proxyPath]);
  });

  await check("nguồn ngoài allowlist bị từ chối ở POST /jobs", async () => {
    const res = await callApi(a, "/jobs", {
      method: "POST",
      body: JSON.stringify({ source: "http://169.254.169.254/", clips: 1 }),
    });
    assert.equal(res.status, 422);
  });

  await check("cắt clip từ editor: link không xác nhận chính chủ bị từ chối (G1-b)", async () => {
    const res = await callApi(a, "/editor/clipping", {
      method: "POST",
      body: JSON.stringify({ source: "https://youtu.be/not-confirmed", clips: 1 }),
    });
    assert.equal(res.status, 422);
    assert.match((res.body as { detail: string }).detail, /own video/);
    const list = await callApi(a, "/editor/clipping");
    assert.equal(list.status, 200);
    assert.ok(Array.isArray((list.body as { items: unknown[] }).items));
  });

  await check("tài khoản free: banner có hạn; quá 30 ngày thì cron xoá user + file", async () => {
    const c = await signIn("retention");
    const res = await callApi(c, "/account/retention");
    assert.equal(res.status, 200);
    const body = res.body as { paid: boolean; delete_after: string };
    assert.equal(body.paid, false);
    assert.ok(Date.parse(body.delete_after) > Date.now() + 29 * 86_400_000, "hạn ~30 ngày sau đăng ký");

    const file = `${c.userId}/retention/a.png`;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const { error: uploadError } = await admin.storage.from("media").upload(file, png, { contentType: "image/png" });
    assert.ifError(uploadError);
    const { error: backdate } = await admin.from("profiles").update({ retention_from: new Date(Date.now() - 31 * 86_400_000).toISOString() }).eq("id", c.userId);
    assert.ifError(backdate);

    const cron = await fetch(`${BASE}/api/cron/cleanup`, {
      headers: process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {},
    });
    assert.equal(cron.status, 200, "cron cần CRON_SECRET giống server");
    assert.ok(((await cron.json()) as { accounts: number }).accounts >= 1);
    const { data: gone } = await admin.auth.admin.getUserById(c.userId);
    assert.equal(gone.user ?? null, null, "user đã bị xoá");
    const { data: left } = await admin.storage.from("media").list(`${c.userId}/retention`);
    assert.equal((left ?? []).length, 0, "file đã bị xoá");

    // User còn trong hạn (a) không bị đụng.
    const { data: still } = await admin.auth.admin.getUserById(a.userId);
    assert.ok(still.user, "user a còn nguyên");
  });

  // Dọn: Auth cascade xử lý database; Storage object phải xoá riêng.
  await admin.storage.from("clips").remove([clipPath]);
  await admin.storage.from("sources").remove([proxyPath]);
  await admin.auth.admin.deleteUser(a.userId);
  await admin.auth.admin.deleteUser(b.userId);

  if (failures.length > 0) {
    console.error(`${failures.length} kiểm tra hỏng:`);
    for (const line of failures) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log("hợp đồng /api/v1 trên stack thật: mọi kiểm tra xanh");
}

void main();
