-- Sửa tranh chấp request, revision và hạn mức media; giữ nguyên chữ ký RPC.

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
  v_settings jsonb;
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

  select r.number, r.settings_hash, r.settings into v_number, v_hash, v_settings
  from public.clip_revisions r
  where r.id = v_current_id;

  if v_number is distinct from p_expected_revision then
    -- `detail` mang theo draft hiện hành để UI vẽ được "bản kia đang là gì"
    -- mà không phải gọi thêm một vòng.
    raise exception 'This clip was changed in another tab.'
      using errcode = 'P0409', detail = public.draft_json(p_clip_id)::text;
  end if;

  -- Cùng nội dung thì không sinh revision mới: người dùng bấm Save hai lần
  -- không được đẻ ra hai bản y hệt trong lịch sử.
  if v_hash = p_settings_hash and v_settings = p_settings then
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
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'Clip settings must be an object.' using errcode = '22023';
  end if;
  if pg_column_size(p_settings) >= 65536 then
    raise exception 'These clip settings are too large to save.' using errcode = '22023';
  end if;
  if p_settings_hash is null or p_settings_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid settings fingerprint.' using errcode = '22023';
  end if;
  if p_request_id is null then
    raise exception 'Missing request id.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  -- Khoá request toàn cục trước khi đọc; lần gọi chờ phải đọc snapshot mới.
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 1701));
  select * into v_task from public.tasks where request_id = p_request_id;
  if found then
    if v_task.user_id is distinct from v_user
       or v_task.kind <> 'preview' or v_task.clip_id is distinct from p_clip_id
       or v_task.settings_hash is distinct from p_settings_hash
       or v_task.payload->'settings' is distinct from p_settings then
      raise exception 'This request id was already used for something else.'
        using errcode = '22023';
    end if;
    return v_task;
  end if;

  -- Hạn mức an toàn D1, độc lập quota thanh toán D4. Khoá theo user.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 1702));
  select * into v_task from public.tasks where kind = 'preview' and clip_id = p_clip_id and settings_hash = p_settings_hash
    and status in ('queued', 'running', 'done') limit 1;
  if found then
    if v_task.user_id is distinct from v_user or v_task.payload->'settings' is distinct from p_settings then
      raise exception 'This request id was already used for something else.' using errcode = '22023';
    end if;
    return v_task;
  end if;
  if (select count(*) from public.tasks where user_id = v_user
      and kind in ('preview', 'export') and status in ('queued', 'running')) >= 20 then
    raise exception 'You already have 20 previews or exports in progress. Please wait for one to finish.'
      using errcode = 'P0001';
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
  if v_task.user_id is distinct from v_user or v_task.kind <> 'preview'
     or v_task.clip_id is distinct from p_clip_id
     or v_task.settings_hash is distinct from p_settings_hash
     or v_task.payload->'settings' is distinct from p_settings then
    raise exception 'This request id was already used for something else.' using errcode = '22023';
  end if;
  return v_task;
end;
$$;

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
  -- Khoá request toàn cục trước khi đọc; lần gọi chờ phải đọc snapshot mới.
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 1701));
  select * into v_task from public.tasks where request_id = p_request_id;
  if found then
    if v_task.user_id is distinct from v_user or v_task.kind <> 'export'
       or v_task.clip_id is distinct from p_clip_id
       or v_task.revision_id is distinct from p_revision_id then
      raise exception 'This export request was already used for another clip or revision.'
        using errcode = '22023';
    end if;
    return v_task;
  end if;

  -- Hạn mức an toàn D1, độc lập quota thanh toán D4. Khoá theo user.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 1702));
  select * into v_task from public.tasks where kind = 'export' and clip_id = p_clip_id and revision_id = p_revision_id
    and status in ('queued', 'running', 'done') limit 1;
  if found then
    return v_task;
  end if;
  if (select count(*) from public.tasks where user_id = v_user
      and kind in ('preview', 'export') and status in ('queued', 'running')) >= 20 then
    raise exception 'You already have 20 previews or exports in progress. Please wait for one to finish.'
      using errcode = 'P0001';
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
  if v_task.user_id is distinct from v_user or v_task.kind <> 'export'
     or v_task.clip_id is distinct from p_clip_id
     or v_task.revision_id is distinct from p_revision_id then
    raise exception 'This request id was already used for something else.' using errcode = '22023';
  end if;
  return v_task;
end;
$$;

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
  -- Khoá project để đếm và chèn media trong cùng một vùng tuần tự.
  perform 1 from public.jobs where id = p_job_id and user_id = v_user for update;
  if not found then
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

  -- Replay phải thành công ngay cả khi project đã đủ 50 file.
  select * into v_asset from public.media_assets
  where storage_path = p_storage_path and user_id = v_user and job_id = p_job_id;
  if found then
    return v_asset;
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
