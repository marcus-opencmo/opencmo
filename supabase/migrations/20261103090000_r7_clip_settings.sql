-- R7 (lộ trình dọn hệ video, việc dời từ R1): bỏ `clip_drafts`, `clip_revisions`, `presets`.
--
-- Từ R1 không còn đường nào ghi revision thứ hai: `save_draft` đã gỡ, sửa clip là việc của
-- editor (`editor_projects`/`editor_revisions`). Hai bảng chỉ còn chở MỘT bộ settings gốc
-- mỗi clip (revision #1) cho bộ sinh project editor và transcript — một con trỏ + một bảng
-- bất biến cho một giá trị ghi một lần. Giá trị đó về ở chính hàng clip: `clips.settings`.
--
-- `presets`: không còn chỗ nào trong app tạo preset từ 01/10 (Brand kit thay thế).
--
-- Ba RPC worker (`complete_job_publication`, `create_clip_drafts`, `complete_full_edit`) GIỮ
-- tên và tham số: worker đang chạy trên Modal gọi đúng chữ ký này, nên `db push` trước hay
-- sau `modal deploy` đều không làm gãy job. Chỉ ruột đổi sang ghi `clips.settings`.
-- Luật "không ghi đè bản đã có" giữ nguyên: `settings is null` thay cho "chưa có draft".

begin;

alter table public.clips
  add column settings jsonb,
  add column settings_hash text,
  add constraint clips_settings_size_check check (settings is null or pg_column_size(settings) < 65536),
  -- `coalesce`: `null ~ '…'` là NULL, và CHECK coi NULL là đạt — thiếu nó thì settings
  -- không hash lọt qua.
  add constraint clips_settings_hash_check check (
    (settings is null and settings_hash is null)
    or (jsonb_typeof(settings) = 'object' and coalesce(settings_hash ~ '^[0-9a-f]{64}$', false))
  );

update public.clips c
set settings = r.settings, settings_hash = r.settings_hash
from public.clip_drafts d
join public.clip_revisions r on r.id = d.revision_id
where d.clip_id = c.id;

-- Không còn task nào mang revision settings từ R1 (export đi qua `editor_revision_id`).
alter table public.tasks drop column revision_id;

create or replace function public.complete_job_publication(p_job_id uuid, p_attempt_id uuid, p_title text, p_duration_seconds numeric, p_clips jsonb, p_revisions jsonb, p_manifest jsonb)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $_$
declare
  v_job public.jobs;
  v_previous jsonb;
begin
  -- Khoá hàng job trước mọi kiểm tra: reclaim/cancel chạy song song phải chờ,
  -- không thì attempt có thể bị requeue giữa lúc đang chèn clip.
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or p_attempt_id is null then
    return false;
  end if;

  -- Fence đứng TRƯỚC validate: attempt cũ về muộn chỉ nhận false, không được
  -- làm worker tưởng mình gửi dữ liệu hỏng.
  if v_job.status = 'done' and v_job.attempt_id = p_attempt_id then
    return true;
  end if;
  if v_job.status <> 'running' or v_job.attempt_id is distinct from p_attempt_id then
    return false;
  end if;

  if p_clips is null or jsonb_typeof(p_clips) <> 'array' then
    raise exception 'Clips must be a list.' using errcode = '22023';
  end if;
  if p_revisions is null or jsonb_typeof(p_revisions) <> 'array' then
    raise exception 'Revisions must be a list.' using errcode = '22023';
  end if;
  if p_manifest is null or jsonb_typeof(p_manifest) <> 'object' then
    raise exception 'The media manifest must be an object.' using errcode = '22023';
  end if;

  -- Kiểm hình dạng trước khi ép kiểu: lỗi cast uuid/numeric của Postgres là
  -- message kỹ thuật, không nên lọt ra màn hình.
  if exists (
    select 1 from jsonb_array_elements(p_clips) c
    where jsonb_typeof(c) <> 'object'
       or coalesce(c ->> 'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       or jsonb_typeof(c -> 'idx') is distinct from 'number'
       or (c ->> 'idx') !~ '^[0-9]{1,6}$'
       or jsonb_typeof(c -> 'start_seconds') is distinct from 'number'
       or jsonb_typeof(c -> 'end_seconds') is distinct from 'number'
  ) then
    raise exception 'A clip is missing required fields.' using errcode = '22023';
  end if;

  -- Bảng có check `source_end > source_start`, nhưng message constraint là chữ
  -- kỹ thuật; chặn ở đây để lỗi hiện ra còn đọc được.
  if exists (
    select 1 from jsonb_array_elements(p_clips) c
    where (c ->> 'end_seconds')::numeric <= (c ->> 'start_seconds')::numeric
  ) then
    raise exception 'A clip must end after it starts.' using errcode = '22023';
  end if;

  if (select count(distinct c ->> 'id') <> count(*) or count(distinct (c ->> 'idx')::int) <> count(*)
      from jsonb_array_elements(p_clips) c) then
    raise exception 'Clips must have unique ids and positions.' using errcode = '22023';
  end if;

  -- Không thay thế âm thầm clip cũ ở cùng vị trí: editor/task đang trỏ vào id cũ
  -- sẽ thành mồ côi hoặc bị cascade xoá mất lịch sử sửa của người dùng.
  if exists (
    select 1
    from jsonb_array_elements(p_clips) c
    join public.clips old
      on (old.job_id = p_job_id and old.idx = (c ->> 'idx')::int and old.id <> (c ->> 'id')::uuid)
      or (old.id = (c ->> 'id')::uuid and (old.job_id <> p_job_id or old.idx <> (c ->> 'idx')::int))
  ) then
    raise exception 'A different clip already exists at this position.' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_revisions) r
    where jsonb_typeof(r) <> 'object'
       or jsonb_typeof(r -> 'settings') is distinct from 'object'
       or coalesce(r ->> 'settings_hash', '') !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'Clip settings are invalid.' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_revisions) r
    where not exists (
      select 1 from jsonb_array_elements(p_clips) c where c ->> 'id' = r ->> 'clip_id'
    )
  ) then
    raise exception 'A revision points to a clip that is not being published.' using errcode = '22023';
  end if;

  if (select count(distinct r ->> 'clip_id') <> count(*) from jsonb_array_elements(p_revisions) r) then
    raise exception 'Each clip can have only one starting revision.' using errcode = '22023';
  end if;

  -- Biên nhận khác đầu vào nghĩa là cùng attempt đã ghi settings bằng dữ liệu
  -- khác — ghi tiếp là để hai phiên bản sự thật cùng tồn tại.
  select revisions into v_previous from public.worker_draft_initializations
  where job_id = p_job_id and attempt_id = p_attempt_id;
  if found and v_previous is distinct from p_revisions then
    raise exception 'Drafts were already initialized with different content.' using errcode = '22023';
  end if;

  insert into public.clips (
    id, job_id, idx, hook, start_seconds, end_seconds, score, reason,
    storage_path, preview_path, source_start, source_end
  )
  select (c ->> 'id')::uuid, p_job_id, (c ->> 'idx')::int, c ->> 'hook',
         (c ->> 'start_seconds')::numeric, (c ->> 'end_seconds')::numeric,
         (c ->> 'score')::numeric, c ->> 'reason', c ->> 'storage_path', c ->> 'preview_path',
         (c ->> 'start_seconds')::numeric, (c ->> 'end_seconds')::numeric
  from jsonb_array_elements(p_clips) c
  where not exists (select 1 from public.clips old where old.id = (c ->> 'id')::uuid);

  -- Settings gốc ghi một lần: clip đã có (attempt trước đã công bố) giữ nguyên.
  update public.clips c
  set settings = r -> 'settings', settings_hash = r ->> 'settings_hash'
  from jsonb_array_elements(p_revisions) r
  where c.id = (r ->> 'clip_id')::uuid and c.settings is null;

  if v_previous is null then
    insert into public.worker_draft_initializations (job_id, attempt_id, revisions)
    values (p_job_id, p_attempt_id, p_revisions);
  end if;

  update public.jobs
  set media_manifest = p_manifest,
      title = p_title,
      duration_seconds = p_duration_seconds,
      status = 'done',
      finished_at = now(),
      lease_until = null
  where id = p_job_id;

  return true;
end;
$_$;

create or replace function public.create_clip_drafts(p_job_id uuid, p_attempt_id uuid, p_revisions jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_job public.jobs;
  v_previous jsonb;
  v_created int;
begin
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or p_attempt_id is null or v_job.attempt_id is distinct from p_attempt_id
     or v_job.status not in ('running', 'done') then
    raise exception 'This processing attempt is no longer active.' using errcode = 'P0001';
  end if;
  if p_revisions is null or jsonb_typeof(p_revisions) <> 'array' then
    raise exception 'Revisions must be an array.' using errcode = '22023';
  end if;
  select revisions into v_previous from public.worker_draft_initializations
  where job_id = p_job_id and attempt_id = p_attempt_id;
  if found then
    if v_previous is distinct from p_revisions then
      raise exception 'Drafts were already initialized with different content.' using errcode = '22023';
    end if;
    return 0;
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_revisions) item
    where not exists (select 1 from public.clips c
      where c.id = (item ->> 'clip_id')::uuid and c.job_id = p_job_id)
  ) then
    raise exception 'A clip does not belong to this project.' using errcode = '22023';
  end if;
  -- Trước đây constraint của `clip_revisions` chặn hash sai; giờ kiểm ở đây để lỗi
  -- còn đọc được.
  if exists (
    select 1 from jsonb_array_elements(p_revisions) item
    where jsonb_typeof(item -> 'settings') is distinct from 'object'
       or coalesce(item ->> 'settings_hash', '') !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'Clip settings are invalid.' using errcode = '22023';
  end if;
  update public.clips c
  set settings = item -> 'settings', settings_hash = item ->> 'settings_hash'
  from jsonb_array_elements(p_revisions) item
  where c.id = (item ->> 'clip_id')::uuid and c.settings is null;
  get diagnostics v_created = row_count;
  insert into public.worker_draft_initializations values (p_job_id, p_attempt_id, p_revisions);
  return v_created;
end;
$$;

create or replace function public.complete_full_edit(p_task_id uuid, p_attempt_id uuid, p_settings jsonb, p_settings_hash text, p_master jsonb)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $_$
declare
  v_task public.tasks;
begin
  select * into v_task from public.tasks
  where id = p_task_id and kind = 'prepare_full' and status = 'running'
    and attempt_id is not distinct from p_attempt_id
  for update;
  if not found then
    return exists (select 1 from public.tasks where id = p_task_id and status = 'done' and attempt_id is not distinct from p_attempt_id);
  end if;
  if not exists (select 1 from public.clips where id = v_task.clip_id and job_id = v_task.job_id and kind = 'full') then
    raise exception 'Full-video clip mismatch.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_settings) is distinct from 'object' or coalesce(p_settings_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Clip settings are invalid.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_master) is distinct from 'object' or coalesce(p_master ->> 'object', '') = '' then
    raise exception 'Master is invalid.' using errcode = '22023';
  end if;

  update public.clips
  set settings = p_settings, settings_hash = p_settings_hash
  where id = v_task.clip_id and settings is null;

  update public.jobs
  set media_manifest = jsonb_set(
    coalesce(media_manifest, '{}'::jsonb) || jsonb_build_object('masters', coalesce(media_manifest -> 'masters', '{}'::jsonb)),
    array['masters', v_task.clip_id::text],
    p_master
  )
  where id = v_task.job_id;

  update public.tasks
  set status = 'done', error = null, finished_at = now(), lease_until = null
  where id = p_task_id;
  return true;
end;
$_$;

create or replace function public.create_full_edit(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := public.require_user();
  v_job public.jobs;
  v_clip public.clips;
  v_task public.tasks;
  v_ready boolean;
begin
  select * into v_job from public.jobs where id = p_job_id and user_id = v_user;
  if not found then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if coalesce(v_job.source_url, '') not like 'storage://%' then
    raise exception 'Full-video editing works on videos you uploaded. For a link, edit the clips.' using errcode = '22023';
  end if;
  if v_job.status <> 'done' or v_job.duration_seconds is null or v_job.duration_seconds <= 0 then
    raise exception 'Wait for the video to finish processing.' using errcode = 'P0001';
  end if;
  if v_job.duration_seconds > public.full_edit_max_seconds() then
    raise exception 'Full-video editing supports videos up to % minutes.', public.full_edit_max_seconds() / 60
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_job_id::text, 2201));
  select * into v_clip from public.clips where job_id = p_job_id and kind = 'full';
  if not found then
    insert into public.clips (job_id, idx, hook, start_seconds, end_seconds, source_start, source_end, kind)
    values (p_job_id, -1, 'Full video', 0, v_job.duration_seconds, 0, v_job.duration_seconds, 'full')
    returning * into v_clip;
  end if;

  v_ready := (v_job.media_manifest -> 'masters' -> (v_clip.id::text)) is not null
    and v_clip.settings is not null;
  if v_ready then
    return jsonb_build_object('clip_id', v_clip.id, 'ready', true, 'task_id', null);
  end if;

  select * into v_task from public.tasks
  where clip_id = v_clip.id and kind = 'prepare_full' and status in ('queued', 'running')
  order by created_at desc limit 1;
  if not found then
    insert into public.tasks (user_id, kind, clip_id, job_id, payload, status, request_id)
    values (v_user, 'prepare_full', v_clip.id, p_job_id, '{}'::jsonb, 'queued', gen_random_uuid())
    returning * into v_task;
  end if;
  return jsonb_build_object('clip_id', v_clip.id, 'ready', false, 'task_id', v_task.id);
end;
$$;

drop function public.draft_json(uuid);
drop function public.save_preset(text, jsonb);
drop function public.delete_preset(uuid);
drop table public.clip_drafts;
-- `freeze_clip_revision()` ở lại: trigger `editor_revisions_immutable` dùng chung hàm đó.
drop table public.clip_revisions;
drop table public.presets;

commit;
