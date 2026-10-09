-- B1 (spec editor-rewrite §9): document JSON của `@opencmo/clip-doc` thành nguồn
-- sự thật của project editor. `source` (TSX) còn lại làm bản cho fork Diffusion
-- Studio đọc, và mọi đường ghi lưu CẢ HAI trong cùng một lượt — không có đường
-- ghi nào chỉ đổi một bên.
--
-- `document` NULL là hàng cũ, ghi trước migration này: SQL không đọc được TSX,
-- nên server suy document từ `source` khi đọc, và lượt ghi đầu tiên lưu nó.
--
-- SQL chỉ kiểm hình dạng ngoài (object, có `version` nguyên và `stage` object)
-- và cỡ. Luật đầy đủ là `validate()` của clip-doc, chạy ở server trước khi gọi
-- vào đây — cùng một hàm cho route, agent và worker.

begin;

alter table public.editor_projects
  add column document jsonb
    check (document is null or octet_length(document::text) < 262144),
  add column generated_document jsonb
    check (generated_document is null or octet_length(generated_document::text) < 262144);

alter table public.editor_revisions
  add column document jsonb
    check (document is null or octet_length(document::text) < 262144);

-- ------------------------------------------------------------ hình dạng

create or replace function public.editor_document_shape_ok(p_document jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  -- `coalesce`: khoá vắng mặt cho NULL, và `not NULL` là NULL — một `if` sẽ
  -- lặng lẽ cho document thiếu `version` đi qua.
  select coalesce(
    jsonb_typeof(p_document) = 'object'
      and jsonb_typeof(p_document->'version') = 'number'
      and (p_document->>'version') ~ '^[1-9][0-9]*$'
      and jsonb_typeof(p_document->'stage') = 'object'
      and octet_length(p_document::text) < 262144,
    false);
$$;

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
    'document',   p.document,
    'manifest',   p.manifest,
    'version',    p.version,
    'updated_at', p.updated_at
  )
  from public.editor_projects p
  where p.clip_id = p_clip_id;
$$;

-- ------------------------------------- get_or_create_editor_project
--
-- Như bản cũ (người tới trước thắng), nay nhận thêm document và ghi nó làm
-- `generated_document` — bản gốc cho "Reset".
drop function public.get_or_create_editor_project(uuid, text, jsonb);

create function public.get_or_create_editor_project(
  p_clip_id uuid,
  p_source text,
  p_document jsonb,
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
  if not public.editor_document_shape_ok(p_document) then
    raise exception 'This project could not be read.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_manifest) <> 'object' then
    raise exception 'The project manifest must be an object.' using errcode = '22023';
  end if;
  if pg_column_size(v_manifest) >= 65536 then
    raise exception 'This project has too many assets to save.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  insert into public.editor_projects (clip_id, source, manifest, generated_source, document, generated_document)
  values (p_clip_id, p_source, v_manifest, p_source, p_document, p_document)
  on conflict (clip_id) do nothing;

  return public.editor_json(p_clip_id);
end;
$$;

-- ------------------------------------------------ save_editor_document
--
-- Khoá lạc quan như `save_editor_project` cũ (lỗi P0409 mang project hiện hành
-- trong `detail`). Không đổi gì thì không tăng `version`.
drop function public.save_editor_project(uuid, int, text, jsonb);

create function public.save_editor_document(
  p_clip_id uuid,
  p_expected_version int,
  p_document jsonb,
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
  v_row public.editor_projects;
  v_manifest jsonb;
begin
  if not public.editor_document_shape_ok(p_document) then
    raise exception 'This project could not be read.' using errcode = '22023';
  end if;
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

  select p.* into v_row
  from public.editor_projects p
  where p.clip_id = p_clip_id
  for update;

  if not found then
    raise exception 'This clip has no editor project yet.' using errcode = 'P0002';
  end if;
  if v_row.version is distinct from p_expected_version then
    raise exception 'This clip was changed in another tab.'
      using errcode = 'P0409', detail = public.editor_json(p_clip_id)::text;
  end if;

  v_manifest := coalesce(p_manifest, v_row.manifest);
  if v_row.document is not distinct from p_document
     and v_row.source = p_source
     and v_row.manifest = v_manifest then
    return public.editor_json(p_clip_id);
  end if;

  update public.editor_projects
  set document = p_document,
      source = p_source,
      manifest = v_manifest,
      version = v_row.version + 1,
      updated_at = now()
  where clip_id = p_clip_id;

  return public.editor_json(p_clip_id);
end;
$$;

-- ----------------------------------------------- reset_editor_project
--
-- Về bản gốc: source VÀ document gốc. Hàng tạo trước B1 không có document gốc,
-- nên document về NULL — cùng nghĩa "suy từ source" như mọi hàng cũ.
create or replace function public.reset_editor_project(p_clip_id uuid, p_expected_version int)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_row public.editor_projects;
begin
  perform public.owned_clip(p_clip_id, v_user);

  select p.* into v_row
  from public.editor_projects p
  where p.clip_id = p_clip_id
  for update;

  if not found then
    raise exception 'This clip has no editor project yet.' using errcode = 'P0002';
  end if;
  if v_row.generated_source is null then
    raise exception 'This project has no original version to go back to.' using errcode = '22023';
  end if;
  if v_row.version is distinct from p_expected_version then
    raise exception 'This clip was changed in another tab.'
      using errcode = 'P0409', detail = public.editor_json(p_clip_id)::text;
  end if;

  update public.editor_projects
  set source = v_row.generated_source,
      document = v_row.generated_document,
      version = v_row.version + 1,
      updated_at = now()
  where clip_id = p_clip_id
    and (source is distinct from v_row.generated_source
         or document is distinct from v_row.generated_document);

  return public.editor_json(p_clip_id);
end;
$$;

-- ------------------------------------------ snapshot_editor_revision
--
-- Như bản 25/09, nay chụp cả document. Hash vẫn là sha256 của `source`: nó là
-- vân tay của cặp (document, source) vì hai thứ luôn được ghi cùng nhau.
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
  v_row public.editor_projects;
  v_latest public.editor_revisions;
  v_number int;
  v_revision public.editor_revisions;
begin
  if p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid project fingerprint.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  select p.* into v_row
  from public.editor_projects p
  where p.clip_id = p_clip_id
  for update;

  if not found then
    raise exception 'This clip has no editor project yet.' using errcode = 'P0002';
  end if;

  if encode(sha256(convert_to(v_row.source, 'UTF8')), 'hex') <> p_source_hash then
    raise exception 'This project changed while it was being exported. Try again.'
      using errcode = 'P0409', detail = public.editor_json(p_clip_id)::text;
  end if;

  select r.* into v_latest
  from public.editor_revisions r
  where r.clip_id = p_clip_id and r.kind = 'export'
  order by r.number desc
  limit 1;

  if found and v_latest.source_hash = p_source_hash
     and v_latest.document is not distinct from v_row.document then
    return v_latest;
  end if;

  select coalesce(max(r.number), 0) + 1 into v_number
  from public.editor_revisions r
  where r.clip_id = p_clip_id;

  insert into public.editor_revisions (clip_id, number, source, source_hash, document, kind)
  values (p_clip_id, v_number, v_row.source, p_source_hash, v_row.document, 'export')
  returning * into v_revision;

  return v_revision;
end;
$$;

-- ------------------------------------------ checkpoint_editor_project
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
  v_row public.editor_projects;
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

  select p.* into v_row
  from public.editor_projects p
  where p.clip_id = p_clip_id
  for update;

  if not found then
    raise exception 'This clip has no editor project yet.' using errcode = 'P0002';
  end if;

  v_hash := encode(sha256(convert_to(v_row.source, 'UTF8')), 'hex');

  select r.* into v_latest
  from public.editor_revisions r
  where r.clip_id = p_clip_id
  order by r.number desc
  limit 1;

  if found and v_latest.source_hash = v_hash and v_latest.kind = p_kind
     and v_latest.document is not distinct from v_row.document then
    return v_latest;
  end if;

  insert into public.editor_revisions (clip_id, number, source, source_hash, document, kind, label)
  values (p_clip_id, coalesce(v_latest.number, 0) + 1, v_row.source, v_hash, v_row.document, p_kind, trim(p_label))
  returning * into v_revision;

  return v_revision;
end;
$$;

revoke execute on function public.get_or_create_editor_project(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.get_or_create_editor_project(uuid, text, jsonb, jsonb) to authenticated;
revoke execute on function public.save_editor_document(uuid, int, jsonb, text, jsonb) from public, anon;
grant execute on function public.save_editor_document(uuid, int, jsonb, text, jsonb) to authenticated;
revoke execute on function public.editor_document_shape_ok(jsonb) from public, anon;

commit;
