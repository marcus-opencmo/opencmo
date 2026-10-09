-- R7d (lộ trình dọn hệ video, phương án A): bảng `projects` — một hàng cho mỗi project
-- người dùng thấy, thay cho việc suy "đây có phải project không" từ `jobs.kind`.
--
-- Giữ nguyên hàng job/clip: `editor_projects`, `render_document`, ledger vẫn khoá theo
-- job/clip như cũ, nên đường export không đổi. Hàng được ghi bằng trigger trên `jobs`
-- thay vì sửa từng RPC tạo project: `create_job` đã có 8 bản viết lại, thêm bản thứ 9
-- chỉ để chèn một dòng là đúng thứ R6 vừa dọn. `create_video_pack` đổi `kind` sau khi
-- job đã có, trong cùng giao dịch.
--
-- Kind: `clip` (cắt clip từ video), `video_pack` (gói video của AI CMO), `edit` (New edit
-- trống). "Edit full video" là một clip trong project clip, không phải project riêng.

begin;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null unique references public.jobs (id) on delete cascade,
  kind text not null check (kind in ('clip', 'video_pack', 'edit')),
  created_at timestamptz not null default now()
);

create index projects_user_created_idx on public.projects (user_id, created_at desc, id desc);

alter table public.projects enable row level security;
create policy "đọc project của mình" on public.projects
  for select to authenticated using (user_id = (select auth.uid()));
-- Không có policy ghi: chỉ trigger và RPC security definer ghi được (luật web 1).
revoke insert, update, delete on public.projects from anon, authenticated;

create or replace function public.project_from_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.projects (user_id, job_id, kind, created_at)
  values (new.user_id, new.id, case when new.kind = 'edit' then 'edit' else 'clip' end, new.created_at)
  on conflict (job_id) do nothing;
  return new;
end;
$$;
revoke execute on function public.project_from_job() from public, anon, authenticated;

create trigger jobs_project after insert on public.jobs
  for each row execute function public.project_from_job();

-- Hàng có sẵn (production đã có dữ liệu): gói video nhận ra qua lượt CMO trỏ vào job.
insert into public.projects (user_id, job_id, kind, created_at)
select j.user_id, j.id,
  case
    when j.kind = 'edit' then 'edit'
    when exists (
      select 1 from public.cmo_runs r
      where r.kind = 'video_pack' and r.input ->> 'job_id' = j.id::text
    ) then 'video_pack'
    else 'clip'
  end,
  j.created_at
from public.jobs j
on conflict (job_id) do nothing;

-- create_video_pack: bản đang chạy + một dòng đổi kind của project vừa tạo.
create or replace function public.create_video_pack(p_source text, p_confirmed boolean default false, p_clips integer default 5)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := public.require_user();
  v_source text := trim(coalesce(p_source, ''));
  v_upload boolean := v_source like 'storage://%';
  v_job public.jobs;
  v_run public.cmo_runs;
begin
  if not v_upload and not coalesce(p_confirmed, false) then
    raise exception 'Confirm that this is your own video.' using errcode = '22023';
  end if;
  if exists (select 1 from public.cmo_runs where user_id = v_user and kind = 'video_pack' and status in ('queued', 'running')) then
    raise exception 'Your last video pack is still being made.' using errcode = 'P0001';
  end if;
  v_job := public.create_job(v_source, coalesce(p_clips, 5), 'auto', null, 'clip', '9:16', 'auto', true, 'bold');
  update public.projects set kind = 'video_pack' where job_id = v_job.id;
  insert into public.video_ownership (job_id, user_id, source, url)
  values (v_job.id, v_user, case when v_upload then 'upload' else 'link' end, case when v_upload then null else v_source end);
  v_run := public.cmo_enqueue(v_user, 'video_pack', jsonb_build_object('job_id', v_job.id));
  return jsonb_build_object('job', to_jsonb(v_job), 'run', to_jsonb(v_run));
end;
$$;

-- Thư viện: đọc từ `projects` thay vì lọc `jobs.kind`. Cùng tập như trước — clip và
-- gói video, không có New edit trống (chúng mở từ Editor) — cùng thứ tự, cùng cursor.
create or replace function public.list_projects(
  p_cursor_created_at timestamptz default null, p_cursor_id uuid default null,
  p_query text default null, p_limit integer default 24
)
returns setof public.jobs
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := public.require_user();
  v_limit int := least(greatest(coalesce(p_limit, 24), 1), 50);
  v_query text := nullif(trim(coalesce(p_query, '')), '');
  v_pattern text;
begin
  if v_query is not null then
    -- `%` và `_` người dùng gõ là chữ, không phải ký tự đại diện. Escape `\`
    -- trước, nếu không thì hai lần thay sau lại escape chính dấu vừa thêm.
    v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  select j.*
  from public.projects p
  join public.jobs j on j.id = p.job_id
  where p.user_id = v_user
    and p.kind in ('clip', 'video_pack')
    and (
      p_cursor_created_at is null
      or p_cursor_id is null
      or (j.created_at, j.id) < (p_cursor_created_at, p_cursor_id)
    )
    and (
      v_pattern is null
      or coalesce(j.name, '') ilike v_pattern escape '\'
      or coalesce(j.title, '') ilike v_pattern escape '\'
    )
  order by j.created_at desc, j.id desc
  limit v_limit;
end;
$$;

commit;
