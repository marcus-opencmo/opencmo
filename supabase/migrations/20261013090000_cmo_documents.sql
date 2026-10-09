-- Tầng CMO, bước 1 (docs/cmo/san-pham.md §4.3, việc W0): bộ document marketing
-- của người dùng, sinh từ website rồi người dùng sửa.
--
-- Mỗi lần ghi là một VERSION mới, không update tại chỗ: bản agent sinh và bản
-- người dùng sửa đều còn lại, nên sau này W1 (kế hoạch tuần) biết người dùng đã
-- sửa gì so với agent — đó là dữ liệu quý nhất để agent viết đúng giọng.
--
-- `cmo_runs` ghi mỗi lượt việc chạy (bây giờ chỉ W0) để: chặn chạy chồng, giới
-- hạn số lần sinh mỗi ngày (mỗi lượt là tiền LLM thật), và làm nền cho Agent Log.

begin;

create table public.marketing_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('product', 'strategy', 'competitors', 'content_strategy', 'calendar')),
  version integer not null check (version >= 1),
  body jsonb not null check (jsonb_typeof(body) = 'object' and octet_length(body::text) <= 65536),
  created_by text not null check (created_by in ('agent', 'user')),
  created_at timestamptz not null default now(),
  unique (user_id, kind, version)
);

alter table public.marketing_documents enable row level security;
create policy "đọc document marketing của mình" on public.marketing_documents
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.marketing_documents from anon, authenticated;

-- Bản mới nhất mỗi loại. security_invoker: RLS của bảng gốc vẫn lọc theo người gọi.
create view public.marketing_documents_latest with (security_invoker = true) as
  select distinct on (user_id, kind) *
  from public.marketing_documents
  order by user_id, kind, version desc;
grant select on public.marketing_documents_latest to authenticated;

create table public.cmo_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('onboard')),
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  input jsonb not null default '{}'::jsonb check (jsonb_typeof(input) = 'object' and octet_length(input::text) <= 4096),
  error text check (char_length(error) <= 500),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index cmo_runs_user_created_idx on public.cmo_runs (user_id, created_at desc);

alter table public.cmo_runs enable row level security;
create policy "đọc lượt CMO của mình" on public.cmo_runs
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.cmo_runs from anon, authenticated;

-- Lượt chạy quá 10 phút mà chưa kết thúc là lượt đã chết (function Vercel bị
-- giết giữa chừng): coi là failed để không chặn người dùng mãi.
create or replace function public.start_cmo_run(p_kind text, p_input jsonb)
returns public.cmo_runs
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_row public.cmo_runs;
begin
  if p_kind is distinct from 'onboard' then
    raise exception 'Unknown task.' using errcode = '22023';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' or octet_length(p_input::text) > 4096 then
    raise exception 'This request is not valid.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':cmo_run', 1713));

  update public.cmo_runs set status = 'failed', error = 'Timed out.', finished_at = now()
  where user_id = v_user and status = 'running' and created_at < now() - interval '10 minutes';

  if exists(select 1 from public.cmo_runs where user_id = v_user and kind = p_kind and status = 'running') then
    raise exception 'Your marketing plan is already being built. Give it a minute.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.cmo_runs
      where user_id = v_user and kind = p_kind and created_at > now() - interval '1 day') >= 5 then
    raise exception 'You can rebuild your plan 5 times a day. Try again tomorrow, or edit the documents directly.' using errcode = 'P0001';
  end if;

  insert into public.cmo_runs (user_id, kind, input) values (v_user, p_kind, p_input) returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.finish_cmo_run(p_id uuid, p_ok boolean, p_error text default null)
returns public.cmo_runs
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_row public.cmo_runs;
begin
  update public.cmo_runs
  set status = case when p_ok then 'done' else 'failed' end,
      error = case when p_ok then null else left(coalesce(p_error, 'Something went wrong.'), 500) end,
      finished_at = now()
  where id = p_id and user_id = v_user and status = 'running'
  returning * into v_row;
  if not found then
    raise exception 'This task has already finished.' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- Ghi một version mới. `p_run` có mặt nghĩa là agent ghi trong một lượt đang
-- chạy của chính người này; không có là người dùng tự sửa.
create or replace function public.save_marketing_document(p_kind text, p_body jsonb, p_run uuid default null)
returns public.marketing_documents
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_by text := 'user';
  v_row public.marketing_documents;
begin
  if p_kind is null or p_kind not in ('product', 'strategy', 'competitors', 'content_strategy', 'calendar') then
    raise exception 'Unknown document.' using errcode = '22023';
  end if;
  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    raise exception 'This document is not valid.' using errcode = '22023';
  end if;
  if octet_length(p_body::text) > 65536 then
    raise exception 'This document is too long.' using errcode = '22023';
  end if;
  if p_run is not null then
    if not exists(select 1 from public.cmo_runs where id = p_run and user_id = v_user and status = 'running') then
      raise exception 'This task has already finished.' using errcode = 'P0002';
    end if;
    v_by := 'agent';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':doc:' || p_kind, 1713));
  insert into public.marketing_documents (user_id, kind, version, body, created_by)
  values (
    v_user, p_kind,
    coalesce((select max(version) from public.marketing_documents where user_id = v_user and kind = p_kind), 0) + 1,
    p_body, v_by
  )
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.start_cmo_run(text, jsonb) from public, anon;
revoke all on function public.finish_cmo_run(uuid, boolean, text) from public, anon;
revoke all on function public.save_marketing_document(text, jsonb, uuid) from public, anon;
grant execute on function public.start_cmo_run(text, jsonb) to authenticated;
grant execute on function public.finish_cmo_run(uuid, boolean, text) to authenticated;
grant execute on function public.save_marketing_document(text, jsonb, uuid) to authenticated;

commit;
