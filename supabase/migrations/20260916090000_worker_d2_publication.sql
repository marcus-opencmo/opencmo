-- OpenCMO — xuất bản job nguyên tử cho worker D2, và chặn client xoá object
-- đang được trỏ tới.
--
-- Vì sao cần RPC mới: `complete_job` chèn clip với id do DB sinh, nên proxy,
-- face_track và draft chỉ làm được SAU khi job đã hiện "done". Người dùng mở
-- editor đúng khoảnh khắc đó thấy clip không có draft, không có proxy. Worker D2
-- tự sinh id clip từ trước, dựng xong mọi thứ, rồi công bố tất cả trong MỘT
-- giao dịch: hoặc người dùng thấy job đầy đủ, hoặc không thấy gì.

-- ------------------------------------------------------------------- jobs

-- Manifest liệt kê section + proxy mà attempt thắng đã upload. Cache section và
-- editor đọc từ đây thay vì liệt kê bucket. Cỡ thật vài KB; trần 1 MB chặn việc
-- worker lỗi nhét cả transcript vào đây — tuple lớn hơn thế là dấu hiệu hỏng logic.
alter table public.jobs add column if not exists media_manifest jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'jobs_media_manifest_size_check'
  ) then
    alter table public.jobs
      add constraint jobs_media_manifest_size_check
      check (media_manifest is null or pg_column_size(media_manifest) < 1000000);
  end if;
end;
$$;

-- `create_job` là RPC công khai cho authenticated nên kiểm tra ở server action
-- chưa đủ. Worker chạy service role; một path có `..` hoặc scheme local nếu lọt
-- vào đây sẽ biến thành đọc file của user khác/đọc mạng nội bộ.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'jobs_source_url_check'
  ) then
    alter table public.jobs add constraint jobs_source_url_check check (
      source_url ~ '^https?://[^[:space:]]+$'
      or source_url ~ (
        '^storage://' || user_id::text || '/[A-Za-z0-9][A-Za-z0-9._-]{0,240}$'
      )
    );
  end if;
end;
$$;

-- ------------------------------------------------------------ xuất bản job

-- Trả về: true = job done bởi attempt này (lần đầu hoặc replay sau khi mất
-- response); false = attempt không còn hiện hành hoặc job không running — không
-- ghi gì. Lỗi đầu vào raise bằng tiếng Anh vì PostgREST trả nguyên văn.
create or replace function public.complete_job_publication(
  p_job_id uuid,
  p_attempt_id uuid,
  p_title text,
  p_duration_seconds numeric,
  p_clips jsonb,
  p_revisions jsonb,
  p_manifest jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_job public.jobs;
  v_previous jsonb;
begin
  -- Khoá hàng job trước mọi kiểm tra: reclaim/cancel chạy song song phải chờ,
  -- không thì attempt có thể bị requeue giữa lúc đang chèn clip.
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or p_attempt_id is null then
    return false;
  end if;

  -- Fence đứng TRƯỚC validate: attempt cũ về muộn chỉ nhận false, không được
  -- làm worker tưởng mình gửi dữ liệu hỏng.
  if v_job.status = 'done' and v_job.attempt_id = p_attempt_id then
    return true;
  end if;
  if v_job.status <> 'running' or v_job.attempt_id is distinct from p_attempt_id then
    return false;
  end if;

  if p_clips is null or jsonb_typeof(p_clips) <> 'array' then
    raise exception 'Clips must be a list.' using errcode = '22023';
  end if;
  if p_revisions is null or jsonb_typeof(p_revisions) <> 'array' then
    raise exception 'Revisions must be a list.' using errcode = '22023';
  end if;
  if p_manifest is null or jsonb_typeof(p_manifest) <> 'object' then
    raise exception 'The media manifest must be an object.' using errcode = '22023';
  end if;

  -- Kiểm hình dạng trước khi ép kiểu: lỗi cast uuid/numeric của Postgres là
  -- message kỹ thuật, không nên lọt ra màn hình.
  if exists (
    select 1 from jsonb_array_elements(p_clips) c
    where jsonb_typeof(c) <> 'object'
       or coalesce(c ->> 'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       or jsonb_typeof(c -> 'idx') is distinct from 'number'
       or (c ->> 'idx') !~ '^[0-9]{1,6}$'
       or jsonb_typeof(c -> 'start_seconds') is distinct from 'number'
       or jsonb_typeof(c -> 'end_seconds') is distinct from 'number'
  ) then
    raise exception 'A clip is missing required fields.' using errcode = '22023';
  end if;

  -- Bảng có check `source_end > source_start`, nhưng message constraint là chữ
  -- kỹ thuật; chặn ở đây để lỗi hiện ra còn đọc được.
  if exists (
    select 1 from jsonb_array_elements(p_clips) c
    where (c ->> 'end_seconds')::numeric <= (c ->> 'start_seconds')::numeric
  ) then
    raise exception 'A clip must end after it starts.' using errcode = '22023';
  end if;

  if (select count(distinct c ->> 'id') <> count(*) or count(distinct (c ->> 'idx')::int) <> count(*)
      from jsonb_array_elements(p_clips) c) then
    raise exception 'Clips must have unique ids and positions.' using errcode = '22023';
  end if;

  -- Không thay thế âm thầm clip cũ ở cùng vị trí: draft/task đang trỏ vào id cũ
  -- sẽ thành mồ côi hoặc bị cascade xoá mất lịch sử sửa của người dùng.
  if exists (
    select 1
    from jsonb_array_elements(p_clips) c
    join public.clips old
      on (old.job_id = p_job_id and old.idx = (c ->> 'idx')::int and old.id <> (c ->> 'id')::uuid)
      or (old.id = (c ->> 'id')::uuid and (old.job_id <> p_job_id or old.idx <> (c ->> 'idx')::int))
  ) then
    raise exception 'A different clip already exists at this position.' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_revisions) r
    where jsonb_typeof(r) <> 'object'
       or jsonb_typeof(r -> 'settings') is distinct from 'object'
       or coalesce(r ->> 'settings_hash', '') !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'Clip settings are invalid.' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_revisions) r
    where not exists (
      select 1 from jsonb_array_elements(p_clips) c where c ->> 'id' = r ->> 'clip_id'
    )
  ) then
    raise exception 'A revision points to a clip that is not being published.' using errcode = '22023';
  end if;

  if (select count(distinct r ->> 'clip_id') <> count(*) from jsonb_array_elements(p_revisions) r) then
    raise exception 'Each clip can have only one starting revision.' using errcode = '22023';
  end if;

  -- Biên nhận khác đầu vào nghĩa là cùng attempt đã khởi tạo draft bằng dữ liệu
  -- khác — ghi tiếp là để hai phiên bản sự thật cùng tồn tại.
  select revisions into v_previous from public.worker_draft_initializations
  where job_id = p_job_id and attempt_id = p_attempt_id;
  if found and v_previous is distinct from p_revisions then
    raise exception 'Drafts were already initialized with different content.' using errcode = '22023';
  end if;

  insert into public.clips (
    id, job_id, idx, hook, start_seconds, end_seconds, score, reason,
    storage_path, preview_path, source_start, source_end
  )
  select (c ->> 'id')::uuid, p_job_id, (c ->> 'idx')::int, c ->> 'hook',
         (c ->> 'start_seconds')::numeric, (c ->> 'end_seconds')::numeric,
         (c ->> 'score')::numeric, c ->> 'reason', c ->> 'storage_path', c ->> 'preview_path',
         (c ->> 'start_seconds')::numeric, (c ->> 'end_seconds')::numeric
  from jsonb_array_elements(p_clips) c
  where not exists (select 1 from public.clips old where old.id = (c ->> 'id')::uuid);

  -- Clip đã có draft (người dùng đã sửa) giữ nguyên con trỏ; revision bất biến
  -- nên không bao giờ ghi đè, chỉ thêm #1 cho clip chưa có gì.
  with wanted as (
    select (r ->> 'clip_id')::uuid clip_id, r -> 'settings' settings, r ->> 'settings_hash' settings_hash
    from jsonb_array_elements(p_revisions) r
  ), made as (
    insert into public.clip_revisions (clip_id, number, settings, settings_hash)
    select w.clip_id, 1, w.settings, w.settings_hash from wanted w
    where not exists (select 1 from public.clip_drafts d where d.clip_id = w.clip_id)
    returning id, clip_id
  )
  insert into public.clip_drafts (clip_id, revision_id) select clip_id, id from made;

  if v_previous is null then
    insert into public.worker_draft_initializations (job_id, attempt_id, revisions)
    values (p_job_id, p_attempt_id, p_revisions);
  end if;

  update public.jobs
  set media_manifest = p_manifest,
      title = p_title,
      duration_seconds = p_duration_seconds,
      status = 'done',
      finished_at = now(),
      lease_until = null
  where id = p_job_id;

  return true;
end;
$$;

revoke execute on function public.complete_job_publication(uuid, uuid, text, numeric, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_job_publication(uuid, uuid, text, numeric, jsonb, jsonb, jsonb)
  to service_role;

-- --------------------------------------------------------- storage delete

-- Probe và render tin rằng object sau một key đang được trỏ tới KHÔNG BAO GIỜ
-- đổi: duration/kích thước đã probe, section đã cắt, task đã khử trùng theo key.
-- Không có policy UPDATE nên client không ghi đè được, nhưng xoá rồi upload lại
-- cùng tên thì vẫn thay được nội dung. Vì vậy client chỉ xoá được object CHƯA
-- ai trỏ tới (upload dở dang, file huỷ); dọn object đang dùng là việc của
-- worker/cron bằng service role.
--
-- Cột phải ghi `objects.name`: `jobs` và `media_assets` đều có cột `name`, viết
-- trống sẽ so nhầm với tên project/tên file B-roll.
--
-- Bucket `sources` còn chứa file của worker ở `<uid>/<job_id>/sections|proxy/...`
-- — cache section và proxy editor tin vào đúng key đó (upload không upsert,
-- "đã tồn tại cùng dung lượng" coi là thành công). Nếu client được ghi/xoá ở độ
-- sâu đó thì có thể cài sẵn hoặc rút mất file worker. Web chỉ upload đúng
-- `<uid>/<tên>__<uuid>.<ext>` (`lib/storage.ts`), nên khoá client vào đúng một
-- tầng thư mục: `foldername` dài đúng 1 phần tử và phần tử đó là uid.
drop policy if exists "ghi file nguồn vào thư mục của mình" on storage.objects;
create policy "ghi file nguồn vào thư mục của mình"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'sources'
    and array_length(storage.foldername(name), 1) = 1
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "xoá file nguồn trong thư mục của mình" on storage.objects;
create policy "xoá file nguồn trong thư mục của mình"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'sources'
    and array_length(storage.foldername(objects.name), 1) = 1
    and (storage.foldername(objects.name))[1] = (select auth.uid())::text
    and not exists (
      select 1 from public.jobs j where j.source_url = 'storage://' || objects.name
    )
  );

drop policy if exists "xoá B-roll trong thư mục của mình" on storage.objects;
create policy "xoá B-roll trong thư mục của mình"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'media'
    and (storage.foldername(objects.name))[1] = (select auth.uid())::text
    and not exists (
      select 1 from public.media_assets m where m.storage_path = 'media/' || objects.name
    )
  );
