-- 20261021090000: send_feedback (E2-d, học Palmier `send_feedback`).
--
-- Agent báo một giới hạn hay lỗi của chính nó ("không có tool làm việc này", "kết quả
-- lệch") để đội sản phẩm sửa. Ghi qua RPC (luật web 1), có trần 20 lượt/giờ. Nội dung
-- là lời agent DIỄN ĐẠT LẠI, không chép nguyên văn người dùng.

create table public.editor_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  clip_id uuid references public.clips (id) on delete set null,
  category text not null check (category in ('missing_capability', 'wrong_result', 'confusing_ux', 'failure', 'suggestion')),
  summary text not null check (char_length(summary) between 1 and 300),
  details text check (details is null or char_length(details) <= 4000),
  severity text check (severity is null or severity in ('low', 'medium', 'high')),
  created_at timestamptz not null default now()
);

create index editor_feedback_created_idx on public.editor_feedback (created_at desc);

alter table public.editor_feedback enable row level security;
create policy "đọc phản hồi của mình" on public.editor_feedback
  for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on public.editor_feedback from anon, authenticated;

create or replace function public.rate_limit_hit(
  p_bucket text,
  p_limit int,
  p_window_seconds int
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_bucket text;
  v_plan text;
  v_quota record;
  v_expected int;
  v_window_start timestamptz;
  v_legacy_count int := 0;
  v_count int;
  v_allowed boolean := false;
begin
  v_bucket := case p_bucket
    when 'daily_preview' then 'preview'
    when 'daily_export' then 'export'
    else p_bucket
  end;

  if v_bucket in ('preview', 'export') then
    select coalesce(plan, 'free') into v_plan
    from public.profiles where id = v_user;
    select * into v_quota from public.plan_quota(v_plan);
    v_expected := case
      when v_bucket = 'preview' then v_quota.previews_per_day
      else v_quota.exports_per_day
    end;
    v_allowed := p_limit = v_expected and p_window_seconds = 86400;
    if p_bucket = 'preview' and p_limit = 2 and p_window_seconds = 60 then
      v_allowed := true;
    end if;
  else
    v_allowed := (p_bucket = 'presets' and p_limit = 60 and p_window_seconds = 3600)
      or (p_bucket = 'uploads' and p_limit = 30 and p_window_seconds = 3600)
      or (p_bucket = 'jobs' and p_limit = 10 and p_window_seconds = 3600)
      or (p_bucket = 'retry' and p_limit = 20 and p_window_seconds = 3600)
      or (p_bucket = 'draft' and p_limit = 120 and p_window_seconds = 60)
      or (p_bucket = 'project-write' and p_limit = 60 and p_window_seconds = 3600)
      or (p_bucket = 'editor-write' and p_limit = 240 and p_window_seconds = 60)
      or (p_bucket = 'zip' and p_limit = 20 and p_window_seconds = 3600)
      or (p_bucket = 'media' and p_limit = 60 and p_window_seconds = 3600)
      or (p_bucket = 'scene_codes' and p_limit = 300 and p_window_seconds = 3600)
      or (p_bucket = 'feedback' and p_limit = 20 and p_window_seconds = 3600);
  end if;

  if not v_allowed then
    raise exception 'Invalid rate limit.' using errcode = '22023';
  end if;

  -- Cửa sổ ngắn của preview/export đếm ở hàng riêng: phút đầu sau nửa đêm UTC,
  -- cửa sổ 60 giây và cửa sổ ngày có cùng `window_start` nên từng cộng dồn vào
  -- hạn mức ngày (CI đỏ lúc 00:00:24 UTC 04/10).
  if v_bucket in ('preview', 'export') and p_window_seconds <> 86400 then
    v_bucket := v_bucket || ':' || p_window_seconds;
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  if v_bucket in ('preview', 'export') and p_window_seconds = 86400 then
    select coalesce(max(count), 0) into v_legacy_count
    from public.rate_limits
      where user_id = v_user
      and bucket = 'daily_' || v_bucket
      and window_start = v_window_start;
  end if;

  insert into public.rate_limits(user_id, bucket, window_start, count)
  values(v_user, v_bucket, v_window_start, v_legacy_count + 1)
  on conflict (user_id, bucket, window_start)
  do update set count = greatest(public.rate_limits.count, v_legacy_count) + 1
  returning count into v_count;

  return v_count <= p_limit;
end;
$$;


create or replace function public.send_feedback(
  p_category text,
  p_summary text,
  p_details text default null,
  p_severity text default null,
  p_clip_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_id uuid;
begin
  if p_category is null or p_category not in ('missing_capability', 'wrong_result', 'confusing_ux', 'failure', 'suggestion') then
    raise exception 'Unknown feedback category.' using errcode = '22023';
  end if;
  if p_summary is null or btrim(p_summary) = '' or char_length(p_summary) > 300 then
    raise exception 'Write a one-line summary under 300 characters.' using errcode = '22023';
  end if;
  if p_details is not null and char_length(p_details) > 4000 then
    raise exception 'Feedback details are longer than 4000 characters.' using errcode = '22023';
  end if;
  if p_severity is not null and p_severity not in ('low', 'medium', 'high') then
    raise exception 'Unknown feedback severity.' using errcode = '22023';
  end if;
  -- Clip của người khác: bỏ liên kết, không báo lỗi (phản hồi vẫn có giá trị).
  if p_clip_id is not null and not exists (
    select 1 from public.clips c join public.jobs j on j.id = c.job_id where c.id = p_clip_id and j.user_id = v_user
  ) then
    p_clip_id := null;
  end if;
  if not public.rate_limit_hit('feedback', 20, 3600) then
    raise exception 'Too much feedback in a short time. Try again later.' using errcode = 'P0001';
  end if;
  insert into public.editor_feedback (user_id, clip_id, category, summary, details, severity)
  values (v_user, p_clip_id, p_category, btrim(p_summary), nullif(btrim(coalesce(p_details, '')), ''), p_severity)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.send_feedback(text, text, text, text, uuid) from public, anon;
grant execute on function public.send_feedback(text, text, text, text, uuid) to authenticated;
