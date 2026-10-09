-- C3 bước 2 (spec editor-rewrite): gỡ bản TSX của project editor. Fork Diffusion
-- Studio đã bị xoá, không còn ai đọc `source`; document JSON là thứ duy nhất.
--
-- Chốt chặn: còn hàng chưa có document thì DỪNG, không mất dữ liệu. SQL không
-- suy được document từ TSX — chạy `npm run editor:backfill` (migration trước mở
-- đường cho nó) rồi push lại.
--
-- `editor_revisions.source_hash` và `tasks.source_hash` GIỮ TÊN (đổi tên kéo theo
-- worker, RPC export và mọi test), nhưng từ đây mang vân tay của DOCUMENT:
-- `editor_document_hash()` = sha256 của `document::text`. Server tính, trả về
-- trong `editor_json.document_hash`, client gửi lại khi chụp revision — client
-- không bao giờ tự tính. Revision cũ giữ hash TSX của chúng: chỉ còn là nhãn.

begin;

do $$
begin
  if exists (
       select 1 from public.editor_projects
       where document is null or (generated_source is not null and generated_document is null)
     )
     or exists (select 1 from public.editor_revisions where document is null) then
    raise exception 'Some editor projects still have no document. Run `npm run editor:backfill`, then push again.';
  end if;
end;
$$;

-- Hết việc backfill: revision đóng băng hoàn toàn như trước.
drop trigger if exists editor_revisions_immutable on public.editor_revisions;
create trigger editor_revisions_immutable
  before update on public.editor_revisions
  for each row execute function public.freeze_clip_revision();
drop function if exists public.freeze_editor_revision();

drop function if exists public.get_or_create_editor_project(uuid, text, jsonb, jsonb);
drop function if exists public.save_editor_document(uuid, int, jsonb, text, jsonb);
drop function if exists public.snapshot_editor_revision(uuid, text);

alter table public.editor_projects
  drop column source,
  drop column generated_source,
  alter column document set not null;

alter table public.editor_revisions
  drop column source,
  alter column document set not null;

comment on column public.editor_revisions.source_hash is
  'Vân tay của document lúc chụp: editor_document_hash(document). Revision trước C3 giữ sha256 của TSX cũ.';

-- ------------------------------------------------------------ vân tay

create or replace function public.editor_document_hash(p_document jsonb)
returns text
language sql
immutable
set search_path = public
as $$
  select encode(sha256(convert_to(p_document::text, 'UTF8')), 'hex');
$$;

-- Trường tính của PostgREST: `select=document_hash` trên `editor_projects`,
-- dưới RLS của bảng — route đọc project thẳng từ bảng cũng có vân tay.
create or replace function public.document_hash(p_project public.editor_projects)
returns text
language sql
stable
set search_path = public
as $$
  select public.editor_document_hash(p_project.document);
$$;

create or replace function public.editor_json(p_clip_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'clip_id',       p.clip_id,
    'document',      p.document,
    'document_hash', public.editor_document_hash(p.document),
    'manifest',      p.manifest,
    'version',       p.version,
    'updated_at',    p.updated_at
  )
  from public.editor_projects p
  where p.clip_id = p_clip_id;
$$;

-- ------------------------------------- get_or_create_editor_project
--
-- Người tới trước thắng; document đầu tiên cũng là `generated_document` — bản
-- gốc cho "Reset".
create function public.get_or_create_editor_project(
  p_clip_id uuid,
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

  insert into public.editor_projects (clip_id, manifest, document, generated_document)
  values (p_clip_id, v_manifest, p_document, p_document)
  on conflict (clip_id) do nothing;

  return public.editor_json(p_clip_id);
end;
$$;

-- ------------------------------------------------ save_editor_document
--
-- Khoá lạc quan (P0409 mang project hiện hành trong `detail`). Không đổi gì thì
-- không tăng `version`.
create function public.save_editor_document(
  p_clip_id uuid,
  p_expected_version int,
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
  v_row public.editor_projects;
  v_manifest jsonb;
begin
  if not public.editor_document_shape_ok(p_document) then
    raise exception 'This project could not be read.' using errcode = '22023';
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
  if v_row.document = p_document and v_row.manifest = v_manifest then
    return public.editor_json(p_clip_id);
  end if;

  update public.editor_projects
  set document = p_document,
      manifest = v_manifest,
      version = v_row.version + 1,
      updated_at = now()
  where clip_id = p_clip_id;

  return public.editor_json(p_clip_id);
end;
$$;

-- ----------------------------------------------- reset_editor_project
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
  if v_row.generated_document is null then
    raise exception 'This project has no original version to go back to.' using errcode = '22023';
  end if;
  if v_row.version is distinct from p_expected_version then
    raise exception 'This clip was changed in another tab.'
      using errcode = 'P0409', detail = public.editor_json(p_clip_id)::text;
  end if;

  update public.editor_projects
  set document = v_row.generated_document,
      version = v_row.version + 1,
      updated_at = now()
  where clip_id = p_clip_id
    and document is distinct from v_row.generated_document;

  return public.editor_json(p_clip_id);
end;
$$;

-- ------------------------------------------ snapshot_editor_revision
--
-- Client gửi lại `document_hash` của bản nó đang thấy (lấy từ server). Lệch với
-- bản đang lưu nghĩa là project đổi giữa chừng: export ra thứ không ai nhìn thấy.
create function public.snapshot_editor_revision(
  p_clip_id uuid,
  p_document_hash text
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
  if p_document_hash is null or p_document_hash !~ '^[0-9a-f]{64}$' then
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

  if public.editor_document_hash(v_row.document) <> p_document_hash then
    raise exception 'This project changed while it was being exported. Try again.'
      using errcode = 'P0409', detail = public.editor_json(p_clip_id)::text;
  end if;

  select r.* into v_latest
  from public.editor_revisions r
  where r.clip_id = p_clip_id and r.kind = 'export'
  order by r.number desc
  limit 1;

  if found and v_latest.source_hash = p_document_hash then
    return v_latest;
  end if;

  select coalesce(max(r.number), 0) + 1 into v_number
  from public.editor_revisions r
  where r.clip_id = p_clip_id;

  insert into public.editor_revisions (clip_id, number, source_hash, document, kind)
  values (p_clip_id, v_number, p_document_hash, v_row.document, 'export')
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

  v_hash := public.editor_document_hash(v_row.document);

  select r.* into v_latest
  from public.editor_revisions r
  where r.clip_id = p_clip_id
  order by r.number desc
  limit 1;

  if found and v_latest.source_hash = v_hash and v_latest.kind = p_kind then
    return v_latest;
  end if;

  insert into public.editor_revisions (clip_id, number, source_hash, document, kind, label)
  values (p_clip_id, coalesce(v_latest.number, 0) + 1, v_hash, v_row.document, p_kind, trim(p_label))
  returning * into v_revision;

  return v_revision;
end;
$$;

-- `editor_json` là security definer KHÔNG kiểm chủ: chỉ hàm khác được gọi nó.
-- `revoke … from public` năm 22/09 không đủ — Supabase cấp thẳng EXECUTE cho
-- `authenticated` qua default privileges, nên tới đây người dùng nào cũng đọc
-- được project của clip bất kỳ nếu biết id.
revoke execute on function public.editor_json(uuid) from public, anon, authenticated;
revoke execute on function public.editor_document_hash(jsonb) from public, anon;
grant execute on function public.editor_document_hash(jsonb) to authenticated, service_role;
revoke execute on function public.document_hash(public.editor_projects) from public, anon;
grant execute on function public.document_hash(public.editor_projects) to authenticated, service_role;
revoke execute on function public.get_or_create_editor_project(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.get_or_create_editor_project(uuid, jsonb, jsonb) to authenticated;
revoke execute on function public.save_editor_document(uuid, int, jsonb, jsonb) from public, anon;
grant execute on function public.save_editor_document(uuid, int, jsonb, jsonb) to authenticated;
revoke execute on function public.snapshot_editor_revision(uuid, text) from public, anon;
grant execute on function public.snapshot_editor_revision(uuid, text) to authenticated;

commit;
