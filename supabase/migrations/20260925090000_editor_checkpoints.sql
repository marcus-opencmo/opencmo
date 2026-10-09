-- Checkpoint của project editor: "trước lượt sửa này nó thế nào", để mọi lượt
-- sửa lớn (agent, áp style cho cả project, khôi phục bản cũ) hoàn tác được
-- bằng một cú bấm (spec AI Studio §5).
--
-- Checkpoint là MỘT hàng `editor_revisions`, không phải một bảng mới: cùng
-- bất biến (trigger `editor_revisions_immutable`), cùng RLS, cùng đường khôi
-- phục trong Version history. Chỉ khác `kind` và một nhãn đọc được.

begin;

alter table public.editor_revisions
  add column if not exists kind text not null default 'export'
    check (kind in ('export', 'agent', 'manual')),
  add column if not exists label text
    check (label is null or char_length(label) between 1 and 200);

-- ------------------------------------------- snapshot_editor_revision
--
-- Như bản cũ, trừ một điểm: chỉ tái dùng revision EXPORT mới nhất cùng hash.
-- Tái dùng một checkpoint cho một lượt export là để Version history gọi bản
-- người dùng đã xuất ra là "Before applying caption style".
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
  v_number int;
  v_revision public.editor_revisions;
begin
  if p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid project fingerprint.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  select p.source into v_source
  from public.editor_projects p
  where p.clip_id = p_clip_id
  for update;

  if not found then
    raise exception 'This clip has no editor project yet.' using errcode = 'P0002';
  end if;

  if encode(sha256(convert_to(v_source, 'UTF8')), 'hex') <> p_source_hash then
    raise exception 'This project changed while it was being exported. Try again.'
      using errcode = 'P0409', detail = public.editor_json(p_clip_id)::text;
  end if;

  select r.* into v_latest
  from public.editor_revisions r
  where r.clip_id = p_clip_id and r.kind = 'export'
  order by r.number desc
  limit 1;

  if found and v_latest.source_hash = p_source_hash then
    return v_latest;
  end if;

  select coalesce(max(r.number), 0) + 1 into v_number
  from public.editor_revisions r
  where r.clip_id = p_clip_id;

  insert into public.editor_revisions (clip_id, number, source, source_hash, kind)
  values (p_clip_id, v_number, v_source, p_source_hash, 'export')
  returning * into v_revision;

  return v_revision;
end;
$$;

-- ------------------------------------------ checkpoint_editor_project
--
-- Chụp source HIỆN HÀNH trên server (không nhận source từ client: checkpoint
-- phải là thứ thật sự đang lưu, không phải thứ một tab nghĩ là đang lưu).
-- Hash tính ở đây.
--
-- Revision mới nhất đã là đúng bản này, cùng kind, thì trả lại nó: agent gọi
-- hai tool liền nhau không được đẻ ra hai checkpoint giống hệt.
create or replace function public.checkpoint_editor_project(
  p_clip_id uuid,
  p_kind text,
  p_label text
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
  v_hash text;
  v_latest public.editor_revisions;
  v_revision public.editor_revisions;
begin
  if p_kind is null or p_kind not in ('agent', 'manual') then
    raise exception 'Invalid checkpoint kind.' using errcode = '22023';
  end if;
  if p_label is null or char_length(trim(p_label)) = 0 or char_length(p_label) > 200 then
    raise exception 'A checkpoint needs a short label.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  select p.source into v_source
  from public.editor_projects p
  where p.clip_id = p_clip_id
  for update;

  if not found then
    raise exception 'This clip has no editor project yet.' using errcode = 'P0002';
  end if;

  v_hash := encode(sha256(convert_to(v_source, 'UTF8')), 'hex');

  select r.* into v_latest
  from public.editor_revisions r
  where r.clip_id = p_clip_id
  order by r.number desc
  limit 1;

  if found and v_latest.source_hash = v_hash and v_latest.kind = p_kind then
    return v_latest;
  end if;

  insert into public.editor_revisions (clip_id, number, source, source_hash, kind, label)
  values (p_clip_id, coalesce(v_latest.number, 0) + 1, v_source, v_hash, p_kind, trim(p_label))
  returning * into v_revision;

  return v_revision;
end;
$$;

revoke execute on function public.checkpoint_editor_project(uuid, text, text) from public, anon;
grant execute on function public.checkpoint_editor_project(uuid, text, text) to authenticated;

commit;
