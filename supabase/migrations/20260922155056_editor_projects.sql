-- Editor mới (Diffusion Studio): nơi cất project của một clip.
--
-- Một project của DS là CODE — một file `index.tsx` default-export một Solid
-- component. Vài KB. Nó nằm ở Postgres chứ không ở Storage vì ba lý do, theo
-- thứ tự quan trọng:
--
--   1. Luật web số 1: mọi ghi đi qua RPC có kiểm ownership. Storage RLS kiểm
--      được thư mục, không kiểm được "clip này có phải của bạn không".
--   2. Khoá lạc quan giữa hai tab cần một số `version` tăng trong cùng giao
--      dịch với lượt ghi. Storage không có giao dịch.
--   3. Vài KB text là thứ Postgres giữ rẻ hơn một object.
--
-- Storage vẫn giữ media (master.mp4, transcript.json, B-roll) — thứ nặng và
-- thứ mà signed URL phục vụ tốt.

-- ------------------------------------------------------- editor_projects
--
-- Một hàng mỗi clip. `source` là `index.tsx`; `manifest` là manifest của
-- `AssetLibrary` (`packages/assets`), tức ánh xạ tên thư viện -> asset.
create table if not exists public.editor_projects (
  clip_id    uuid primary key references public.clips(id) on delete cascade,
  -- 256 KB. Một project sinh tự động là ~2 KB; trần này là để một client hỏng
  -- không nhồi được cả một bundle vào đây.
  source     text not null check (octet_length(source) < 262144),
  manifest   jsonb not null default '{"version":1,"folders":[],"assets":[]}'::jsonb
             check (pg_column_size(manifest) < 65536),
  -- Khoá lạc quan. Tăng đúng một lần mỗi lượt ghi thành công.
  version    int  not null default 1,
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------ editor_revisions
--
-- Ảnh chụp BẤT BIẾN của `source` tại lúc người dùng bấm Export. Export xếp
-- hàng trỏ vào một revision; sửa nó là đổi nội dung file mà người dùng tưởng
-- mình đã chốt. Cùng lý do, cùng khuôn với `clip_revisions`.
create table if not exists public.editor_revisions (
  id          uuid primary key default gen_random_uuid(),
  clip_id     uuid not null references public.clips(id) on delete cascade,
  number      int not null,
  source      text not null check (octet_length(source) < 262144),
  -- sha256 hex của `source`. Sinh ở client; SQL chỉ kiểm hình dạng.
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz not null default now(),
  unique (clip_id, number)
);

drop trigger if exists editor_revisions_immutable on public.editor_revisions;
create trigger editor_revisions_immutable
  before update on public.editor_revisions
  for each row execute function public.freeze_clip_revision();

-- "Revision mới nhất của clip này" là câu hỏi duy nhất ai cũng hỏi.
create index if not exists editor_revisions_clip_number_idx
  on public.editor_revisions (clip_id, number desc);

-- --------------------------------------------------------------- RLS
--
-- Hai bảng con không có `user_id`: quyền đi qua `clips -> jobs.user_id`, đúng
-- khuôn `clip_revisions`. Chỉ SELECT. Mọi ghi đi qua RPC bên dưới.
alter table public.editor_projects  enable row level security;
alter table public.editor_revisions enable row level security;

drop policy if exists "đọc editor project thuộc clip của mình" on public.editor_projects;
create policy "đọc editor project thuộc clip của mình"
  on public.editor_projects for select
  to authenticated
  using (exists (
    select 1 from public.clips c
    join public.jobs j on j.id = c.job_id
    where c.id = editor_projects.clip_id
      and j.user_id = (select auth.uid())
      and j.purging_at is null
  ));

drop policy if exists "đọc editor revision thuộc clip của mình" on public.editor_revisions;
create policy "đọc editor revision thuộc clip của mình"
  on public.editor_revisions for select
  to authenticated
  using (exists (
    select 1 from public.clips c
    join public.jobs j on j.id = c.job_id
    where c.id = editor_revisions.clip_id
      and j.user_id = (select auth.uid())
      and j.purging_at is null
  ));

-- --------------------------------------------------------- editor_json
--
-- Hình dạng mà route handler trả thẳng về client. Cùng vai trò với
-- `draft_json`: một nguồn duy nhất cho "project này đang thế nào", để lượt ghi
-- và lượt đọc không bao giờ mô tả nó khác nhau.
create or replace function public.editor_json(p_clip_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'clip_id',    p.clip_id,
    'source',     p.source,
    'manifest',   p.manifest,
    'version',    p.version,
    'updated_at', p.updated_at
  )
  from public.editor_projects p
  where p.clip_id = p_clip_id;
$$;

-- ------------------------------------ get_or_create_editor_project
--
-- Lần đầu mở một clip thì chưa có project. Client (route handler) sinh TSX từ
-- clip rồi gọi hàm này; hàm chỉ ghi khi CHƯA có hàng nào.
--
-- `on conflict do nothing` chứ không `do update`: hai tab mở cùng lúc thì cả
-- hai đều sinh TSX từ cùng dữ liệu, nhưng tab thứ hai không được đè lên bản mà
-- tab thứ nhất có thể đã sửa. Ai tới trước thì bản của người đó là project.
create or replace function public.get_or_create_editor_project(
  p_clip_id uuid,
  p_source text,
  p_manifest jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_manifest jsonb := coalesce(p_manifest, '{"version":1,"folders":[],"assets":[]}'::jsonb);
begin
  if p_source is null or length(trim(p_source)) = 0 then
    raise exception 'This project has no source to start from.' using errcode = '22023';
  end if;
  if octet_length(p_source) >= 262144 then
    raise exception 'This project is too large to save.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_manifest) <> 'object' then
    raise exception 'The project manifest must be an object.' using errcode = '22023';
  end if;
  if pg_column_size(v_manifest) >= 65536 then
    raise exception 'This project has too many assets to save.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  insert into public.editor_projects (clip_id, source, manifest)
  values (p_clip_id, p_source, v_manifest)
  on conflict (clip_id) do nothing;

  return public.editor_json(p_clip_id);
end;
$$;

-- ---------------------------------------------- save_editor_project
--
-- Khoá lạc quan, khuôn của `save_draft`. Hai tab cùng mở một clip là chuyện
-- bình thường (người dùng mở lại từ lịch sử trình duyệt), và lượt ghi tới sau
-- với `version` cũ phải bị từ chối chứ không được lặng lẽ thắng.
--
-- `detail` mang theo project hiện hành để UI vẽ được "bản kia đang là gì" mà
-- không phải gọi thêm một vòng — cùng lý do như `save_draft`.
create or replace function public.save_editor_project(
  p_clip_id uuid,
  p_expected_version int,
  p_source text,
  p_manifest jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_version int;
  v_source text;
  v_manifest jsonb;
  v_next jsonb;
begin
  if p_source is null or length(trim(p_source)) = 0 then
    raise exception 'This project has no source to save.' using errcode = '22023';
  end if;
  if octet_length(p_source) >= 262144 then
    raise exception 'This project is too large to save.' using errcode = '22023';
  end if;
  if p_manifest is not null and jsonb_typeof(p_manifest) <> 'object' then
    raise exception 'The project manifest must be an object.' using errcode = '22023';
  end if;
  if p_manifest is not null and pg_column_size(p_manifest) >= 65536 then
    raise exception 'This project has too many assets to save.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  select p.version, p.source, p.manifest
    into v_version, v_source, v_manifest
  from public.editor_projects p
  where p.clip_id = p_clip_id
  for update;

  if not found then
    raise exception 'This clip has no editor project yet.' using errcode = 'P0002';
  end if;

  if v_version is distinct from p_expected_version then
    raise exception 'This clip was changed in another tab.'
      using errcode = 'P0409', detail = public.editor_json(p_clip_id)::text;
  end if;

  v_next := coalesce(p_manifest, v_manifest);

  -- Không đổi gì thì không tăng `version`. Autosave bắn lại cùng nội dung sau
  -- một lượt `visibilitychange` là chuyện thường, và mỗi lượt như thế mà tăng
  -- version thì tab kia bị đá ra vì một thay đổi không tồn tại.
  if v_source = p_source and v_manifest = v_next then
    return public.editor_json(p_clip_id);
  end if;

  update public.editor_projects
  set source = p_source,
      manifest = v_next,
      version = v_version + 1,
      updated_at = now()
  where clip_id = p_clip_id;

  return public.editor_json(p_clip_id);
end;
$$;

-- ------------------------------------------ snapshot_editor_revision
--
-- Chụp `source` hiện hành thành một revision bất biến. Client tính hash (JCS
-- không liên quan ở đây — `source` là text thuần, sha256 thẳng trên UTF-8) và
-- gửi kèm; SQL đối chiếu nó với những gì đang có để một client lệch phiên bản
-- không chụp nhầm bản khác với bản nó vừa render.
--
-- Cùng hash với revision mới nhất thì trả lại chính nó: bấm Export hai lần
-- không được đẻ ra hai revision y hệt.
create or replace function public.snapshot_editor_revision(
  p_clip_id uuid,
  p_source_hash text
)
returns public.editor_revisions
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_source text;
  v_latest public.editor_revisions;
  v_revision public.editor_revisions;
begin
  if p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid project fingerprint.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  -- Khoá hàng project: lượt chụp và lượt ghi tiếp theo không được xen kẽ, nếu
  -- không thì revision mang một `source` mà hash gửi lên không mô tả.
  select p.source into v_source
  from public.editor_projects p
  where p.clip_id = p_clip_id
  for update;

  if not found then
    raise exception 'This clip has no editor project yet.' using errcode = 'P0002';
  end if;

  -- `sha256()` là hàm lõi của Postgres (pg_catalog, từ PG11), không phải
  -- pgcrypto: hàm này `set search_path = public` nên `extensions.digest` sẽ
  -- không phân giải được ở đây.
  if encode(sha256(convert_to(v_source, 'UTF8')), 'hex') <> p_source_hash then
    raise exception 'This project changed while it was being exported. Try again.'
      using errcode = 'P0409', detail = public.editor_json(p_clip_id)::text;
  end if;

  select r.* into v_latest
  from public.editor_revisions r
  where r.clip_id = p_clip_id
  order by r.number desc
  limit 1;

  if found and v_latest.source_hash = p_source_hash then
    return v_latest;
  end if;

  insert into public.editor_revisions (clip_id, number, source, source_hash)
  values (p_clip_id, coalesce(v_latest.number, 0) + 1, v_source, p_source_hash)
  returning * into v_revision;

  return v_revision;
end;
$$;

revoke execute on function public.editor_json(uuid) from public, anon;
revoke execute on function public.get_or_create_editor_project(uuid, text, jsonb) from public, anon;
revoke execute on function public.save_editor_project(uuid, int, text, jsonb) from public, anon;
revoke execute on function public.snapshot_editor_revision(uuid, text) from public, anon;

grant execute on function public.get_or_create_editor_project(uuid, text, jsonb) to authenticated;
grant execute on function public.save_editor_project(uuid, int, text, jsonb) to authenticated;
grant execute on function public.snapshot_editor_revision(uuid, text) to authenticated;

-- ------------------------------------------------- bucket `editor-write`
--
-- `rate_limit_hit` là một ALLOWLIST, không phải một bộ đếm tổng quát: bộ tham
-- số nào không có ở đây thì hàm raise `'Invalid rate limit.'`. Thêm bucket mới
-- mà quên chỗ này là route handler chết ngay lượt gọi đầu.
--
-- 240 lượt / 60 giây: autosave debounce 2 giây, nên một tab sửa liên tục cả
-- phút là ~30 lượt. Trần này chịu được tám tab như thế, và vẫn chặn được một
-- client hỏng bắn mỗi keystroke.
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
      or (p_bucket = 'media' and p_limit = 60 and p_window_seconds = 3600);
  end if;

  if not v_allowed then
    raise exception 'Invalid rate limit.' using errcode = '22023';
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

revoke execute on function public.rate_limit_hit(text, int, int) from public, anon;
grant execute on function public.rate_limit_hit(text, int, int) to authenticated;
