-- 20261025090000: editor không cần video đã cắt (F1, Marcus 04/10).
--
-- Trước đây editor chỉ mở được clip của một video đã xử lý: muốn sửa gì cũng phải upload
-- rồi chờ cắt clip. "New edit" tạo một project TRỐNG: một job `edit` (không có nguồn,
-- status `done` ngay nên worker không bao giờ claim) + một clip `blank`. Mọi thứ khoá theo
-- clip/job — `editor_projects`, thư viện `media_assets`, `render_document`, agent — dùng lại
-- nguyên vẹn, như E2-c đã làm cho "Edit full video". Document trống do route dựng (TS,
-- validate bằng clip-doc) lần đầu mở, không dựng ở SQL.

begin;

alter table public.jobs add column if not exists kind text not null default 'clip';
alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in ('clip', 'edit'));

-- Job `edit` không có nguồn để tải: một giá trị cố định, không bao giờ là URL mạng hay
-- đường dẫn Storage — worker có nhặt nhầm cũng không đọc được gì.
alter table public.jobs drop constraint jobs_source_url_check;
alter table public.jobs add constraint jobs_source_url_check check (
  (kind = 'edit' and source_url = 'editor://blank')
  or (kind = 'clip' and (
    source_url ~ '^https?://[^[:space:]]+$'
    or source_url ~ ('^storage://' || user_id::text || '/[A-Za-z0-9][A-Za-z0-9._-]{0,240}$')
  ))
);

alter table public.clips drop constraint if exists clips_kind_check;
alter table public.clips add constraint clips_kind_check check (kind in ('moment', 'full', 'blank'));

-- Trả clip id để client mở `/app/editor/<clip>`. Không tốn credit: chưa có gì để xử lý.
create or replace function public.create_blank_edit(p_name text default null, p_aspect text default '9:16')
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_name text := nullif(left(btrim(coalesce(p_name, '')), 120), '');
  v_job uuid;
  v_clip uuid;
begin
  if p_aspect is null or p_aspect not in ('9:16', '1:1', '16:9') then
    raise exception 'Choose a frame: 9:16, 1:1 or 16:9.' using errcode = '22023';
  end if;
  -- Chặn tạo hàng loạt project rỗng: cùng trần với các lượt tạo project khác.
  if (select count(*) from public.jobs where user_id = v_user and kind = 'edit' and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'You have created many edits in the last hour. Try again later.' using errcode = 'P0001';
  end if;

  insert into public.jobs (user_id, kind, source_url, title, status, aspect, clips_requested, duration_seconds, finished_at)
  values (v_user, 'edit', 'editor://blank', coalesce(v_name, 'Untitled edit'), 'done', p_aspect, 0, 0, now())
  returning id into v_job;
  insert into public.clips (job_id, idx, hook, start_seconds, end_seconds, source_start, source_end, kind)
  values (v_job, -1, coalesce(v_name, 'Untitled edit'), 0, 0, null, null, 'blank')
  returning id into v_clip;
  return v_clip;
end;
$$;

revoke all on function public.create_blank_edit(text, text) from public, anon;
grant execute on function public.create_blank_edit(text, text) to authenticated;

-- My projects là video đã cắt; bản New edit nằm ở Editor home (`/api/v1/editor/clips`).
create or replace function public.list_projects(
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_query text default null,
  p_limit int default 24
)
returns setof public.jobs
language plpgsql
stable
security definer
set search_path = public
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
  from public.jobs j
  where j.user_id = v_user
    and j.kind = 'clip'
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
