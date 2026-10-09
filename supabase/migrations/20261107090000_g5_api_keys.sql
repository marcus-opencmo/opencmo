-- G5 (học Palmier: MCP server): khoá API cá nhân cho client MCP (Claude Desktop, Cursor…).
--
-- Chỉ lưu sha256 của khoá; khoá gốc trả về ĐÚNG MỘT LẦN lúc tạo. Route `/api/mcp` đổi khoá thành
-- user (qua `api_key_owner`, chỉ service role gọi được) rồi ký JWT ngắn hạn cho chính user đó:
-- mọi tool chạy DƯỚI RLS như người dùng tự làm. Trần 10 khoá đang dùng mỗi người.
-- Bucket nhịp `mcp`: 600 lượt gọi tool mỗi giờ.

begin;

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  prefix text not null,
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index api_keys_user_idx on public.api_keys (user_id, created_at desc);

alter table public.api_keys enable row level security;
create policy "đọc khoá của mình" on public.api_keys
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.api_keys from anon, authenticated;
-- Hash không bao giờ ra client, kể cả của chính mình.
revoke select on public.api_keys from anon, authenticated;
grant select (id, user_id, name, prefix, created_at, last_used_at, revoked_at) on public.api_keys to authenticated;

create or replace function public.create_api_key(p_name text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_user uuid := public.require_user();
  v_name text := btrim(coalesce(p_name, ''));
  v_key text;
  v_row public.api_keys;
begin
  if v_name = '' or char_length(v_name) > 60 then
    raise exception 'Name the key in 1 to 60 characters.' using errcode = '22023';
  end if;
  if (select count(*) from public.api_keys where user_id = v_user and revoked_at is null) >= 10 then
    raise exception 'You already have 10 active keys. Revoke one first.' using errcode = 'P0001';
  end if;
  v_key := 'ocm_' || encode(gen_random_bytes(24), 'hex');
  insert into public.api_keys (user_id, name, prefix, key_hash)
  values (v_user, v_name, left(v_key, 12), encode(digest(v_key, 'sha256'), 'hex'))
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'prefix', v_row.prefix, 'created_at', v_row.created_at, 'key', v_key);
end;
$$;

create or replace function public.revoke_api_key(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := public.require_user();
begin
  update public.api_keys set revoked_at = now()
  where id = p_id and user_id = v_user and revoked_at is null;
  return found;
end;
$$;

-- Chủ của một khoá (theo sha256), ghi lần dùng cuối. Chỉ service role: route MCP gọi trước khi
-- có user; trả null cho khoá lạ/đã thu hồi (không phân biệt hai trường hợp).
create or replace function public.api_key_owner(p_hash text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid;
begin
  update public.api_keys set last_used_at = now()
  where key_hash = p_hash and revoked_at is null
  returning user_id into v_user;
  return v_user;
end;
$$;

revoke execute on function public.api_key_owner(text) from public, anon, authenticated;
grant execute on function public.api_key_owner(text) to service_role;
revoke execute on function public.create_api_key(text) from public, anon;
revoke execute on function public.revoke_api_key(uuid) from public, anon;
grant execute on function public.create_api_key(text) to authenticated;
grant execute on function public.revoke_api_key(uuid) to authenticated;

create or replace function public.rate_limit_hit(p_bucket text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path to 'public'
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
      or (p_bucket = 'mcp' and p_limit = 600 and p_window_seconds = 3600)
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

commit;
