-- OpenCMO — credit, watermark, thanh toán, và realtime.
--
-- Ba quyết định trong file này, ghi lại vì chúng khó suy ngược từ code:
--
-- 1. Trừ credit và tạo job phải NẰM TRONG MỘT GIAO DỊCH. Tách ra hai lượt gọi
--    từ app thì có cửa sổ để tạo job mà không trừ tiền (hoặc ngược lại). Vì vậy
--    app KHÔNG insert thẳng vào `jobs` nữa — nó gọi `create_job()`.
--
-- 2. Giá thật tính theo PHÚT NGUỒN, nhưng lúc bấm nút chưa ai biết video dài bao
--    nhiêu — muốn biết phải probe, mà probe là việc của worker. Nên tiền đi hai
--    nhịp: giữ tạm `JOB_HOLD_CREDITS` lúc tạo, rồi worker probe xong gọi
--    `settle_job_credits()` để cộng/trừ phần chênh. Sổ cái append-only nên cả
--    hai nhịp đều là dòng mới, đối soát được.
--
-- 3. Hoàn tiền tính bằng TỔNG các dòng của job đó, không phải một con số truyền
--    vào. Job lỗi ở nhịp nào thì hoàn đúng phần đã trừ tới nhịp đó.

-- ------------------------------------------------------------- hằng số giá

-- Giữ tạm khi tạo job, quy ra 10 phút video. Video ngắn hơn được trả lại ngay
-- sau bước probe; dài hơn thì trừ thêm — nếu không đủ số dư, job dừng ở đó và
-- được hoàn đủ, thay vì chạy xong rồi mới báo thiếu tiền.
create or replace function public.job_hold_credits()
returns int language sql immutable as $$ select 10 $$;

-- Quà đăng ký. Đủ ba video 10 phút — vừa đủ để thấy sản phẩm chạy thật, chưa
-- đủ để dùng miễn phí mãi. Xem VISION.md §4: bản free là vòng lặp tăng trưởng.
create or replace function public.signup_credits()
returns int language sql immutable as $$ select 30 $$;

-- ------------------------------------------------------------------- profiles

-- Polar là merchant of record; ta chỉ giữ lại id khách để đối chiếu webhook.
alter table public.profiles add column if not exists polar_customer_id text;

create index if not exists profiles_polar_customer_idx
  on public.profiles (polar_customer_id) where polar_customer_id is not null;

-- Hồ sơ phải tồn tại ngay khi đăng ký: mọi truy vấn sau đó (số dư, plan,
-- watermark) đều đọc từ đây. Tạo trong trigger chứ không trong app — app có thể
-- crash giữa chừng, trigger thì không.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;

  insert into public.credit_ledger (user_id, delta, reason)
  values (new.id, public.signup_credits(), 'Sign-up bonus');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------- jobs

-- Bản free có watermark. Cột nằm ở `jobs` chứ không đọc `profiles.plan` lúc
-- render: người dùng nâng cấp giữa chừng thì job đang chạy vẫn giữ nguyên điều
-- kiện lúc bấm nút, và ta luôn giải thích được vì sao một clip cũ có watermark.
alter table public.jobs add column if not exists watermark boolean not null default true;

-- App không còn insert thẳng — mọi đường vào đi qua create_job().
drop policy if exists "tạo job cho chính mình" on public.jobs;

-- Cột trạng thái đổi liên tục trong lúc job chạy; UI theo dõi bằng Realtime thay
-- vì hỏi lại server mỗi vài giây.
alter publication supabase_realtime add table public.jobs;
alter publication supabase_realtime add table public.clips;

-- --------------------------------------------------------------- credit RPC

-- Chống cộng trùng khi Polar gửi lại cùng một webhook (họ có retry).
alter table public.credit_ledger add column if not exists external_id text;

create unique index if not exists credit_ledger_external_idx
  on public.credit_ledger (external_id) where external_id is not null;

create or replace function public.job_credits_spent(p_job_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(-sum(delta), 0)::int
  from public.credit_ledger
  where job_id = p_job_id;
$$;

-- Tạo job + trừ credit trong một giao dịch. Trả về job vừa tạo.
--
-- `security definer` để hàm ghi được vào credit_ledger (bảng đó không có policy
-- insert cho người dùng — sổ cái không phải chỗ ai cũng viết vào được). Quyền
-- vẫn chặt: hàm chỉ làm việc cho `auth.uid()`, không nhận user_id từ tham số.
create or replace function public.create_job(
  p_source_url text,
  p_clips int default 5
)
returns public.jobs
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_hold int := public.job_hold_credits();
  v_balance int;
  v_plan text;
  v_job public.jobs;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;

  if p_source_url is null or length(trim(p_source_url)) = 0 then
    raise exception 'Missing video link.' using errcode = '22023';
  end if;

  if p_clips < 1 or p_clips > 10 then
    raise exception 'Clip count must be between 1 and 10.' using errcode = '22023';
  end if;

  -- Khoá hàng của người dùng này để hai tab bấm cùng lúc không tiêu quá số dư.
  perform 1 from public.profiles where id = v_user for update;

  select coalesce(sum(delta), 0)::int into v_balance
  from public.credit_ledger where user_id = v_user;

  if v_balance < v_hold then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_hold, v_balance using errcode = 'P0001';
  end if;

  select plan into v_plan from public.profiles where id = v_user;

  insert into public.jobs (user_id, source_url, clips_requested, watermark)
  values (v_user, trim(p_source_url), p_clips, coalesce(v_plan, 'free') = 'free')
  returning * into v_job;

  insert into public.credit_ledger (user_id, delta, reason, job_id)
  values (v_user, -v_hold, 'Hold for new job', v_job.id);

  return v_job;
end;
$$;

-- Worker gọi sau bước probe, khi đã biết độ dài thật.
--
-- Trả về `true` nếu job được phép chạy tiếp. `false` nghĩa là video dài hơn số
-- dư — khi đó phần giữ tạm đã được hoàn và worker phải dừng job lại. Thà dừng ở
-- đây còn hơn render xong 5 clip rồi mới phát hiện không thu được tiền.
create or replace function public.settle_job_credits(
  p_job_id uuid,
  p_duration_seconds numeric
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_spent int;
  v_actual int;
  v_diff int;
  v_balance int;
begin
  select user_id into v_user from public.jobs where id = p_job_id;
  if v_user is null then
    raise exception 'No such job: %', p_job_id;
  end if;

  -- 1 credit = 1 phút nguồn, làm tròn lên. Video 30 giây vẫn tính 1 phút.
  v_actual := greatest(1, ceil(coalesce(p_duration_seconds, 0) / 60.0)::int);
  v_spent := public.job_credits_spent(p_job_id);
  v_diff := v_actual - v_spent;

  if v_diff = 0 then
    return true;
  end if;

  if v_diff > 0 then
    select coalesce(sum(delta), 0)::int into v_balance
    from public.credit_ledger where user_id = v_user;

    if v_balance < v_diff then
      -- Không đủ tiền cho phần chênh: trả lại phần đã giữ, job sẽ thành failed.
      insert into public.credit_ledger (user_id, delta, reason, job_id)
      values (v_user, v_spent, 'Refund: not enough credits for the real length', p_job_id);
      return false;
    end if;
  end if;

  insert into public.credit_ledger (user_id, delta, reason, job_id)
  values (v_user, -v_diff, 'Adjusted to real video length', p_job_id);

  return true;
end;
$$;

-- Hoàn đúng phần đã trừ cho job này, dù job lỗi ở nhịp nào.
-- Gọi nhiều lần cũng chỉ hoàn một lần: sau lần đầu tổng đã về 0.
create or replace function public.refund_job(p_job_id uuid, p_reason text default 'Refund: job failed')
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_spent int;
begin
  select user_id into v_user from public.jobs where id = p_job_id;
  if v_user is null then
    return 0;
  end if;

  v_spent := public.job_credits_spent(p_job_id);
  if v_spent <= 0 then
    return 0;
  end if;

  insert into public.credit_ledger (user_id, delta, reason, job_id)
  values (v_user, v_spent, p_reason, p_job_id);

  return v_spent;
end;
$$;

-- ------------------------------------------------------------------ dọn dẹp

-- Cron gọi hàng ngày. Chỉ xoá ROW; file trong bucket do route cron xoá trước đó
-- (storage không xoá được từ SQL). Trả về đường dẫn để route biết cần xoá gì.
create or replace function public.expired_clip_paths()
returns table (job_id uuid, storage_path text, preview_path text)
language sql
stable
security definer
set search_path = public
as $$
  select c.job_id, c.storage_path, c.preview_path
  from public.clips c
  join public.jobs j on j.id = c.job_id
  where j.expires_at < now();
$$;
