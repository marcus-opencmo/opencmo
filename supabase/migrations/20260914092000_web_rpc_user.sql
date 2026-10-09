-- OpenCMO — RPC cho người dùng đã đăng nhập.
--
-- Quy ước của cả file:
--   * `security definer` + `set search_path = public` — không có search_path cố
--     định thì một schema tạm do người gọi dựng lên có thể chen hàm giả vào.
--   * Dòng đầu luôn là `require_user()`, và quyền sở hữu kiểm bằng `auth.uid()`
--     chứ KHÔNG bao giờ bằng một user_id do client gửi lên.
--   * Message của `raise` là TIẾNG ANH: PostgREST trả nguyên văn về client và
--     trang editor in thẳng ra màn hình (bảng ngôn ngữ ở đầu CLAUDE.md).
--   * Không lộ sự tồn tại: clip của người khác trả 'Clip not found.', giống hệt
--     clip không có thật. Phân biệt hai ca đó là cho không một máy dò id.
--   * Cuối file: revoke khỏi `public, anon` rồi grant đúng một vai. `create
--     function` mặc định cấp cho `public` — bài học của 20260910150634.

-- ------------------------------------------------------------- helper
--
-- Ba hàm dưới đây là nội bộ: không grant cho vai nào cả. Chúng chỉ được gọi từ
-- trong các hàm definer khác, nơi chủ sở hữu (postgres) đã có sẵn quyền.

create or replace function public.require_user()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;
  return v_user;
end;
$$;

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
  where c.id = p_clip_id and j.user_id = p_user;

  if not found then
    raise exception 'Clip not found.' using errcode = 'P0002';
  end if;
  return v_clip;
end;
$$;

-- Hình dạng trả về khớp `tests/contracts/clipping/draft.json`. Mốc thời gian in
-- theo ISO-8601 UTC có mili giây để TypeScript `new Date()` đọc được y như
-- chuỗi mà bản local sinh ra.
create or replace function public.draft_json(p_clip_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'clip_id', d.clip_id,
    'revision', r.number,
    'revision_id', r.id,
    'settings', r.settings,
    'updated_at', to_char(d.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  from public.clip_drafts d
  join public.clip_revisions r on r.id = d.revision_id
  where d.clip_id = p_clip_id;
$$;

-- --------------------------------------------------------------- save_draft
--
-- Lưu một lần sửa. Hai tab cùng mở một clip là chuyện bình thường, nên đây là
-- so-sánh-rồi-ghi có khoá: `for update of d` giữ hàng draft, và khi giao dịch
-- kia commit trước, Postgres đọc lại hàng đã khoá (EvalPlanQual) nên lần này
-- thấy số revision MỚI và ném P0409 thay vì ghi đè im lặng.
--
-- Không parse settings ở đây. Luật đầy đủ nằm ở zod (route handler, D3) và
-- `parse_settings` (worker, D2); SQL chỉ giữ hai thứ nó giữ được tốt hơn cả:
-- kích thước và hình dạng hash.
create or replace function public.save_draft(
  p_clip_id uuid,
  p_expected_revision int,
  p_settings jsonb,
  p_settings_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_current_id uuid;
  v_number int;
  v_hash text;
  v_revision_id uuid;
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'Clip settings must be an object.' using errcode = '22023';
  end if;
  if p_settings_hash is null or p_settings_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid settings fingerprint.' using errcode = '22023';
  end if;
  if pg_column_size(p_settings) >= 65536 then
    raise exception 'These clip settings are too large to save.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  -- Khoá hàng draft MỘT MÌNH, không join sang `clip_revisions`.
  --
  -- Đây là chỗ đã sai một lần và test tranh chấp bắt được: khi câu lệnh có join
  -- và giao dịch kia commit trước, Postgres đọc lại hàng draft đã khoá
  -- (EvalPlanQual) nhưng vẫn dùng ẢNH CHỤP CŨ cho các bảng còn lại — mà revision
  -- mới thì chưa có trong ảnh chụp đó. Join không khớp, hàm trả 'Clip not found.'
  -- cho một clip vẫn tồn tại. Tách làm hai câu thì câu sau lấy ảnh chụp mới
  -- (READ COMMITTED chụp lại theo từng câu lệnh) và thấy đúng revision hiện hành.
  select d.revision_id into v_current_id
  from public.clip_drafts d
  where d.clip_id = p_clip_id
  for update;

  if not found then
    raise exception 'Clip not found.' using errcode = 'P0002';
  end if;

  select r.number, r.settings_hash into v_number, v_hash
  from public.clip_revisions r
  where r.id = v_current_id;

  if v_number <> p_expected_revision then
    -- `detail` mang theo draft hiện hành để UI vẽ được "bản kia đang là gì"
    -- mà không phải gọi thêm một vòng.
    raise exception 'This clip was changed in another tab.'
      using errcode = 'P0409', detail = public.draft_json(p_clip_id)::text;
  end if;

  -- Cùng nội dung thì không sinh revision mới: người dùng bấm Save hai lần
  -- không được đẻ ra hai bản y hệt trong lịch sử.
  if v_hash = p_settings_hash then
    return public.draft_json(p_clip_id);
  end if;

  insert into public.clip_revisions (clip_id, number, settings, settings_hash)
  values (p_clip_id, v_number + 1, p_settings, p_settings_hash)
  returning id into v_revision_id;

  update public.clip_drafts
  set revision_id = v_revision_id, updated_at = now()
  where clip_id = p_clip_id;

  return public.draft_json(p_clip_id);
end;
$$;

-- ----------------------------------------------------------- request_preview
--
-- Khử trùng theo NỘI DUNG: cùng clip + cùng settings_hash thì dùng lại task
-- đang sống. Preview là thứ người dùng bấm liên tục trong lúc kéo thanh trượt,
-- và mỗi lần render là tiền thật.
create or replace function public.request_preview(
  p_clip_id uuid,
  p_settings jsonb,
  p_settings_hash text,
  p_request_id uuid
)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_task public.tasks;
begin
  if p_settings_hash is null or p_settings_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid settings fingerprint.' using errcode = '22023';
  end if;
  if p_request_id is null then
    raise exception 'Missing request id.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  select * into v_task from public.tasks where request_id = p_request_id;
  if found then
    if v_task.kind <> 'preview' or v_task.clip_id is distinct from p_clip_id then
      raise exception 'This request id was already used for something else.'
        using errcode = '22023';
    end if;
    return v_task;
  end if;

  insert into public.tasks (user_id, kind, clip_id, settings_hash, payload, request_id)
  values (v_user, 'preview', p_clip_id, p_settings_hash,
          jsonb_build_object('settings', p_settings), p_request_id)
  on conflict do nothing
  returning * into v_task;

  if found then
    return v_task;
  end if;

  -- Không chèn được: đã có preview sống cùng nội dung (index khử trùng), hoặc
  -- một giao dịch song song vừa dùng đúng request_id này.
  select * into v_task from public.tasks
  where kind = 'preview' and clip_id = p_clip_id and settings_hash = p_settings_hash
    and status in ('queued', 'running', 'done')
  order by created_at desc
  limit 1;

  if not found then
    select * into v_task from public.tasks where request_id = p_request_id;
  end if;
  if not found then
    raise exception 'Could not start the preview. Please try again.' using errcode = 'P0001';
  end if;
  return v_task;
end;
$$;

-- ------------------------------------------------------------ request_export
--
-- Export chỉ nhận revision ĐÃ LƯU: file người dùng tải về phải khớp với thứ họ
-- thấy lúc bấm, và revision là bất biến nên nó khớp mãi mãi.
create or replace function public.request_export(
  p_clip_id uuid,
  p_revision_id uuid,
  p_request_id uuid
)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_hash text;
  v_task public.tasks;
begin
  if p_request_id is null then
    raise exception 'Missing request id.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  select settings_hash into v_hash
  from public.clip_revisions
  where id = p_revision_id and clip_id = p_clip_id;

  if not found then
    raise exception 'Save the clip before exporting it.' using errcode = 'P0002';
  end if;

  -- Idempotent theo request_id: bấm hai lần hoặc mạng gửi lại vẫn một task.
  select * into v_task from public.tasks where request_id = p_request_id;
  if found then
    if v_task.kind <> 'export'
       or v_task.clip_id is distinct from p_clip_id
       or v_task.revision_id is distinct from p_revision_id then
      raise exception 'This export request was already used for another clip or revision.'
        using errcode = '22023';
    end if;
    return v_task;
  end if;

  insert into public.tasks (user_id, kind, clip_id, revision_id, settings_hash, request_id)
  values (v_user, 'export', p_clip_id, p_revision_id, v_hash, p_request_id)
  on conflict do nothing
  returning * into v_task;

  if found then
    return v_task;
  end if;

  -- Đã có export sống cho revision này. Bản `failed` nằm ngoài index nên không
  -- rơi vào nhánh này — thử lại được.
  select * into v_task from public.tasks
  where kind = 'export' and clip_id = p_clip_id and revision_id = p_revision_id
    and status in ('queued', 'running', 'done')
  limit 1;

  if not found then
    select * into v_task from public.tasks where request_id = p_request_id;
  end if;
  if not found then
    raise exception 'Could not start the export. Please try again.' using errcode = 'P0001';
  end if;
  return v_task;
end;
$$;

-- ----------------------------------------------------------------- presets

create or replace function public.save_preset(p_name text, p_settings jsonb)
returns public.presets
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_name text := trim(coalesce(p_name, ''));
  v_preset public.presets;
begin
  if v_name = '' then
    raise exception 'Name this preset before saving it.' using errcode = '22023';
  end if;
  if char_length(v_name) > 60 then
    raise exception 'Keep the preset name under 60 characters.' using errcode = '22023';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'Preset settings must be an object.' using errcode = '22023';
  end if;

  begin
    insert into public.presets (user_id, name, settings)
    values (v_user, v_name, p_settings)
    returning * into v_preset;
  exception when unique_violation then
    raise exception 'A preset with this name already exists.' using errcode = '23505';
  end;

  return v_preset;
end;
$$;

create or replace function public.delete_preset(p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
begin
  delete from public.presets where id = p_id and user_id = v_user;
  return found;
end;
$$;

-- ---------------------------------------------------- register_media_asset
--
-- Đường dẫn do CLIENT gửi lên sau khi upload thẳng vào storage. Kiểm ĐỦ SỐ
-- SEGMENT chứ không chỉ so segment đầu — `media/<uid>/../../nguoi-khac/x.mp4`
-- cũng bắt đầu bằng uid hợp lệ. Đây đúng là chỗ chặn mà `createJob` đã phải học
-- một lần cho nguồn upload (apps/web/app/app/actions.ts).
create or replace function public.register_media_asset(
  p_job_id uuid,
  p_storage_path text,
  p_name text
)
returns public.media_assets
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_segments text[];
  v_name text := trim(coalesce(p_name, ''));
  v_count int;
  v_asset public.media_assets;
begin
  if not exists (select 1 from public.jobs where id = p_job_id and user_id = v_user) then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;

  v_segments := string_to_array(coalesce(p_storage_path, ''), '/');
  if array_length(v_segments, 1) is distinct from 4
     or v_segments[1] <> 'media'
     or v_segments[2] <> v_user::text
     or v_segments[3] <> p_job_id::text
     or v_segments[4] !~ '^[0-9a-fA-F-]{36}\.[a-zA-Z0-9]{2,5}$' then
    raise exception 'That media file is no longer available. Please try again.'
      using errcode = '22023';
  end if;

  if v_name = '' then
    raise exception 'This media file needs a name.' using errcode = '22023';
  end if;
  if char_length(v_name) > 200 then
    v_name := left(v_name, 200);
  end if;

  -- Trần theo project: B-roll là file video, 50 cái đã là một thư viện.
  select count(*) into v_count from public.media_assets where job_id = p_job_id;
  if v_count >= 50 then
    raise exception 'This project already has 50 media files.' using errcode = 'P0001';
  end if;

  insert into public.media_assets (user_id, job_id, storage_path, name)
  values (v_user, p_job_id, p_storage_path, v_name)
  on conflict (storage_path) do nothing
  returning * into v_asset;

  -- Gọi lại cùng đường dẫn (mạng gửi lại) trả đúng bản ghi cũ.
  if not found then
    select * into v_asset from public.media_assets
    where storage_path = p_storage_path and user_id = v_user;
    if not found then
      raise exception 'That media file is no longer available. Please try again.'
        using errcode = '22023';
    end if;
  end if;

  return v_asset;
end;
$$;

-- ---------------------------------------------------------------- project

create or replace function public.rename_project(p_job_id uuid, p_name text)
returns public.jobs
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_name text := trim(coalesce(p_name, ''));
  v_job public.jobs;
begin
  if v_name = '' then
    raise exception 'Name this project before saving it.' using errcode = '22023';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'Keep the project name under 120 characters.' using errcode = '22023';
  end if;

  update public.jobs set name = v_name
  where id = p_job_id and user_id = v_user
  returning * into v_job;

  if not found then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  return v_job;
end;
$$;

-- Huỷ chỉ đổi trạng thái. Worker thấy job không còn 'running' ở nhịp heartbeat
-- kế tiếp và tự dừng; hoàn credit là việc của đường billing (D4).
create or replace function public.cancel_job(p_job_id uuid)
returns public.jobs
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_job public.jobs;
begin
  update public.jobs
  set status = 'cancelled', finished_at = now(), lease_until = null
  where id = p_job_id and user_id = v_user and status in ('queued', 'running')
  returning * into v_job;

  if not found then
    if exists (select 1 from public.jobs where id = p_job_id and user_id = v_user) then
      raise exception 'This project has already finished.' using errcode = '22023';
    end if;
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  return v_job;
end;
$$;

-- Xoá khi còn chạy là để lại một worker ghi vào bảng vừa biến mất. Bắt huỷ
-- trước, giống `store.delete` của bản local.
create or replace function public.delete_job(p_job_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_status public.job_status;
begin
  select status into v_status from public.jobs where id = p_job_id and user_id = v_user;
  if not found then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if v_status = 'running' then
    raise exception 'Stop this project before deleting it.' using errcode = '22023';
  end if;

  delete from public.jobs where id = p_job_id and user_id = v_user;
  return found;
end;
$$;

-- ----------------------------------------------------------- list_projects
--
-- Phân trang KEYSET, không OFFSET: trang thứ 50 của OFFSET vẫn phải đếm qua
-- 49 trang trước. Con trỏ là cặp `(created_at, id)` vì hai job tạo trong cùng
-- một mili giây thì `created_at` không phá hoà được.
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

-- --------------------------------------------------------- rate_limit_hit
--
-- Cửa sổ cố định, một câu SQL, O(1). Trả `true` khi lượt gọi này còn trong hạn
-- mức. Không Redis — thêm một nhà cung cấp chỉ để đếm số nguyên là không đáng.
create or replace function public.rate_limit_hit(
  p_bucket text,
  p_limit int,
  p_window_seconds int
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_count int;
begin
  if p_bucket is null or p_bucket = '' or p_limit < 1 or p_window_seconds < 1 then
    raise exception 'Invalid rate limit.' using errcode = '22023';
  end if;

  insert into public.rate_limits (user_id, bucket, window_start, count)
  values (
    v_user,
    p_bucket,
    to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds),
    1
  )
  on conflict (user_id, bucket, window_start)
  do update set count = rate_limits.count + 1
  returning count into v_count;

  return v_count <= p_limit;
end;
$$;

-- ----------------------------------------------------------------- quyền
do $$
declare
  f text;
begin
  -- Hàm nội bộ: không vai nào gọi trực tiếp được.
  foreach f in array array[
    'public.require_user()',
    'public.owned_clip(uuid, uuid)',
    'public.draft_json(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;

  -- RPC của người dùng: chỉ `authenticated`. `anon` không có gì để làm ở đây.
  foreach f in array array[
    'public.save_draft(uuid, int, jsonb, text)',
    'public.request_preview(uuid, jsonb, text, uuid)',
    'public.request_export(uuid, uuid, uuid)',
    'public.save_preset(text, jsonb)',
    'public.delete_preset(uuid)',
    'public.register_media_asset(uuid, text, text)',
    'public.rename_project(uuid, text)',
    'public.cancel_job(uuid)',
    'public.delete_job(uuid)',
    'public.list_projects(timestamptz, uuid, text, int)',
    'public.rate_limit_hit(text, int, int)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
