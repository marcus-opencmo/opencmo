-- OpenCMO — schema khởi tạo.
--
-- Ghi chú thiết kế: credits là sổ cái append-only (credit_ledger), số dư là
-- tổng cộng dồn. Không bao giờ UPDATE trực tiếp một cột balance — làm vậy sẽ
-- mất dấu vết khi cần đối soát hoặc hoàn tiền cho job lỗi.

-- Dùng `gen_random_uuid()` của Postgres lõi (pg_catalog, có sẵn từ PG13) chứ
-- KHÔNG phải `uuid_generate_v4()` của uuid-ossp. Trên Supabase, extension được
-- cài vào schema `extensions`, không nằm trên search_path lúc chạy migration —
-- nên `uuid_generate_v4()` báo "function does not exist" dù extension đã có.
-- Hàm lõi không có vấn đề đó và không cần extension nào cả.

-- ---------------------------------------------------------------- profiles

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  plan        text not null default 'free',
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "đọc hồ sơ của chính mình"
  on public.profiles for select using (auth.uid() = id);

create policy "sửa hồ sơ của chính mình"
  on public.profiles for update using (auth.uid() = id);

-- ------------------------------------------------------------------- jobs

create type public.job_status as enum ('queued', 'running', 'done', 'failed');

create table public.jobs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  source_url        text not null,
  title             text,
  duration_seconds  numeric,
  status            public.job_status not null default 'queued',
  clips_requested   int not null default 5,
  error             text,
  -- Đầu ra tự xóa sau 14 ngày: giữ storage trong mức miễn phí, và không lưu
  -- bản sao video của người khác vô thời hạn. Xem ARCHITECTURE.md §7.
  expires_at        timestamptz not null default now() + interval '14 days',
  created_at        timestamptz not null default now(),
  finished_at       timestamptz
);

create index jobs_user_created_idx on public.jobs (user_id, created_at desc);
create index jobs_expiry_idx on public.jobs (expires_at) where status = 'done';

alter table public.jobs enable row level security;

create policy "đọc job của chính mình"
  on public.jobs for select using (auth.uid() = user_id);

create policy "tạo job cho chính mình"
  on public.jobs for insert with check (auth.uid() = user_id);

-- ------------------------------------------------------------------ clips

create table public.clips (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.jobs(id) on delete cascade,
  idx             int not null,
  hook            text,
  start_seconds   numeric not null,
  end_seconds     numeric not null,
  score           numeric,
  reason          text,
  storage_path    text,
  preview_path    text,
  created_at      timestamptz not null default now(),
  unique (job_id, idx)
);

alter table public.clips enable row level security;

-- Đây là điểm mạnh thật của Supabase: "chỉ chủ sở hữu đọc được clip của mình"
-- là một policy SQL, không phải code ứng dụng có thể viết sai.
create policy "đọc clip thuộc job của mình"
  on public.clips for select
  using (exists (
    select 1 from public.jobs j
    where j.id = clips.job_id and j.user_id = auth.uid()
  ));

-- ---------------------------------------------------------- credit ledger

create table public.credit_ledger (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- Dương = nạp vào (mua, quà tặng, hoàn tiền). Âm = tiêu (một job).
  delta       int not null,
  reason      text not null,
  job_id      uuid references public.jobs(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index credit_ledger_user_idx on public.credit_ledger (user_id, created_at desc);

alter table public.credit_ledger enable row level security;

create policy "đọc sổ cái của chính mình"
  on public.credit_ledger for select using (auth.uid() = user_id);

-- 1 credit = 1 phút video nguồn. Đây là chuẩn của ngành vì chi phí thật tỉ lệ
-- với phút video. Xem VISION.md §4.
create or replace function public.credit_balance(p_user_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(delta), 0)::int
  from public.credit_ledger
  where user_id = p_user_id;
$$;

-- --------------------------------------------------------------- storage

insert into storage.buckets (id, name, public)
values ('clips', 'clips', false)
on conflict (id) do nothing;

-- Đây là lý do chính để giữ storage ở Supabase thay vì đẩy sang R2: quyền truy
-- cập file là một POLICY, không phải logic ứng dụng ta tự viết. File nằm ở
-- <user_id>/<job_id>/<tên file> nên chỉ cần so segment đầu với uid đang đăng nhập.
create policy "đọc file trong thư mục của mình"
  on storage.objects for select
  using (bucket_id = 'clips' and (storage.foldername(name))[1] = auth.uid()::text);

-- ----------------------------------------------------------- hàng đợi job
--
-- Không dùng dịch vụ hàng đợi riêng (Inngest, BullMQ...). Bảng `jobs` với cột
-- `status` đã đủ làm hàng đợi cho quy mô này: worker lấy job cũ nhất ở trạng
-- thái 'queued', khóa nó lại, chạy, rồi cập nhật. Bớt một nhà cung cấp.
--
-- `for update skip locked` là mấu chốt: nhiều worker chạy song song vẫn không
-- bao giờ nhận trùng một job.
create index jobs_queue_idx on public.jobs (created_at) where status = 'queued';

create or replace function public.claim_next_job()
returns public.jobs
language sql
volatile
security definer
set search_path = public
as $$
  update public.jobs
  set status = 'running'
  where id = (
    select id from public.jobs
    where status = 'queued'
    order by created_at
    for update skip locked
    limit 1
  )
  returning *;
$$;
