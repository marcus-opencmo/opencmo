-- Tầng CMO đợt 3c (docs/cmo/san-pham.md §4.3 W5): gói video từ video CỦA CHÍNH
-- người dùng → clip dọc có phụ đề + caption từng nền tảng → thẻ ở Approvals.
-- Không có đường đăng tự động: người dùng tải về và tự đăng (như W3).
--
-- Luật sản phẩm 3: link (không phải file tải lên) phải được người dùng xác nhận
-- là video của họ, và xác nhận đó được ghi CÙNG giao dịch với job.

begin;

-- ------------------------------------------------------------ việc video_pack
alter table public.cmo_runs drop constraint if exists cmo_runs_kind_check;
alter table public.cmo_runs add constraint cmo_runs_kind_check
  check (kind in ('onboard', 'plan_week', 'post_draft', 'sales_scan', 'video_pack'));

-- Lượt phải chờ việc khác (job clip trên worker) thì hoãn tới mốc này thay vì
-- xoay vòng claim/thả trong cùng một lượt chạy hàng đợi.
alter table public.cmo_runs add column if not exists not_before timestamptz;

-- Cắt clip đã tính credit ở `create_job` (theo phút video); việc của CMO ở đây
-- chỉ là viết caption năm nền tảng — 1 credit như soạn một bài.
create or replace function public.cmo_job_price(p_kind text)
returns integer language sql immutable as $$
  select case p_kind when 'plan_week' then 1 when 'post_draft' then 1 when 'sales_scan' then 5 when 'video_pack' then 1 else 0 end
$$;
create or replace function public.cmo_job_daily_limit(p_kind text)
returns integer language sql immutable as $$
  select case p_kind when 'plan_week' then 5 when 'post_draft' then 10 when 'sales_scan' then 3 when 'video_pack' then 3 else 0 end
$$;

create or replace function public.cmo_enqueue(p_user uuid, p_kind text, p_input jsonb)
returns public.cmo_runs language plpgsql volatile security definer set search_path = public
as $$
declare
  v_row public.cmo_runs;
  v_price integer := public.cmo_job_price(p_kind);
begin
  if p_kind is null or p_kind not in ('plan_week', 'post_draft', 'sales_scan', 'video_pack') then
    raise exception 'Unknown task.' using errcode = '22023';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' or octet_length(p_input::text) > 4096 then
    raise exception 'This request is not valid.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':cmo_run', 1713));

  select * into v_row from public.cmo_runs
  where user_id = p_user and kind = p_kind and status in ('queued', 'running')
    and (status = 'queued' or lease_until is null or lease_until > now())
  order by created_at desc limit 1;
  if found then
    return v_row;
  end if;

  if (select count(*) from public.cmo_runs
      where user_id = p_user and kind = p_kind and created_at > now() - interval '1 day') >= public.cmo_job_daily_limit(p_kind) then
    raise exception 'You have reached today''s limit for this task. Try again tomorrow.' using errcode = 'P0001';
  end if;
  if v_price > 0 and public.credit_balance(p_user) < v_price then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_price, public.credit_balance(p_user) using errcode = 'P0001';
  end if;

  insert into public.cmo_runs (user_id, kind, status, input, credits)
  values (p_user, p_kind, 'queued', p_input, v_price) returning * into v_row;
  if v_price > 0 then
    insert into public.credit_ledger (user_id, delta, reason) values (p_user, -v_price, 'CMO hold');
  end if;
  return v_row;
end;
$$;

-- Như bản đợt 1, thêm: bỏ qua lượt còn hoãn (`not_before` ở tương lai).
create or replace function public.claim_cmo_run(p_run_id uuid default null, p_lease_seconds integer default 300)
returns public.cmo_runs language plpgsql volatile security definer set search_path = public
as $$
declare
  v_row public.cmo_runs;
  v_dead public.cmo_runs;
begin
  for v_dead in
    update public.cmo_runs set status = 'failed', error = 'This task stopped too many times.', finished_at = now(), lease_until = null
    where status = 'running' and kind <> 'onboard' and lease_until < now() and attempt >= 3
    returning *
  loop
    perform public.cmo_refund_run(v_dead);
  end loop;
  update public.cmo_runs set status = 'queued', lease_until = null
  where status = 'running' and kind <> 'onboard' and lease_until < now() and attempt < 3;

  select * into v_row from public.cmo_runs
  where status = 'queued' and (p_run_id is null or id = p_run_id)
    and (not_before is null or not_before <= now())
  order by created_at
  for update skip locked
  limit 1;
  if not found then
    return null;
  end if;

  update public.cmo_runs
  set status = 'running', attempt = attempt + 1, started_at = coalesce(started_at, now()),
      lease_until = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 900)))
  where id = v_row.id
  returning * into v_row;
  return v_row;
end;
$$;

-- Lượt chưa làm tiếp được (clip còn đang cắt): trả về hàng đợi, hoãn tới
-- `now + p_seconds`. Lần thử này không tính vào trần 3 lần (chờ không phải hỏng).
create or replace function public.cmo_defer_run(p_run uuid, p_attempt integer, p_seconds integer, p_steps jsonb default null)
returns boolean language plpgsql volatile security definer set search_path = public
as $$
begin
  update public.cmo_runs
  set status = 'queued', lease_until = null, attempt = greatest(0, attempt - 1),
      not_before = now() + make_interval(secs => greatest(5, least(p_seconds, 3600))),
      steps = coalesce(p_steps, steps)
  where id = p_run and attempt = p_attempt and status = 'running';
  return found;
end;
$$;

-- ------------------------------------------------------------ chính chủ video
create table public.video_ownership (
  job_id uuid primary key references public.jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('upload', 'link')),
  url text check (url is null or char_length(url) <= 2000),
  confirmed_at timestamptz not null default now()
);
alter table public.video_ownership enable row level security;
create policy "đọc xác nhận của mình" on public.video_ownership
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.video_ownership from anon, authenticated;

-- ------------------------------------------------------------ gói video
create table public.video_packs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid references public.cmo_runs(id) on delete set null,
  job_id uuid not null references public.jobs(id) on delete cascade,
  -- [{clip_id, hook, seconds, score}]
  clips jsonb not null check (jsonb_typeof(clips) = 'array' and jsonb_array_length(clips) between 1 and 10 and octet_length(clips::text) <= 16384),
  -- {tiktok, reels, shorts, facebook, threads} → chữ từng nền tảng (theo clip)
  captions jsonb not null check (jsonb_typeof(captions) = 'object' and octet_length(captions::text) <= 65536),
  status text not null default 'in_review' check (status in ('in_review', 'approved', 'dismissed')),
  -- [{clip_id, task_id}] — bản export dựng lúc duyệt
  exports jsonb not null default '[]'::jsonb check (jsonb_typeof(exports) = 'array' and octet_length(exports::text) <= 8192),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id)
);
create index video_packs_user_idx on public.video_packs (user_id, status, created_at desc);
alter table public.video_packs enable row level security;
create policy "đọc gói video của mình" on public.video_packs
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.video_packs from anon, authenticated;

-- Người dùng bấm "New video pack": tạo job clip + ghi xác nhận chính chủ + thả
-- W5 vào hàng đợi, MỘT giao dịch. File tải lên (storage://) là của người dùng
-- theo định nghĩa; link thì phải có xác nhận.
create or replace function public.create_video_pack(p_source text, p_confirmed boolean default false, p_clips integer default 5)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_source text := trim(coalesce(p_source, ''));
  v_upload boolean := v_source like 'storage://%';
  v_job public.jobs;
  v_run public.cmo_runs;
begin
  if not v_upload and not coalesce(p_confirmed, false) then
    raise exception 'Confirm that this is your own video.' using errcode = '22023';
  end if;
  if exists (select 1 from public.cmo_runs where user_id = v_user and kind = 'video_pack' and status in ('queued', 'running')) then
    raise exception 'Your last video pack is still being made.' using errcode = 'P0001';
  end if;
  v_job := public.create_job(v_source, coalesce(p_clips, 5), 'auto', null, 'clip', '9:16', 'auto', true, 'bold');
  insert into public.video_ownership (job_id, user_id, source, url)
  values (v_job.id, v_user, case when v_upload then 'upload' else 'link' end, case when v_upload then null else v_source end);
  v_run := public.cmo_enqueue(v_user, 'video_pack', jsonb_build_object('job_id', v_job.id));
  return jsonb_build_object('job', to_jsonb(v_job), 'run', to_jsonb(v_run));
end;
$$;

-- W5 ghi thẻ (service role). Một lượt một gói.
create or replace function public.cmo_save_video_pack(p_user uuid, p_run uuid, p_job uuid, p_clips jsonb, p_captions jsonb)
returns public.video_packs language plpgsql volatile security definer set search_path = public
as $$
declare
  v_row public.video_packs;
begin
  if not exists (select 1 from public.jobs where id = p_job and user_id = p_user) then
    raise exception 'That video is not in this account.' using errcode = 'P0002';
  end if;
  insert into public.video_packs (user_id, run_id, job_id, clips, captions)
  values (p_user, p_run, p_job, p_clips, p_captions)
  on conflict (run_id) do update set clips = excluded.clips, captions = excluded.captions
  returning * into v_row;
  return v_row;
end;
$$;

-- Người dùng quyết: duyệt (kèm task export vừa xếp) hoặc bỏ (lý do thành trí nhớ).
create or replace function public.cmo_decide_video_pack(p_id uuid, p_action text, p_exports jsonb default '[]'::jsonb, p_reason text default null)
returns public.video_packs language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_row public.video_packs;
begin
  if p_action is null or p_action not in ('approved', 'dismissed') then
    raise exception 'Unknown action.' using errcode = '22023';
  end if;
  if p_exports is null or jsonb_typeof(p_exports) <> 'array' then
    raise exception 'This request is not valid.' using errcode = '22023';
  end if;
  update public.video_packs
  set status = p_action, decided_at = now(), exports = case when p_action = 'approved' then p_exports else exports end
  where id = p_id and user_id = v_user and status = 'in_review'
  returning * into v_row;
  if not found then
    if exists (select 1 from public.video_packs where id = p_id and user_id = v_user) then
      raise exception 'This video pack was already decided.' using errcode = 'P0001';
    end if;
    raise exception 'Video pack not found.' using errcode = 'P0002';
  end if;
  if p_action = 'dismissed' and p_reason is not null and char_length(trim(p_reason)) > 0 then
    insert into public.cmo_memories (user_id, type, body)
    values (v_user, 'feedback', left('Skipped a video pack: ' || trim(p_reason), 600));
  end if;
  return v_row;
end;
$$;

revoke all on function public.cmo_job_price(text) from public, anon;
revoke all on function public.cmo_job_daily_limit(text) from public, anon;
revoke all on function public.cmo_enqueue(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_cmo_run(uuid, integer) from public, anon, authenticated;
revoke all on function public.cmo_defer_run(uuid, integer, integer, jsonb) from public, anon, authenticated;
revoke all on function public.create_video_pack(text, boolean, integer) from public, anon;
revoke all on function public.cmo_save_video_pack(uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.cmo_decide_video_pack(uuid, text, jsonb, text) from public, anon;
grant execute on function public.claim_cmo_run(uuid, integer) to service_role;
grant execute on function public.cmo_defer_run(uuid, integer, integer, jsonb) to service_role;
grant execute on function public.create_video_pack(text, boolean, integer) to authenticated;
grant execute on function public.cmo_save_video_pack(uuid, uuid, uuid, jsonb, jsonb) to service_role;
grant execute on function public.cmo_decide_video_pack(uuid, text, jsonb, text) to authenticated;

commit;
