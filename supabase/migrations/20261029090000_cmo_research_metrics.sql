-- 20261029090000: W7 nghiên cứu đối thủ + W6-lite số liệu bài đã đăng (H5).
--
-- W7 `competitor_research` (agent Research): bài nổi vượt baseline của đối thủ trên X (qua
-- ScrapeCreators) → "hook/format đang chạy" kèm URL, lưu vào `cmo_insights` để Planner và X writer
-- dùng. W6-lite `pull_metrics` (không LLM, không Zernio): đọc số công khai của bài người dùng đã
-- tự đăng → `post_metrics`, cột Results hiện số thật thay chữ "No numbers yet".

begin;

alter table public.cmo_runs drop constraint if exists cmo_runs_kind_check;
alter table public.cmo_runs add constraint cmo_runs_kind_check
  check (kind in ('onboard', 'plan_week', 'post_draft', 'sales_scan', 'video_pack', 'competitor_research', 'pull_metrics'));

-- Giá: nghiên cứu ~8 lời gọi ScrapeCreators + 1 lượt model → 2 credit. Số liệu: vài lời gọi, không
-- model, chạy tự động mỗi ngày → miễn phí cho người dùng (giới hạn 2/ngày chặn lạm dụng).
create or replace function public.cmo_job_price(p_kind text)
returns integer language sql immutable as $$
  select case p_kind when 'plan_week' then 1 when 'post_draft' then 1 when 'sales_scan' then 5 when 'video_pack' then 1
    when 'competitor_research' then 2 when 'pull_metrics' then 0 else 0 end
$$;
create or replace function public.cmo_job_daily_limit(p_kind text)
returns integer language sql immutable as $$
  select case p_kind when 'plan_week' then 5 when 'post_draft' then 10 when 'sales_scan' then 3 when 'video_pack' then 3
    when 'competitor_research' then 2 when 'pull_metrics' then 2 else 0 end
$$;

create or replace function public.cmo_enqueue(p_user uuid, p_kind text, p_input jsonb)
returns public.cmo_runs language plpgsql volatile security definer set search_path = public
as $$
declare
  v_row public.cmo_runs;
  v_price integer := public.cmo_job_price(p_kind);
begin
  if p_kind is null or p_kind not in ('plan_week', 'post_draft', 'sales_scan', 'video_pack', 'competitor_research', 'pull_metrics') then
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

-- ------------------------------------------------------------ W7: điều học được
create table public.cmo_insights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid references public.cmo_runs(id) on delete set null,
  kind text not null check (kind in ('competitors')),
  body jsonb not null check (jsonb_typeof(body) = 'object' and octet_length(body::text) <= 32768),
  created_at timestamptz not null default now()
);
create index cmo_insights_user_idx on public.cmo_insights (user_id, kind, created_at desc);
alter table public.cmo_insights enable row level security;
create policy "đọc insight của mình" on public.cmo_insights for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.cmo_insights from anon, authenticated;

create or replace function public.cmo_save_insight(p_user uuid, p_run uuid, p_kind text, p_body jsonb)
returns public.cmo_insights language plpgsql volatile security definer set search_path = public
as $$
declare
  v_row public.cmo_insights;
begin
  insert into public.cmo_insights (user_id, run_id, kind, body) values (p_user, p_run, p_kind, p_body) returning * into v_row;
  -- Giữ 20 bản gần nhất mỗi loại.
  delete from public.cmo_insights where id in (
    select id from public.cmo_insights where user_id = p_user and kind = p_kind order by created_at desc offset 20
  );
  return v_row;
end;
$$;

-- ------------------------------------------------------------ W6-lite: số liệu bài đã đăng
create table public.post_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null references public.content_items(id) on delete cascade,
  url text not null check (char_length(url) <= 500),
  views bigint not null default 0 check (views >= 0),
  likes bigint not null default 0 check (likes >= 0),
  replies bigint not null default 0 check (replies >= 0),
  reposts bigint not null default 0 check (reposts >= 0),
  measured_at timestamptz not null default now()
);
create index post_metrics_user_idx on public.post_metrics (user_id, measured_at desc);
create index post_metrics_item_idx on public.post_metrics (item_id, measured_at desc);
alter table public.post_metrics enable row level security;
create policy "đọc số liệu của mình" on public.post_metrics for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.post_metrics from anon, authenticated;

create or replace function public.cmo_save_metrics(p_user uuid, p_rows jsonb)
returns integer language plpgsql volatile security definer set search_path = public
as $$
declare
  v_row jsonb;
  v_count integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 50 then
    raise exception 'These numbers are not valid.' using errcode = '22023';
  end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    -- Chỉ bài ĐÃ ĐĂNG của chính người dùng: worker không ghi nhầm sang tài khoản khác.
    if exists (select 1 from public.content_items i where i.id = (v_row->>'item_id')::uuid and i.user_id = p_user and i.status = 'published') then
      insert into public.post_metrics (user_id, item_id, url, views, likes, replies, reposts)
      values (p_user, (v_row->>'item_id')::uuid, left(v_row->>'url', 500),
        greatest(0, coalesce((v_row->>'views')::bigint, 0)), greatest(0, coalesce((v_row->>'likes')::bigint, 0)),
        greatest(0, coalesce((v_row->>'replies')::bigint, 0)), greatest(0, coalesce((v_row->>'reposts')::bigint, 0)));
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.cmo_save_insight(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.cmo_save_metrics(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.cmo_save_insight(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.cmo_save_metrics(uuid, jsonb) to service_role;

commit;
