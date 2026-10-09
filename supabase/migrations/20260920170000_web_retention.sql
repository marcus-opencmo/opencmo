-- D4 retention: dọn theo THAM CHIẾU trong database, không theo tên file trong bucket.
--
-- Bản cũ chỉ biết hai cột `clips.storage_path`/`preview_path` và một lượt quét
-- bucket `sources`. Từ D2 tới nay mỗi project còn để lại: cache section và proxy
-- editor (`sources/<uid>/<job>/sections|proxy/…`), output render/ZIP/srt/txt
-- (`renders/<uid>/<clip>/<task>/<attempt>/…`), B-roll (`media/<uid>/<job>/…`) và
-- object của attempt thua. Không cái nào nằm trong hai cột đó.
--
-- Thứ tự an toàn duy nhất là: GHI manifest xoá xuống đĩa TRƯỚC, xoá file sau,
-- xoá hàng sau cùng. Ngược lại thì một lần lỗi giữa chừng là mất dấu đường dẫn
-- và file nằm lại trong bucket vĩnh viễn mà không ai biết nó thuộc về ai.

begin;

-- ======================================================== tombstone project
--
-- `purging_at` là cổng: đặt xong thì project biến mất khỏi mọi truy vấn của
-- người dùng (policy bên dưới), nên không ai ký được URL mới, enqueue được
-- render mới hay claim được task mới trong lúc file đang bị xoá.
alter table public.jobs add column purging_at timestamptz;

create index jobs_expiry_sweep_idx on public.jobs (expires_at, id) where purging_at is null;

-- ================================================== manifest xoá bền vững
--
-- KHÔNG có foreign key tới jobs/auth.users: hàng ở đây phải sống sót đúng cái
-- cascade đã sinh ra nó. Xoá tài khoản là lúc dễ mất dấu file nhất — job, clip,
-- task biến mất trong một transaction, và nếu đường dẫn chỉ nằm trong chúng thì
-- vài GB video ở lại bucket mà không còn gì trỏ tới.
create table public.storage_deletions (
  id         bigserial primary key,
  bucket     text not null check (bucket in ('clips', 'sources', 'renders', 'media')),
  path       text not null check (path <> '' and path not like '%..%'),
  job_id     uuid,
  user_id    uuid,
  -- Một object xoá hỏng mãi không được chặn đầu hàng đợi của những cái khác.
  attempts   int not null default 0,
  queued_at  timestamptz not null default now(),
  unique (bucket, path)
);

create index storage_deletions_work_idx on public.storage_deletions (attempts, id);
create index storage_deletions_job_idx on public.storage_deletions (job_id);

alter table public.storage_deletions enable row level security;
revoke all on public.storage_deletions from public, anon, authenticated;
grant all on public.storage_deletions to service_role;
grant usage, select on sequence public.storage_deletions_id_seq to service_role;

-- ================================================ thu thập đường dẫn
--
-- Một chỗ duy nhất biết project để lại những gì. Dùng ở hai nơi: lúc tombstone
-- project hết hạn, và trong trigger before-delete cho đường xoá tay/cascade.
create or replace function public.enqueue_job_objects(p_job_id uuid)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_rows int;
begin
  select * into v_job from public.jobs where id = p_job_id;
  if not found then return 0; end if;

  insert into public.storage_deletions (bucket, path, job_id, user_id)
  select found_path.bucket, found_path.path, p_job_id, v_job.user_id
  from (
    -- Clip đã công bố.
    select 'clips'::text as bucket, c.storage_path as path
      from public.clips c where c.job_id = p_job_id
    union
    select 'clips', c.preview_path from public.clips c where c.job_id = p_job_id
    union
    -- Manifest task: mp4 + srt/txt + ZIP. `output_path` đi kèm cho attempt đã
    -- upload xong nhưng chưa kịp ghi manifest.
    select coalesce(entry.value->>'bucket', 'renders'), entry.value->>'object'
      from public.tasks t
      left join public.clips c on c.id = t.clip_id
      cross join lateral jsonb_each(
        case when jsonb_typeof(t.output->'manifest'->'files') = 'object'
             then t.output->'manifest'->'files' else '{}'::jsonb end) entry
     where t.job_id = p_job_id or c.job_id = p_job_id
    union
    select coalesce(section.value->>'bucket', 'sources'), section.value->>'object'
      from public.tasks t
      left join public.clips c on c.id = t.clip_id
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(t.output->'manifest'->'sections') = 'array'
             then t.output->'manifest'->'sections' else '[]'::jsonb end) section
     where t.job_id = p_job_id or c.job_id = p_job_id
    union
    select 'renders', t.output_path
      from public.tasks t
      left join public.clips c on c.id = t.clip_id
     where t.job_id = p_job_id or c.job_id = p_job_id
    union
    -- B-roll: `storage_path` lưu kèm tên bucket ở segment đầu ('media/<uid>/…').
    select 'media', substring(m.storage_path from 7)
      from public.media_assets m
     where m.job_id = p_job_id and m.storage_path like 'media/%'
    union
    -- Cache section và proxy editor đã công bố của chính job.
    select coalesce(section.value->>'bucket', 'sources'), section.value->>'object'
      from jsonb_array_elements(
        case when jsonb_typeof(v_job.media_manifest->'sections') = 'array'
             then v_job.media_manifest->'sections' else '[]'::jsonb end) section
    union
    select coalesce(proxy.value->>'bucket', 'sources'), proxy.value->>'object'
      from jsonb_each(
        case when jsonb_typeof(v_job.media_manifest->'proxies') = 'object'
             then v_job.media_manifest->'proxies' else '{}'::jsonb end) proxy
    union
    -- Nguồn upload. Link YouTube không có object nào để xoá.
    select 'sources', substring(v_job.source_url from 11)
     where v_job.source_url like 'storage://%'
  ) as found_path
  where found_path.path is not null
    and found_path.path <> ''
    and found_path.path not like '%..%'
    and found_path.bucket in ('clips', 'sources', 'renders', 'media')
  on conflict (bucket, path) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- ================================= trigger: ghi manifest trước mọi cascade
--
-- Xoá tài khoản cascade song song vào `jobs`, `tasks` và `media_assets` — thứ
-- tự giữa các nhánh không được bảo đảm, nên mỗi bảng phải tự ghi phần của mình
-- thay vì trông chờ trigger của `jobs` chạy trước.
--
-- Bỏ qua khi project đã tombstone: lúc đó manifest đã ghi và file đã xoá xong
-- (purge chỉ chạy khi hàng đợi của project đã rỗng), ghi lại là dựng dậy rác
-- đã dọn và xoá nhầm file trùng tên của project sau.
--
-- Không thể hỏi `jobs.purging_at` từ trigger của bảng con: trong một cascade,
-- hàng cha đã bị xoá TRƯỚC khi trigger của con chạy, nên câu hỏi luôn trả
-- "không purging" và mọi đường dẫn bị ghi lại. Cờ transaction-local do
-- `purge_expired_jobs` đặt là thứ duy nhất sống đúng phạm vi cần thiết.
create or replace function public.purge_in_progress()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('opencmo.purge', true), '') = 'on';
$$;

create or replace function public.record_job_storage_deletions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.purge_in_progress() then
    insert into public.storage_deletions (bucket, path, job_id, user_id)
    select source.bucket, source.path, old.id, old.user_id
    from (
      select coalesce(section.value->>'bucket', 'sources') as bucket, section.value->>'object' as path
        from jsonb_array_elements(
          case when jsonb_typeof(old.media_manifest->'sections') = 'array'
               then old.media_manifest->'sections' else '[]'::jsonb end) section
      union
      select coalesce(proxy.value->>'bucket', 'sources'), proxy.value->>'object'
        from jsonb_each(
          case when jsonb_typeof(old.media_manifest->'proxies') = 'object'
               then old.media_manifest->'proxies' else '{}'::jsonb end) proxy
      union
      select 'sources', substring(old.source_url from 11) where old.source_url like 'storage://%'
    ) as source
    where source.path is not null and source.path <> '' and source.path not like '%..%'
      and source.bucket in ('clips', 'sources', 'renders', 'media')
    on conflict (bucket, path) do nothing;
  end if;
  return old;
end;
$$;

create or replace function public.record_clip_storage_deletions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.purge_in_progress() then
    insert into public.storage_deletions (bucket, path, job_id)
    select 'clips', p, old.job_id
    from unnest(array[old.storage_path, old.preview_path]) as p
    where p is not null and p <> '' and p not like '%..%'
    on conflict (bucket, path) do nothing;
  end if;
  return old;
end;
$$;

create or replace function public.record_task_storage_deletions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_job uuid;
begin
  if public.purge_in_progress() then return old; end if;
  v_job := old.job_id;
  if v_job is null and old.clip_id is not null then
    select c.job_id into v_job from public.clips c where c.id = old.clip_id;
  end if;

  insert into public.storage_deletions (bucket, path, job_id, user_id)
  select source.bucket, source.path, v_job, old.user_id
  from (
    select coalesce(entry.value->>'bucket', 'renders') as bucket, entry.value->>'object' as path
      from jsonb_each(
        case when jsonb_typeof(old.output->'manifest'->'files') = 'object'
             then old.output->'manifest'->'files' else '{}'::jsonb end) entry
    union
    select coalesce(section.value->>'bucket', 'sources'), section.value->>'object'
      from jsonb_array_elements(
        case when jsonb_typeof(old.output->'manifest'->'sections') = 'array'
             then old.output->'manifest'->'sections' else '[]'::jsonb end) section
    union
    select 'renders', old.output_path
  ) as source
  where source.path is not null and source.path <> '' and source.path not like '%..%'
    and source.bucket in ('clips', 'sources', 'renders', 'media')
  on conflict (bucket, path) do nothing;
  return old;
end;
$$;

create or replace function public.record_media_storage_deletions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.purge_in_progress() and old.storage_path like 'media/%' then
    insert into public.storage_deletions (bucket, path, job_id, user_id)
    values ('media', substring(old.storage_path from 7), old.job_id, old.user_id)
    on conflict (bucket, path) do nothing;
  end if;
  return old;
end;
$$;

drop trigger if exists jobs_record_storage_deletions on public.jobs;
create trigger jobs_record_storage_deletions
  before delete on public.jobs
  for each row execute function public.record_job_storage_deletions();

drop trigger if exists clips_record_storage_deletions on public.clips;
create trigger clips_record_storage_deletions
  before delete on public.clips
  for each row execute function public.record_clip_storage_deletions();

drop trigger if exists tasks_record_storage_deletions on public.tasks;
create trigger tasks_record_storage_deletions
  before delete on public.tasks
  for each row execute function public.record_task_storage_deletions();

drop trigger if exists media_assets_record_storage_deletions on public.media_assets;
create trigger media_assets_record_storage_deletions
  before delete on public.media_assets
  for each row execute function public.record_media_storage_deletions();

-- ============================================================ vòng dọn
--
-- Cursor là `(attempts, id)` của hàng đợi, không phải offset: hàng đã xác nhận
-- xoá thì biến mất, nên mỗi lượt gọi luôn tiến lên. Lô thất bại bị đẩy xuống
-- cuối bằng `attempts` thay vì chặn đầu hàng đợi mãi mãi.
create or replace function public.expired_object_paths(p_limit int default 200)
returns table (id bigint, bucket text, path text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_job uuid;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'Invalid cleanup batch size.' using errcode = '22023';
  end if;

  -- Job `queued/running` không nằm trong danh sách: worker có thể đang ghi vào
  -- đúng những object này. Job treo được reconciler chuyển sang `failed` trước,
  -- rồi mới tới lượt retention — không có đường tắt.
  for v_job in
    with due as (
      select j.id
      from public.jobs j
      where j.purging_at is null
        and j.expires_at < now()
        and j.status::text in ('done', 'failed', 'cancelled')
        and not exists (
          select 1
          from public.tasks t
          left join public.clips c on c.id = t.clip_id
          where (t.job_id = j.id or c.job_id = j.id)
            and t.status in ('queued', 'running')
        )
      order by j.expires_at, j.id
      limit p_limit
      for update skip locked
    ),
    marked as (
      update public.jobs j set purging_at = now()
      from due where j.id = due.id
      returning j.id
    )
    select marked.id from marked
  loop
    perform public.enqueue_job_objects(v_job);
  end loop;

  return query
    select d.id, d.bucket, d.path
    from public.storage_deletions d
    order by d.attempts, d.id
    limit p_limit;
end;
$$;

create or replace function public.confirm_object_deletions(p_ids bigint[])
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_rows int;
begin
  if p_ids is null or array_length(p_ids, 1) is null then return 0; end if;
  delete from public.storage_deletions where id = any(p_ids);
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

create or replace function public.defer_object_deletions(p_ids bigint[])
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_rows int;
begin
  if p_ids is null or array_length(p_ids, 1) is null then return 0; end if;
  update public.storage_deletions set attempts = attempts + 1 where id = any(p_ids);
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Chỉ xoá hàng sau khi HÀNG ĐỢI của project đã rỗng. Một object chưa xoá được
-- là một lý do đủ để giữ nguyên project thêm một lượt cron.
create or replace function public.purge_expired_jobs(p_job_ids uuid[] default null)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_rows int;
begin
  -- Cờ này tắt trigger ghi manifest cho ĐÚNG transaction purge: đường dẫn đã
  -- nằm trong hàng đợi từ lúc tombstone và đã được xác nhận xoá xong.
  perform set_config('opencmo.purge', 'on', true);
  delete from public.jobs j
  where j.purging_at is not null
    and (p_job_ids is null or j.id = any(p_job_ids))
    and not exists (select 1 from public.storage_deletions d where d.job_id = j.id);
  get diagnostics v_rows = row_count;
  -- Trả cờ về ngay sau lệnh xoá: mọi trigger cascade đã chạy xong, và hàm này
  -- có thể được gọi giữa một transaction còn làm việc khác sau đó.
  perform set_config('opencmo.purge', 'off', true);
  return v_rows;
end;
$$;

-- Cửa sổ rate limit dài nhất là 86400 giây; hai ngày là đủ rộng để không bao giờ
-- xoá một cửa sổ còn đang được đếm.
create or replace function public.purge_stale_rate_limits()
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_rows int;
begin
  delete from public.rate_limits where window_start < now() - interval '2 days';
  get diagnostics v_rows = row_count;
  delete from public.upload_reservations
   where status = 'reserved' and expires_at < now() - interval '1 day';
  return v_rows;
end;
$$;

-- ====================================== danh sách giữ lại cho orphan sweep
--
-- Quét bucket là đường DUY NHẤT tìm được file mà database chưa bao giờ biết tới
-- (upload bỏ ngang). Vì vậy nó cũng là đường duy nhất xoá nhầm được file của
-- người đang dùng — danh sách "đang còn dùng" phải do SQL trả, không ghép ở
-- route, và phải gồm cả reservation chưa upload xong.
create or replace function public.orphan_keep_paths(p_bucket text)
returns table (path text)
language sql
stable
security definer
set search_path = public
as $$
  select r.object_name
    from public.upload_reservations r
   where r.bucket = p_bucket and r.expires_at > now() - interval '1 day'
  union
  select s.path from public.live_source_paths() s where p_bucket = 'sources'
  union
  select substring(m.storage_path from 7)
    from public.media_assets m
   where p_bucket = 'media' and m.storage_path like 'media/%';
$$;

-- =========================================== quyền: chỉ cron/worker gọi được
do $$
declare f text;
begin
  foreach f in array array[
    'public.enqueue_job_objects(uuid)',
    'public.expired_object_paths(int)',
    'public.confirm_object_deletions(bigint[])',
    'public.defer_object_deletions(bigint[])',
    'public.purge_expired_jobs(uuid[])',
    'public.purge_stale_rate_limits()',
    'public.orphan_keep_paths(text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

revoke execute on function public.record_job_storage_deletions() from public, anon, authenticated;
revoke execute on function public.record_clip_storage_deletions() from public, anon, authenticated;
revoke execute on function public.record_task_storage_deletions() from public, anon, authenticated;
revoke execute on function public.record_media_storage_deletions() from public, anon, authenticated;

-- ================== project đang bị xoá biến mất khỏi mọi truy vấn người dùng
--
-- Đây là cách rẻ nhất để đạt "mọi signed URL, render và enqueue từ chối project
-- hết hạn/tombstone": bốn route ký URL đều đọc qua phiên của người dùng, nên
-- một policy là đủ cho cả bốn, thay vì bốn lần nhớ viết cùng một câu `where`.
drop policy if exists "đọc job của chính mình" on public.jobs;
create policy "đọc job của chính mình"
  on public.jobs for select
  using (auth.uid() = user_id and purging_at is null);

drop policy if exists "đọc clip thuộc job của mình" on public.clips;
create policy "đọc clip thuộc job của mình"
  on public.clips for select
  using (exists (
    select 1 from public.jobs j
    where j.id = clips.job_id and j.user_id = auth.uid() and j.purging_at is null
  ));

drop policy if exists "đọc task của chính mình" on public.tasks;
create policy "đọc task của chính mình"
  on public.tasks for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and not exists (
      select 1 from public.jobs j where j.id = tasks.job_id and j.purging_at is not null
    )
    and not exists (
      select 1 from public.clips c
      join public.jobs j on j.id = c.job_id
      where c.id = tasks.clip_id and j.purging_at is not null
    )
  );

drop policy if exists "đọc B-roll của chính mình" on public.media_assets;
create policy "đọc B-roll của chính mình"
  on public.media_assets for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and not exists (
      select 1 from public.jobs j where j.id = media_assets.job_id and j.purging_at is not null
    )
  );

-- RPC chạy `security definer` nên bỏ qua policy bên trên; `owned_clip` là cổng
-- chung của mọi thao tác trên clip (draft, preview, export, zip).
create or replace function public.owned_clip(p_clip_id uuid, p_user uuid)
returns public.clips
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_clip public.clips;
begin
  select c.* into v_clip
  from public.clips c
  join public.jobs j on j.id = c.job_id
  where c.id = p_clip_id and j.user_id = p_user and j.purging_at is null;

  if not found then
    raise exception 'Clip not found.' using errcode = 'P0002';
  end if;
  return v_clip;
end;
$$;

commit;
