-- 20261022090000: Edit full video (E2-c).
--
-- Editor từng chỉ mở cửa sổ của MỘT clip (master cắt ±1 s quanh khoảnh khắc). Chế độ
-- này cho video UPLOAD mở cả file: một hàng `clips` đặc biệt (`kind = 'full'`,
-- `idx = -1`) để mọi thứ khoá theo clip — `editor_projects`, `render_document`,
-- `media_manifest.masters[clip]` — dùng lại nguyên vẹn. Link YouTube không có chế độ
-- này: phải tải nguyên video gốc (luật 3, chỉ tải đúng đoạn đã chọn).
--
-- Worker task `prepare_full`: remux nguyên upload (`-c copy`, không giải mã) thành
-- master, transcript cả video, rồi `complete_full_edit` công bố revision #1 + draft +
-- master trong MỘT giao dịch.

begin;

alter table public.clips
  add column if not exists kind text not null default 'moment';
alter table public.clips drop constraint if exists clips_kind_check;
alter table public.clips add constraint clips_kind_check check (kind in ('moment', 'full'));
-- Mỗi job tối đa một clip `full`.
create unique index if not exists clips_one_full_idx on public.clips (job_id) where kind = 'full';

alter table public.tasks drop constraint tasks_kind_check;
alter table public.tasks
  add constraint tasks_kind_check
  check (kind in ('preview', 'export', 'probe_media', 'zip', 'client_export', 'finalize', 'generate',
                  'render_document', 'prepare_full'));

/** Trần thời lượng của chế độ cả video (giây) — theo số đo export ở note.md 04/10. */
create or replace function public.full_edit_max_seconds()
returns int language sql immutable as $$ select 900 $$;

-- Người dùng bấm "Edit full video". Idempotent: gọi lại trả clip đã có (và task đang
-- chạy nếu chưa xong). Trả {clip_id, ready, task_id}.
create or replace function public.create_full_edit(p_job_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
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
    and exists (select 1 from public.clip_drafts d where d.clip_id = v_clip.id);
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

revoke all on function public.create_full_edit(uuid) from public, anon;
grant execute on function public.create_full_edit(uuid) to authenticated;

-- Worker công bố: revision #1 + draft (nếu clip chưa có) + master + xong task, một giao dịch.
create or replace function public.complete_full_edit(
  p_task_id uuid,
  p_attempt_id uuid,
  p_settings jsonb,
  p_settings_hash text,
  p_master jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_task public.tasks;
  v_revision uuid;
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

  if not exists (select 1 from public.clip_drafts where clip_id = v_task.clip_id) then
    insert into public.clip_revisions (clip_id, number, settings, settings_hash)
    values (v_task.clip_id, coalesce((select max(number) from public.clip_revisions where clip_id = v_task.clip_id), 0) + 1, p_settings, p_settings_hash)
    returning id into v_revision;
    insert into public.clip_drafts (clip_id, revision_id) values (v_task.clip_id, v_revision);
  end if;

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
$$;

revoke all on function public.complete_full_edit(uuid, uuid, jsonb, text, jsonb) from public, anon, authenticated;

commit;
