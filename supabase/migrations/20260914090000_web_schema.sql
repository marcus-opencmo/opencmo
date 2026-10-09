-- OpenCMO — mô hình dữ liệu của editor trên web.
--
-- Bối cảnh: trước 14/09 toàn bộ editor chỉ sống trong SQLite của bản local
-- (`packages/engine/opencmo/local_store.py`, schema v1–v5). File này chuyển đúng
-- mô hình đó sang Postgres: project (jobs), artifact AI, clip, revision bất
-- biến, draft, preset, B-roll, và một hàng đợi task chung cho preview/export.
--
-- Ba điều khác bản local, ghi lại vì chúng là lý do file này không phải một bản
-- chép nguyên:
--
-- 1. `exports` của bản local bị gộp vào `tasks`. Local có hai hàng đợi (jobs cho
--    AI, exports cho render); trên web mọi việc chạy nền đều là một task có
--    lease + attempt, nên một bảng là đủ và reconciler chỉ phải biết một chỗ.
-- 2. Mọi bảng đều có đường truy ngược tới `auth.users` — hoặc cột `user_id`
--    trực tiếp, hoặc qua `clips -> jobs`. RLS ở migration sau dựa vào đúng hai
--    hình dạng này, không có hình thứ ba.
-- 3. `settings_hash` lưu kèm revision thay vì tính lại khi cần: nó là khoá khử
--    trùng preview, mà hàm băm nằm ở Python/TypeScript chứ không ở SQL.

-- ------------------------------------------------------------------- jobs
--
-- `jobs` đóng vai PROJECT, giống bản local: id job cũ chính là id project nên
-- deep link cũ vẫn mở được.

alter table public.jobs
  -- Tên người dùng đặt nằm riêng khỏi `title`: worker ghi `title` từ probe mỗi
  -- lần chạy lại và không được đè mất tên đã đổi (bài học của local v4).
  add column if not exists name text,
  add column if not exists stage text not null default 'queued',
  add column if not exists progress jsonb,
  add column if not exists pinned boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'jobs_name_length_check'
  ) then
    alter table public.jobs
      add constraint jobs_name_length_check check (char_length(name) <= 120);
  end if;
end;
$$;

-- Người dùng huỷ được job đang chạy. `alter type ... add value` được phép trong
-- transaction từ PG12, nhưng giá trị mới KHÔNG dùng được trong chính transaction
-- đó — nên `cancel_job()` nằm ở migration RPC sau, không nằm ở đây.
do $$
begin
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'job_status' and e.enumlabel = 'cancelled'
  ) then
    alter type public.job_status add value 'cancelled';
  end if;
end;
$$;

-- Phân trang keyset: `(created_at, id) < (cursor)` quét thẳng theo index, không
-- OFFSET. Index cũ `(user_id, created_at desc)` không đủ vì thiếu `id` để phá
-- hoà khi hai job trùng mốc thời gian.
create index if not exists jobs_user_keyset_idx
  on public.jobs (user_id, created_at desc, id desc);

-- -------------------------------------------------------------- artifacts
--
-- Đầu ra AI của một lần chạy: transcript, danh sách khoảnh khắc, cấu hình
-- render, vết bám mặt. Bất biến theo `version` để chạy lại không ghi đè bản cũ —
-- revision của người dùng trỏ vào mốc thời gian NGUỒN nên vẫn đúng chỗ.
create table if not exists public.artifacts (
  job_id      uuid not null references public.jobs(id) on delete cascade,
  kind        text not null check (kind in ('source', 'transcript', 'moments', 'render_settings', 'face_track')),
  version     int not null default 1,
  -- Transcript của video 45 phút cỡ 300–800 KB. Trần 8 MB chặn việc ai đó nhét
  -- cả một file nhị phân vào jsonb; tuple lớn hơn thế là dấu hiệu hỏng logic.
  data        jsonb not null check (pg_column_size(data) < 8000000),
  created_at  timestamptz not null default now(),
  primary key (job_id, kind, version)
);

-- ------------------------------------------------------------------ clips
--
-- Mốc thời gian nguồn nằm riêng khỏi `start_seconds/end_seconds`: hai cột cũ là
-- kết quả AI chọn và không đổi, hai cột mới là phạm vi người dùng đang sửa.
alter table public.clips
  add column if not exists source_start numeric,
  add column if not exists source_end numeric;

update public.clips
set source_start = coalesce(source_start, start_seconds),
    source_end = coalesce(source_end, end_seconds)
where source_start is null or source_end is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clips_source_range_check'
  ) then
    alter table public.clips
      add constraint clips_source_range_check check (source_end > source_start);
  end if;
end;
$$;

-- --------------------------------------------------------- clip_revisions
--
-- Lịch sử sửa của một clip. BẤT BIẾN: export đã xếp hàng trỏ vào một revision,
-- sửa nó là đổi nội dung file mà người dùng tưởng mình đã chốt.
create table if not exists public.clip_revisions (
  id            uuid primary key default gen_random_uuid(),
  clip_id       uuid not null references public.clips(id) on delete cascade,
  number        int not null,
  -- 64 KB đủ cho 2000 caption edit; lớn hơn nghĩa là client gửi rác.
  settings      jsonb not null check (pg_column_size(settings) < 65536),
  -- sha256 hex. Sinh ở Python/TypeScript theo JSON chuẩn hoá (RFC 8785) —
  -- SQL chỉ kiểm hình dạng, không tính lại.
  settings_hash text not null check (settings_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  unique (clip_id, number)
);

create or replace function public.freeze_clip_revision()
returns trigger
language plpgsql
as $$
begin
  -- Tiếng Anh: message của trigger đi thẳng qua PostgREST ra màn hình.
  raise exception 'Revisions cannot be changed.' using errcode = 'P0001';
end;
$$;

drop trigger if exists clip_revisions_immutable on public.clip_revisions;
create trigger clip_revisions_immutable
  before update on public.clip_revisions
  for each row execute function public.freeze_clip_revision();

-- Trang editor luôn hỏi "revision mới nhất của clip này", nên desc.
create index if not exists clip_revisions_clip_number_idx
  on public.clip_revisions (clip_id, number desc);

-- ------------------------------------------------------------ clip_drafts
--
-- Con trỏ "clip này đang ở revision nào". Một hàng mỗi clip; đổi draft là đổi
-- con trỏ chứ không sửa revision.
create table if not exists public.clip_drafts (
  clip_id     uuid primary key references public.clips(id) on delete cascade,
  revision_id uuid not null references public.clip_revisions(id),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- presets
--
-- Phần style dùng lại được giữa các clip (không có mốc thời gian).
create table if not exists public.presets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  settings    jsonb not null check (pg_column_size(settings) < 16384),
  created_at  timestamptz not null default now()
);

-- Trùng tên không phân biệt hoa thường, giống `COLLATE NOCASE` của bản local.
create unique index if not exists presets_user_name_idx
  on public.presets (user_id, lower(name));

create index if not exists presets_user_created_idx
  on public.presets (user_id, created_at desc);

-- ----------------------------------------------------------- media_assets
--
-- B-roll người dùng tải lên. `status` bắt đầu ở 'pending' vì kích thước thật và
-- độ dài chỉ biết được sau khi worker probe — trước đó timeline chưa đặt được
-- đoạn này vào đâu.
create table if not exists public.media_assets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  job_id        uuid not null references public.jobs(id) on delete cascade,
  storage_path  text not null unique,
  name          text not null,
  duration      numeric,
  width         int,
  height        int,
  status        text not null default 'pending' check (status in ('pending', 'ready', 'rejected')),
  error         text,
  created_at    timestamptz not null default now()
);

create index if not exists media_assets_job_created_idx
  on public.media_assets (job_id, created_at);

-- Policy select của bảng này so `user_id`; không có index thì mỗi lần đọc là
-- một seq scan khi dữ liệu lớn dần.
create index if not exists media_assets_user_idx
  on public.media_assets (user_id, created_at desc);

-- ------------------------------------------------------------------ tasks
--
-- Hàng đợi việc chạy nền của editor. Dùng lại đúng mẫu lease + attempt của
-- `20260913120000_worker_lifecycle.sql` cho `jobs`: worker chết giữa chừng thì
-- lease hết hạn và reconciler nhặt lại, không cần ai bấm nút.
create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  kind          text not null check (kind in ('preview', 'export', 'probe_media', 'zip')),
  clip_id       uuid references public.clips(id) on delete cascade,
  revision_id   uuid references public.clip_revisions(id),
  settings_hash text,
  asset_id      uuid references public.media_assets(id) on delete cascade,
  job_id        uuid references public.jobs(id) on delete cascade,
  payload       jsonb,
  status        text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  attempt       int not null default 0,
  attempt_id    uuid,
  lease_until   timestamptz,
  heartbeat_at  timestamptz,
  output_path   text,
  output        jsonb,
  bytes         bigint,
  width         int,
  height        int,
  duration      numeric,
  error         text,
  -- Do client đặt. Bấm hai lần hoặc mạng gửi lại vẫn chỉ ra một task.
  request_id    uuid not null unique,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

-- Claim chỉ quét hàng đang chờ, không quét cả bảng lịch sử.
create index if not exists tasks_queue_idx
  on public.tasks (created_at) where status = 'queued';

-- Reconciler tìm lease hết hạn.
create index if not exists tasks_lease_idx
  on public.tasks (lease_until) where status = 'running';

-- Cùng clip + cùng nội dung settings thì chỉ render preview MỘT lần. Đây là lý
-- do `settings_hash` phải giống hệt nhau giữa Python và TypeScript.
create unique index if not exists tasks_preview_dedupe_idx
  on public.tasks (clip_id, settings_hash)
  where kind = 'preview' and status in ('queued', 'running', 'done');

-- Một export sống cho mỗi revision (tương đương `exports_active_idx` của bản
-- local). Export `failed` rơi ra ngoài index nên thử lại được.
create unique index if not exists tasks_export_active_idx
  on public.tasks (clip_id, revision_id)
  where kind = 'export' and status in ('queued', 'running', 'done');

-- Policy select so `user_id`; UI liệt kê task mới nhất trước.
create index if not exists tasks_user_created_idx
  on public.tasks (user_id, created_at desc);

-- ------------------------------------------------------------ rate_limits
--
-- Đếm theo cửa sổ cố định, một hàng mỗi (người dùng, bucket, cửa sổ). Không
-- Redis: thêm một nhà cung cấp chỉ để đếm số nguyên là không đáng (COSTS.md).
create table if not exists public.rate_limits (
  user_id       uuid not null,
  bucket        text not null,
  window_start  timestamptz not null,
  count         int not null,
  primary key (user_id, bucket, window_start)
);

-- --------------------------------------------------------------- realtime
--
-- Tiến trình preview/export và kết quả probe B-roll đổi trong lúc người dùng
-- đang nhìn. Payload chỉ để kích UI đọc lại dưới RLS, không phải nguồn sự thật.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table public.tasks;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'media_assets'
  ) then
    alter publication supabase_realtime add table public.media_assets;
  end if;
end;
$$;
