-- Editor đợt 2: transcript sửa được, bản gốc để quay về, và xoá B-roll thật.
--
-- Ba việc, một migration, vì cả ba đều là "editor ghi thêm một thứ vào
-- database" và đều đi đúng khuôn `20260922155056_editor_projects.sql`: SELECT
-- qua RLS theo `clips -> jobs.user_id`, mọi ghi qua RPC có `owned_clip`.

begin;

-- ------------------------------------------------------ editor_transcripts
--
-- Transcript người dùng đã sửa, ĐỊA CHỈ THEO NỘI DUNG. `<captions src>` trong
-- TSX trỏ vào `assets/transcripts/<hash>.json`, nên:
--   * một revision export chụp source là chụp luôn transcript nó dùng — hash
--     nằm trong source, và hàng ở đây không bao giờ đổi;
--   * không cần khoá lạc quan: hai tab ghi hai nội dung khác nhau là hai hàng
--     khác nhau, và bản nào thắng là việc của `save_editor_project` (source).
--
-- `body` là TEXT, không phải jsonb: hash tính trên đúng các byte client gửi và
-- client đọc lại, và jsonb chuẩn hoá lại khoảng trắng/thứ tự khoá — đọc về
-- sẽ ra một chuỗi khác với chuỗi đã băm.
create table if not exists public.editor_transcripts (
  clip_id    uuid not null references public.clips(id) on delete cascade,
  hash       text not null check (hash ~ '^[0-9a-f]{64}$'),
  body       text not null check (octet_length(body) < 524288),
  created_at timestamptz not null default now(),
  primary key (clip_id, hash)
);

alter table public.editor_transcripts enable row level security;

drop policy if exists "đọc transcript editor thuộc clip của mình" on public.editor_transcripts;
create policy "đọc transcript editor thuộc clip của mình"
  on public.editor_transcripts for select
  to authenticated
  using (exists (
    select 1 from public.clips c
    join public.jobs j on j.id = c.job_id
    where c.id = editor_transcripts.clip_id
      and j.user_id = (select auth.uid())
      and j.purging_at is null
  ));

-- Hash do SERVER tính: client gửi nội dung, không gửi hash. Một hash do client
-- khai là một chỗ để ghi nội dung A dưới tên của nội dung B, và mọi revision
-- trỏ vào tên đó sẽ phát ra chữ khác với chữ người dùng đã duyệt.
create or replace function public.put_editor_transcript(p_clip_id uuid, p_body text)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_json jsonb;
  v_hash text;
begin
  if p_body is null or octet_length(p_body) >= 524288 then
    raise exception 'This transcript is too large to save.' using errcode = '22023';
  end if;

  begin
    v_json := p_body::jsonb;
  exception when others then
    raise exception 'This transcript is not valid JSON.' using errcode = '22023';
  end;

  -- Hình dạng mà `resolveTranscript` của DS đọc thẳng bằng `JSON.parse`: một
  -- mảng đoạn, mỗi đoạn có `text` và mảng `words`. Sai hình dạng thì phụ đề
  -- rỗng, không lỗi nào — nên chặn ở đây.
  if jsonb_typeof(v_json) <> 'array' or exists (
    select 1 from jsonb_array_elements(v_json) as segment
    where jsonb_typeof(segment) <> 'object'
       or jsonb_typeof(segment -> 'text') is distinct from 'string'
       or jsonb_typeof(segment -> 'words') is distinct from 'array'
  ) then
    raise exception 'This transcript has an unexpected shape.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  v_hash := encode(sha256(convert_to(p_body, 'UTF8')), 'hex');

  insert into public.editor_transcripts (clip_id, hash, body)
  values (p_clip_id, v_hash, p_body)
  on conflict (clip_id, hash) do nothing;

  return v_hash;
end;
$$;

-- --------------------------------------------- bản gốc để quay về
--
-- `save_editor_project` ghi đè `source` tại chỗ, và `editor_revisions` chỉ
-- chụp lúc export — nên trước migration này không còn cách nào trở về bản
-- engine sinh ra. Giữ nó ở một cột, ghi đúng một lần lúc tạo project.
--
-- Project tạo trước migration có `generated_source` NULL: không đoán lại từ
-- settings hiện tại, vì settings có thể đã đổi từ lúc project được sinh.
alter table public.editor_projects
  add column if not exists generated_source text
    check (generated_source is null or octet_length(generated_source) < 262144);

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

  insert into public.editor_projects (clip_id, source, manifest, generated_source)
  values (p_clip_id, p_source, v_manifest, p_source)
  on conflict (clip_id) do nothing;

  return public.editor_json(p_clip_id);
end;
$$;

-- Quay về bản gốc, có khoá lạc quan như một lượt lưu thường: reset ở tab này
-- không được đè lên bài vừa lưu ở tab kia mà không ai biết. Manifest giữ
-- nguyên — B-roll người dùng đã thêm vẫn nằm trong thư viện, chỉ timeline về
-- lại như cũ.
create or replace function public.reset_editor_project(p_clip_id uuid, p_expected_version int)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_version int;
  v_generated text;
begin
  perform public.owned_clip(p_clip_id, v_user);

  select p.version, p.generated_source into v_version, v_generated
  from public.editor_projects p
  where p.clip_id = p_clip_id
  for update;

  if not found then
    raise exception 'This clip has no editor project yet.' using errcode = 'P0002';
  end if;
  if v_generated is null then
    raise exception 'This project has no original version to go back to.' using errcode = '22023';
  end if;
  if v_version is distinct from p_expected_version then
    raise exception 'This clip was changed in another tab.'
      using errcode = 'P0409', detail = public.editor_json(p_clip_id)::text;
  end if;

  update public.editor_projects
  set source = v_generated,
      version = v_version + 1,
      updated_at = now()
  where clip_id = p_clip_id and source is distinct from v_generated;

  return public.editor_json(p_clip_id);
end;
$$;

-- --------------------------------------------------- xoá một B-roll
--
-- Xoá trong editor trước đây chỉ xoá OPFS: hàng `media_assets` và object trong
-- bucket `media` sống tới khi cả job bị xoá, và vẫn chiếm một chỗ trong trần
-- số file của project. Trigger `media_assets_record_storage_deletions`
-- (`20260920170000_web_retention.sql`) đưa object vào hàng xoá khi hàng này
-- đi, nên ở đây chỉ cần xoá hàng.
create or replace function public.delete_media_asset(p_asset_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
begin
  delete from public.media_assets m
  using public.jobs j
  where m.id = p_asset_id
    and m.user_id = v_user
    and j.id = m.job_id
    and j.user_id = v_user
    and j.purging_at is null;

  if not found then
    raise exception 'That media file was not found.' using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.put_editor_transcript(uuid, text) from public, anon;
revoke execute on function public.reset_editor_project(uuid, int) from public, anon;
revoke execute on function public.delete_media_asset(uuid) from public, anon;

grant execute on function public.put_editor_transcript(uuid, text) to authenticated;
grant execute on function public.reset_editor_project(uuid, int) to authenticated;
grant execute on function public.delete_media_asset(uuid) to authenticated;

commit;
