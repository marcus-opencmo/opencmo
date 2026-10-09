-- Đợt 3d-2 (học Palmier): khung theo nền tảng lúc Export + "công thức edit" riêng của người dùng.
--
-- 1. `snapshot_editor_variant`: Palmier đổi tỉ lệ trên BẢN SAO timeline để bản gốc không
--    hỏng. Ở đây: route đổi khung trên bản sao document (op `set_frame`, chạy server), RPC
--    chụp bản sao đó thành revision export. `editor_projects.document` không đổi. Vẫn đối
--    chiếu vân tay của bản đang lưu: bản sao phải sinh từ đúng thứ người dùng đang thấy.
-- 2. `editor_skills`: skill kiểu SKILL.md của Palmier, gọn cho web — tên, mô tả một câu
--    (mục lục trong prompt), thân ≤ 50k ký tự (agent đọc khi cần). Chỉ người dùng đọc của
--    mình; ghi qua RPC.

begin;

-- ------------------------------------------------------------ snapshot_editor_variant
create function public.snapshot_editor_variant(
  p_clip_id uuid,
  p_document_hash text,
  p_document jsonb,
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
  v_row public.editor_projects;
  v_hash text;
  v_number int;
  v_revision public.editor_revisions;
begin
  if p_document_hash is null or p_document_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid project fingerprint.' using errcode = '22023';
  end if;
  if p_label is null or char_length(trim(p_label)) = 0 or char_length(p_label) > 200 then
    raise exception 'An export version needs a short label.' using errcode = '22023';
  end if;
  if not public.editor_document_shape_ok(p_document) or octet_length(p_document::text) >= 262144 then
    raise exception 'This version of the project could not be read.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  select p.* into v_row from public.editor_projects p where p.clip_id = p_clip_id for update;
  if not found then
    raise exception 'This clip has no editor project yet.' using errcode = 'P0002';
  end if;
  if public.editor_document_hash(v_row.document) <> p_document_hash then
    raise exception 'This project changed while it was being exported. Try again.'
      using errcode = 'P0409', detail = public.editor_json(p_clip_id)::text;
  end if;

  v_hash := public.editor_document_hash(p_document);
  select coalesce(max(r.number), 0) + 1 into v_number from public.editor_revisions r where r.clip_id = p_clip_id;

  insert into public.editor_revisions (clip_id, number, source_hash, document, kind, label)
  values (p_clip_id, v_number, v_hash, p_document, 'export', trim(p_label))
  returning * into v_revision;
  return v_revision;
end;
$$;

revoke execute on function public.snapshot_editor_variant(uuid, text, jsonb, text) from public, anon;
grant execute on function public.snapshot_editor_variant(uuid, text, jsonb, text) to authenticated;

-- ------------------------------------------------------------ editor_skills
create table public.editor_skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(name) <= 64),
  description text not null check (char_length(description) between 1 and 300),
  body text not null check (char_length(body) between 1 and 50000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);
alter table public.editor_skills enable row level security;
create policy "đọc skill của mình" on public.editor_skills for select using (user_id = auth.uid());
revoke insert, update, delete on public.editor_skills from anon, authenticated;

/** Mục lục gọn: số skill có trần để prompt không phình. */
create function public.save_editor_skill(p_name text, p_description text, p_body text)
returns public.editor_skills
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_name text := lower(trim(coalesce(p_name, '')));
  v_row public.editor_skills;
begin
  if v_name !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_name) > 64 then
    raise exception 'A skill name uses lowercase letters, numbers and hyphens, up to 64 characters.' using errcode = '22023';
  end if;
  if char_length(trim(coalesce(p_description, ''))) not between 1 and 300 then
    raise exception 'A skill needs a one-line description (up to 300 characters).' using errcode = '22023';
  end if;
  if char_length(coalesce(p_body, '')) not between 1 and 50000 then
    raise exception 'A skill body is 1 to 50,000 characters.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.editor_skills s where s.user_id = v_user and s.name = v_name)
     and (select count(*) from public.editor_skills s where s.user_id = v_user) >= 50 then
    raise exception 'You have 50 skills already. Delete one first.' using errcode = 'P0001';
  end if;

  insert into public.editor_skills (user_id, name, description, body)
  values (v_user, v_name, trim(p_description), p_body)
  on conflict (user_id, name) do update
    set description = excluded.description, body = excluded.body, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;

create function public.delete_editor_skill(p_name text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
begin
  delete from public.editor_skills s where s.user_id = v_user and s.name = lower(trim(coalesce(p_name, '')));
  return found;
end;
$$;

revoke execute on function public.save_editor_skill(text, text, text) from public, anon;
grant execute on function public.save_editor_skill(text, text, text) to authenticated;
revoke execute on function public.delete_editor_skill(text) from public, anon;
grant execute on function public.delete_editor_skill(text) to authenticated;

commit;
