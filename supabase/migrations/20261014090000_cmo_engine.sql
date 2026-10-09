-- Tầng CMO đợt 1 (docs/cmo/san-pham.md §4–6): hàng đợi việc CMO, lịch + bài,
-- nhật ký thao tác, trí nhớ của CMO, và phiên chat scope `cmo`.
--
-- Vì sao hàng đợi là `cmo_runs` chứ không phải `tasks`: `tasks` chỉ worker
-- Python nhận, danh sách kind cứng ở ba chỗ (loop.py, modal_app.py), và việc CMO
-- không đụng file — chỉ gọi LLM + HTTP, chạy trong Next.js bằng service role.
--
-- Mọi thứ đi ra ngoài phải qua `cmo_decide_post` (người dùng duyệt). Trần mỗi
-- ngày và chống trùng nằm ở đây — `operation_log` unique — không nằm trong prompt.

begin;

-- ------------------------------------------------------------ hàng đợi cmo_runs
alter table public.cmo_runs drop constraint if exists cmo_runs_kind_check;
alter table public.cmo_runs add constraint cmo_runs_kind_check
  check (kind in ('onboard', 'plan_week', 'post_draft'));
alter table public.cmo_runs drop constraint if exists cmo_runs_status_check;
alter table public.cmo_runs add constraint cmo_runs_status_check
  check (status in ('queued', 'running', 'done', 'failed'));
alter table public.cmo_runs
  add column if not exists steps jsonb not null default '[]'::jsonb
    check (jsonb_typeof(steps) = 'array' and octet_length(steps::text) <= 16384),
  add column if not exists output jsonb
    check (output is null or (jsonb_typeof(output) = 'object' and octet_length(output::text) <= 16384)),
  add column if not exists attempt integer not null default 0,
  add column if not exists lease_until timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists credits integer not null default 0 check (credits >= 0);
create index if not exists cmo_runs_queue_idx on public.cmo_runs (created_at) where status = 'queued';
create index if not exists cmo_runs_lease_idx on public.cmo_runs (lease_until) where status = 'running';

-- Lượt W0 chết quá 10 phút: chỉ quét `onboard`. Lượt của hàng đợi có lease
-- riêng (`claim_cmo_run`), quét theo tuổi ở đây sẽ giết nhầm lượt đang chạy.
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
  where user_id = v_user and kind = 'onboard' and status = 'running' and created_at < now() - interval '10 minutes';

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

-- Giá và trần mỗi ngày của từng việc. Giá khớp lib/usage.ts ("Post draft" 1 credit).
create or replace function public.cmo_job_price(p_kind text)
returns integer language sql immutable as $$
  select case p_kind when 'plan_week' then 1 when 'post_draft' then 1 else 0 end
$$;
create or replace function public.cmo_job_daily_limit(p_kind text)
returns integer language sql immutable as $$
  select case p_kind when 'plan_week' then 5 when 'post_draft' then 10 else 0 end
$$;

-- Hoàn credit đã giữ của một lượt hỏng. Gọi trong cùng giao dịch đổi trạng thái.
create or replace function public.cmo_refund_run(p_run public.cmo_runs)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  if p_run.credits > 0 then
    insert into public.credit_ledger (user_id, delta, reason) values (p_run.user_id, p_run.credits, 'CMO refund');
  end if;
end;
$$;

-- Đã có lượt cùng loại đang chờ/chạy thì trả lại lượt đó: bấm hai lần, cron và
-- người dùng cùng thả việc, đều không sinh hai lượt (và không giữ credit hai lần).
create or replace function public.cmo_enqueue(p_user uuid, p_kind text, p_input jsonb)
returns public.cmo_runs language plpgsql volatile security definer set search_path = public
as $$
declare
  v_row public.cmo_runs;
  v_price integer := public.cmo_job_price(p_kind);
begin
  if p_kind is null or p_kind not in ('plan_week', 'post_draft') then
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

create or replace function public.enqueue_cmo_run(p_kind text, p_input jsonb default '{}'::jsonb)
returns public.cmo_runs language plpgsql volatile security definer set search_path = public
as $$
begin
  return public.cmo_enqueue(public.require_user(), p_kind, p_input);
end;
$$;

create or replace function public.enqueue_cmo_run_for(p_user uuid, p_kind text, p_input jsonb default '{}'::jsonb)
returns public.cmo_runs language plpgsql volatile security definer set search_path = public
as $$
begin
  return public.cmo_enqueue(p_user, p_kind, p_input);
end;
$$;

-- Nhận một lượt (cụ thể, hoặc lượt cũ nhất). Lượt mà function Vercel chết giữa
-- chừng (hết lease) được thả lại hàng đợi; quá 3 lần thì thôi và hoàn credit.
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

-- Ghi các bước (Activity đọc thẳng) và gia hạn lease. False = lượt đã bị nhận lại.
create or replace function public.cmo_run_step(p_run uuid, p_attempt integer, p_steps jsonb)
returns boolean language plpgsql volatile security definer set search_path = public
as $$
begin
  update public.cmo_runs set steps = p_steps, lease_until = now() + interval '300 seconds'
  where id = p_run and attempt = p_attempt and status = 'running';
  return found;
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
  if not p_ok then
    perform public.cmo_refund_run(v_row);
  end if;
  return true;
end;
$$;

-- ------------------------------------------------------------ lịch + bài
-- Một hàng = một mục trên lịch, rồi thành bài nháp, rồi bài đã duyệt/đã đăng.
create table public.content_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid references public.cmo_runs(id) on delete set null,
  department text not null check (department in ('post', 'sales', 'video')),
  platform text not null check (char_length(platform) between 1 and 20),
  day date not null,
  idea text not null check (char_length(idea) between 1 and 300),
  reason text not null default '' check (char_length(reason) <= 300),
  status text not null default 'planned'
    check (status in ('planned', 'drafting', 'in_review', 'approved', 'published', 'skipped', 'failed')),
  priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  body jsonb not null default '{}'::jsonb check (jsonb_typeof(body) = 'object' and octet_length(body::text) <= 16384),
  final_text text check (char_length(final_text) <= 4000),
  external_url text check (char_length(external_url) <= 500),
  decided_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index content_items_user_status_idx on public.content_items (user_id, status, day);
alter table public.content_items enable row level security;
create policy "đọc lịch và bài của mình" on public.content_items
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.content_items from anon, authenticated;

-- Nhật ký thao tác ra ngoài. Unique là cái chốt chống duyệt/đăng trùng ở tầng DB.
create table public.operation_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null,
  action text not null,
  target text not null,
  result text not null default 'ok',
  at timestamptz not null default now(),
  unique (user_id, platform, action, target)
);
create index operation_log_user_at_idx on public.operation_log (user_id, platform, action, at desc);
alter table public.operation_log enable row level security;
create policy "đọc nhật ký của mình" on public.operation_log
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.operation_log from anon, authenticated;

-- Điều CMO cần nhớ: lý do người dùng bỏ bài, điều người dùng dặn trong chat.
create table public.cmo_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('feedback', 'user')),
  body text not null check (char_length(body) between 1 and 600),
  created_at timestamptz not null default now()
);
create index cmo_memories_user_idx on public.cmo_memories (user_id, created_at desc);
alter table public.cmo_memories enable row level security;
create policy "đọc trí nhớ CMO của mình" on public.cmo_memories
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.cmo_memories from anon, authenticated;

-- W1: thay các mục `planned` từ hôm nay trở đi bằng kế hoạch mới. Mục đã thành
-- bài (nháp, duyệt, đăng) không bị đụng.
create or replace function public.cmo_plan_week(p_user uuid, p_run uuid, p_items jsonb)
returns integer language plpgsql volatile security definer set search_path = public
as $$
declare
  v_item jsonb;
  v_count integer := 0;
  v_day date;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 30 then
    raise exception 'This plan is not valid.' using errcode = '22023';
  end if;
  delete from public.content_items where user_id = p_user and status = 'planned' and day >= current_date;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_day := (v_item->>'day')::date;
    if v_day < current_date or v_day > current_date + 13 then
      continue;
    end if;
    insert into public.content_items (user_id, run_id, department, platform, day, idea, reason)
    values (
      p_user, p_run, v_item->>'department', left(v_item->>'platform', 20), v_day,
      left(v_item->>'idea', 300), left(coalesce(v_item->>'reason', ''), 300)
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- W2: lưu bản nháp. Có `p_item` = mục lịch tới hạn; không có = bài ngoài lịch.
create or replace function public.cmo_save_draft(
  p_user uuid, p_run uuid, p_item uuid, p_idea text, p_body jsonb, p_priority text default 'medium'
)
returns public.content_items language plpgsql volatile security definer set search_path = public
as $$
declare
  v_row public.content_items;
begin
  if p_body is null or jsonb_typeof(p_body) <> 'object' or coalesce(p_body->>'text', '') = '' then
    raise exception 'This draft is not valid.' using errcode = '22023';
  end if;
  if p_item is not null then
    update public.content_items
    set status = 'in_review', body = p_body, priority = coalesce(p_priority, 'medium'), run_id = p_run, updated_at = now()
    where id = p_item and user_id = p_user and status in ('planned', 'drafting')
    returning * into v_row;
    if not found then
      raise exception 'This calendar item is no longer open.' using errcode = 'P0002';
    end if;
  else
    insert into public.content_items (user_id, run_id, department, platform, day, idea, status, priority, body)
    values (p_user, p_run, 'post', 'x', current_date, left(coalesce(nullif(p_idea, ''), 'Post for X'), 300),
            'in_review', coalesce(p_priority, 'medium'), p_body)
    returning * into v_row;
  end if;
  return v_row;
end;
$$;

-- ------------------------------------------------------------ người dùng
create or replace function public.cmo_update_item(p_id uuid, p_idea text, p_day date)
returns public.content_items language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_row public.content_items;
begin
  if p_idea is null or char_length(trim(p_idea)) = 0 or char_length(p_idea) > 300 then
    raise exception 'Write the idea in 300 characters or fewer.' using errcode = '22023';
  end if;
  if p_day is null or p_day < current_date or p_day > current_date + 13 then
    raise exception 'Pick a day in the next two weeks.' using errcode = '22023';
  end if;
  update public.content_items set idea = trim(p_idea), day = p_day, updated_at = now()
  where id = p_id and user_id = v_user and status = 'planned'
  returning * into v_row;
  if not found then
    raise exception 'This calendar item is no longer open.' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

create or replace function public.cmo_remove_item(p_id uuid)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
begin
  delete from public.content_items where id = p_id and user_id = v_user and status = 'planned';
  if not found then
    raise exception 'This calendar item is no longer open.' using errcode = 'P0002';
  end if;
end;
$$;

-- Duyệt hoặc bỏ một bài X. Duyệt = người dùng sẽ tự đăng (đăng hỗ trợ) hoặc,
-- từ đợt 4, Zernio lên lịch. Trần 5 bài duyệt/ngày; duyệt hai lần bị chặn.
create or replace function public.cmo_decide_post(p_id uuid, p_action text, p_text text default null, p_reason text default null)
returns public.content_items language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_row public.content_items;
  v_text text;
begin
  if p_action is null or p_action not in ('approve', 'skip') then
    raise exception 'Unknown action.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':cmo_post', 1713));
  select * into v_row from public.content_items
  where id = p_id and user_id = v_user and department = 'post'
  for update;
  if not found then
    raise exception 'Post not found.' using errcode = 'P0002';
  end if;
  if v_row.status <> 'in_review' then
    raise exception 'This post was already decided.' using errcode = 'P0001';
  end if;

  if p_action = 'skip' then
    update public.content_items set status = 'skipped', decided_at = now(), updated_at = now()
    where id = p_id returning * into v_row;
    if p_reason is not null and char_length(trim(p_reason)) > 0 then
      insert into public.cmo_memories (user_id, type, body)
      values (v_user, 'feedback', left('Skipped the X post "' || left(v_row.idea, 120) || '": ' || trim(p_reason), 600));
    end if;
    return v_row;
  end if;

  v_text := coalesce(nullif(trim(p_text), ''), v_row.body->>'text');
  if v_text is null or char_length(v_text) = 0 then
    raise exception 'This post is empty.' using errcode = '22023';
  end if;
  if char_length(v_text) > 280 then
    raise exception 'Posts on X can be at most 280 characters.' using errcode = '22023';
  end if;
  if (select count(*) from public.operation_log
      where user_id = v_user and platform = 'x' and action = 'approve' and at > now() - interval '1 day') >= 5 then
    raise exception 'You can approve 5 posts for X a day. Try again tomorrow.' using errcode = 'P0001';
  end if;
  insert into public.operation_log (user_id, platform, action, target) values (v_user, 'x', 'approve', p_id::text);
  update public.content_items set status = 'approved', final_text = v_text, decided_at = now(), updated_at = now()
  where id = p_id returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.cmo_mark_posted(p_id uuid, p_url text default null)
returns public.content_items language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_row public.content_items;
  v_url text := nullif(trim(coalesce(p_url, '')), '');
begin
  if v_url is not null and v_url !~ '^https://(www\.)?(x|twitter)\.com/[A-Za-z0-9_]{1,15}/status/[0-9]{1,25}' then
    raise exception 'Paste the link to your post on X, like https://x.com/you/status/123.' using errcode = '22023';
  end if;
  update public.content_items set status = 'published', external_url = v_url, published_at = now(), updated_at = now()
  where id = p_id and user_id = v_user and status = 'approved'
  returning * into v_row;
  if not found then
    raise exception 'Approve the post before marking it as posted.' using errcode = 'P0001';
  end if;
  insert into public.operation_log (user_id, platform, action, target) values (v_user, 'x', 'publish', p_id::text)
  on conflict do nothing;
  return v_row;
end;
$$;

create or replace function public.cmo_remember(p_body text)
returns public.cmo_memories language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_row public.cmo_memories;
begin
  if p_body is null or char_length(trim(p_body)) = 0 or char_length(p_body) > 600 then
    raise exception 'Keep the note under 600 characters.' using errcode = '22023';
  end if;
  if (select count(*) from public.cmo_memories where user_id = v_user) >= 200 then
    delete from public.cmo_memories where id in (
      select id from public.cmo_memories where user_id = v_user order by created_at limit 1
    );
  end if;
  insert into public.cmo_memories (user_id, type, body) values (v_user, 'user', trim(p_body)) returning * into v_row;
  return v_row;
end;
$$;

-- ------------------------------------------------------------ chat scope cmo
alter table public.agent_sessions drop constraint if exists agent_sessions_scope_check;
alter table public.agent_sessions add constraint agent_sessions_scope_check check (
  (scope = 'clip' and clip_id is not null and job_id is null)
  or (scope = 'project' and job_id is not null and clip_id is null)
  or (scope = 'cmo' and clip_id is null and job_id is null)
);

-- Phiên cmo không gắn job: join job phải là LEFT, nếu không mọi lượt chat CMO
-- báo "Assistant session not found".
create or replace function public.agent_owned_session(p_session_id uuid, p_user uuid)
returns public.agent_sessions language plpgsql stable security definer set search_path = public
as $$
declare
  v_session public.agent_sessions;
begin
  select s.* into v_session from public.agent_sessions s
  left join public.clips c on c.id = s.clip_id
  left join public.jobs j on j.id = coalesce(s.job_id, c.job_id)
  where s.id = p_session_id and s.user_id = p_user
    and (s.scope = 'cmo' or (j.id is not null and j.purging_at is null));
  if not found then
    raise exception 'Assistant session not found.' using errcode = 'P0002';
  end if;
  return v_session;
end;
$$;

create or replace function public.agent_open_cmo_session(p_model text, p_new boolean default false)
returns public.agent_sessions language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_session public.agent_sessions;
begin
  if p_model is null or char_length(p_model) > 64 or not exists (
    select 1 from public.agent_model_prices p
    where p.allowed and p.pattern <> 'default' and p_model like p.pattern
  ) then
    raise exception 'Unknown assistant model.' using errcode = '22023';
  end if;
  if not coalesce(p_new, false) then
    select * into v_session from public.agent_sessions
    where user_id = v_user and scope = 'cmo' and model = p_model
    order by created_at desc limit 1;
    if found then
      return v_session;
    end if;
  end if;
  insert into public.agent_sessions(user_id, scope, model)
  values (v_user, 'cmo', p_model) returning * into v_session;
  return v_session;
end;
$$;

-- ------------------------------------------------------------ quyền
revoke all on function public.cmo_job_price(text) from public, anon;
revoke all on function public.cmo_job_daily_limit(text) from public, anon;
revoke all on function public.cmo_refund_run(public.cmo_runs) from public, anon, authenticated;
revoke all on function public.cmo_enqueue(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.enqueue_cmo_run(text, jsonb) from public, anon;
revoke all on function public.enqueue_cmo_run_for(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_cmo_run(uuid, integer) from public, anon, authenticated;
revoke all on function public.cmo_run_step(uuid, integer, jsonb) from public, anon, authenticated;
revoke all on function public.complete_cmo_run(uuid, integer, boolean, jsonb, text) from public, anon, authenticated;
revoke all on function public.cmo_plan_week(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.cmo_save_draft(uuid, uuid, uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.cmo_update_item(uuid, text, date) from public, anon;
revoke all on function public.cmo_remove_item(uuid) from public, anon;
revoke all on function public.cmo_decide_post(uuid, text, text, text) from public, anon;
revoke all on function public.cmo_mark_posted(uuid, text) from public, anon;
revoke all on function public.cmo_remember(text) from public, anon;
revoke all on function public.agent_owned_session(uuid, uuid) from public, anon, authenticated;
revoke all on function public.agent_open_cmo_session(text, boolean) from public, anon;

grant execute on function public.enqueue_cmo_run(text, jsonb) to authenticated;
grant execute on function public.cmo_update_item(uuid, text, date) to authenticated;
grant execute on function public.cmo_remove_item(uuid) to authenticated;
grant execute on function public.cmo_decide_post(uuid, text, text, text) to authenticated;
grant execute on function public.cmo_mark_posted(uuid, text) to authenticated;
grant execute on function public.cmo_remember(text) to authenticated;
grant execute on function public.agent_open_cmo_session(text, boolean) to authenticated;
grant execute on function public.enqueue_cmo_run_for(uuid, text, jsonb) to service_role;
grant execute on function public.claim_cmo_run(uuid, integer) to service_role;
grant execute on function public.cmo_run_step(uuid, integer, jsonb) to service_role;
grant execute on function public.complete_cmo_run(uuid, integer, boolean, jsonb, text) to service_role;
grant execute on function public.cmo_plan_week(uuid, uuid, jsonb) to service_role;
grant execute on function public.cmo_save_draft(uuid, uuid, uuid, text, jsonb, text) to service_role;

commit;
