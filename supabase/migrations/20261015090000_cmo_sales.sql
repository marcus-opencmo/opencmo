-- Tầng CMO đợt 2 (docs/cmo/san-pham.md §4.3 W4): quét Reddit tìm người đang cần,
-- chấm điểm có bằng chứng, soạn trả lời. KHÔNG có đường đăng: người dùng tự mở
-- thread và dán trả lời từ tài khoản của họ (luật sản phẩm 2).

begin;

-- ------------------------------------------------------------ việc sales_scan
alter table public.cmo_runs drop constraint if exists cmo_runs_kind_check;
alter table public.cmo_runs add constraint cmo_runs_kind_check
  check (kind in ('onboard', 'plan_week', 'post_draft', 'sales_scan'));

-- Giá khớp lib/usage.ts ("Conversation scan" 5 credit). Mỗi lần quét tốn tiền đọc
-- (ScrapeCreators) + LLM thật, nên trần 3 lần/ngày.
create or replace function public.cmo_job_price(p_kind text)
returns integer language sql immutable as $$
  select case p_kind when 'plan_week' then 1 when 'post_draft' then 1 when 'sales_scan' then 5 else 0 end
$$;
create or replace function public.cmo_job_daily_limit(p_kind text)
returns integer language sql immutable as $$
  select case p_kind when 'plan_week' then 5 when 'post_draft' then 10 when 'sales_scan' then 3 else 0 end
$$;

create or replace function public.cmo_enqueue(p_user uuid, p_kind text, p_input jsonb)
returns public.cmo_runs language plpgsql volatile security definer set search_path = public
as $$
declare
  v_row public.cmo_runs;
  v_price integer := public.cmo_job_price(p_kind);
begin
  if p_kind is null or p_kind not in ('plan_week', 'post_draft', 'sales_scan') then
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

create or replace function public.complete_cmo_run(
  p_run uuid, p_attempt integer, p_ok boolean, p_output jsonb default null, p_error text default null
)
returns boolean language plpgsql volatile security definer set search_path = public
as $$
declare
  v_row public.cmo_runs;
begin
  update public.cmo_runs
  set status = case when p_ok then 'done' else 'failed' end,
      output = p_output,
      error = case when p_ok then null else left(coalesce(p_error, 'Something went wrong.'), 500) end,
      finished_at = now(), lease_until = null
  where id = p_run and attempt = p_attempt and status = 'running'
  returning * into v_row;
  if not found then
    return false;
  end if;
  -- Lượt xong nhưng không ra gì để bán (W4 không có thread nào đạt): hoàn credit
  -- như lượt hỏng — người dùng không trả tiền cho một lần quét rỗng.
  if not p_ok or coalesce((p_output->>'refund')::boolean, false) then
    perform public.cmo_refund_run(v_row);
  end if;
  return true;
end;
$$;

-- ------------------------------------------------------------ cơ hội trên Reddit
create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid references public.cmo_runs(id) on delete set null,
  platform text not null default 'reddit' check (platform in ('reddit')),
  url text not null check (url ~ '^https://(www\.|old\.)?reddit\.com/' and char_length(url) <= 500),
  community text not null default '' check (char_length(community) <= 100),
  title text not null check (char_length(title) between 1 and 400),
  author text not null default '' check (char_length(author) <= 100),
  snippet text not null default '' check (char_length(snippet) <= 1200),
  posted_at timestamptz,
  comments integer not null default 0 check (comments >= 0),
  score integer not null check (score between 0 and 100),
  score_parts jsonb not null default '[]'::jsonb check (jsonb_typeof(score_parts) = 'array' and octet_length(score_parts::text) <= 8192),
  reply text not null check (char_length(reply) between 1 and 3000),
  priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  status text not null default 'in_review' check (status in ('in_review', 'replied', 'dismissed')),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  -- Một thread chỉ hiện một lần cho một người, kể cả khi đã bỏ qua.
  unique (user_id, url)
);
create index opportunities_user_status_idx on public.opportunities (user_id, status, created_at desc);
alter table public.opportunities enable row level security;
create policy "đọc cơ hội của mình" on public.opportunities
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.opportunities from anon, authenticated;

-- W4 ghi thẻ. Thread đã thấy thì bỏ qua (unique). Mục Reddit trên lịch tới hạn
-- coi như đã làm: lần quét hôm nay chính là việc của mục đó.
create or replace function public.cmo_save_opportunities(p_user uuid, p_run uuid, p_items jsonb)
returns integer language plpgsql volatile security definer set search_path = public
as $$
declare
  v_item jsonb;
  v_count integer := 0;
  v_score integer;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 10 then
    raise exception 'These conversations are not valid.' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_score := least(100, greatest(0, coalesce((v_item->>'score')::integer, 0)));
    insert into public.opportunities (
      user_id, run_id, url, community, title, author, snippet, posted_at, comments, score, score_parts, reply, priority
    ) values (
      p_user, p_run, v_item->>'url', left(coalesce(v_item->>'community', ''), 100), left(v_item->>'title', 400),
      left(coalesce(v_item->>'author', ''), 100), left(coalesce(v_item->>'snippet', ''), 1200),
      nullif(v_item->>'posted_at', '')::timestamptz, greatest(0, coalesce((v_item->>'comments')::integer, 0)),
      v_score, coalesce(v_item->'score_parts', '[]'::jsonb), left(v_item->>'reply', 3000),
      case when v_score >= 85 then 'high' when v_score >= 70 then 'medium' else 'low' end
    )
    on conflict (user_id, url) do nothing;
    if found then
      v_count := v_count + 1;
    end if;
  end loop;
  update public.content_items set status = 'published', published_at = now(), updated_at = now()
  where user_id = p_user and department = 'sales' and status = 'planned' and day <= current_date;
  return v_count;
end;
$$;

-- Người dùng quyết: đã trả lời (tự đăng trên Reddit) hoặc bỏ. Lý do bỏ thành trí nhớ.
create or replace function public.cmo_decide_opportunity(p_id uuid, p_action text, p_reason text default null)
returns public.opportunities language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_row public.opportunities;
begin
  if p_action is null or p_action not in ('replied', 'dismissed') then
    raise exception 'Unknown action.' using errcode = '22023';
  end if;
  update public.opportunities set status = p_action, decided_at = now()
  where id = p_id and user_id = v_user and status = 'in_review'
  returning * into v_row;
  if not found then
    if exists(select 1 from public.opportunities where id = p_id and user_id = v_user) then
      raise exception 'This conversation was already decided.' using errcode = 'P0001';
    end if;
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;
  if p_action = 'dismissed' and p_reason is not null and char_length(trim(p_reason)) > 0 then
    insert into public.cmo_memories (user_id, type, body)
    values (v_user, 'feedback', left('Dismissed the Reddit thread "' || left(v_row.title, 120) || '": ' || trim(p_reason), 600));
  end if;
  return v_row;
end;
$$;

revoke all on function public.cmo_job_price(text) from public, anon;
revoke all on function public.cmo_job_daily_limit(text) from public, anon;
revoke all on function public.cmo_enqueue(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.complete_cmo_run(uuid, integer, boolean, jsonb, text) from public, anon, authenticated;
revoke all on function public.cmo_save_opportunities(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.cmo_decide_opportunity(uuid, text, text) from public, anon;
grant execute on function public.complete_cmo_run(uuid, integer, boolean, jsonb, text) to service_role;
grant execute on function public.cmo_save_opportunities(uuid, uuid, jsonb) to service_role;
grant execute on function public.cmo_decide_opportunity(uuid, text, text) to authenticated;

commit;
