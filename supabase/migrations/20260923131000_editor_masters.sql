-- Giai đoạn 3 của editor mới: engine cắt `master.mp4` (một lượt `-c copy`, độ
-- phân giải nguồn) và ghi `transcript.json` cạnh nó, cả hai vào bucket
-- `renders` dưới `{uid}/{clip_id}/master/`. Manifest của job mang chúng ở
-- `media_manifest.masters`.
--
-- Retention phải biết về chúng, nếu không hai file mỗi clip sống sót qua lần
-- dọn project và không có gì trỏ tới chúng nữa. `renders` đã nằm trong
-- allowlist bucket ở cuối hàm, nên đây chỉ là hai nhánh `union` mới.
--
-- Chép NGUYÊN hàm chứ không vá: `create or replace` thay trọn thân hàm, và một
-- bản vá từng dòng không tồn tại trong SQL.
--
-- CẢNH BÁO CHO MIGRATION SAU: bất kỳ `create or replace` nào khác trên
-- `enqueue_job_objects` (bucket `exports` của Giai đoạn 4 là cái sắp tới) phải
-- chép LẠI hai nhánh `masters` dưới đây. Thay trọn thân hàm mà quên chúng là
-- hai file mỗi clip sống sót qua mọi lần dọn, và không có test nào của nhánh
-- kia sẽ thấy điều đó.

create or replace function public.enqueue_job_objects(p_job_id uuid)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_rows int;
begin
  select * into v_job from public.jobs where id = p_job_id;
  if not found then return 0; end if;

  insert into public.storage_deletions (bucket, path, job_id, user_id)
  select found_path.bucket, found_path.path, p_job_id, v_job.user_id
  from (
    -- Clip đã công bố.
    select 'clips'::text as bucket, c.storage_path as path
      from public.clips c where c.job_id = p_job_id
    union
    select 'clips', c.preview_path from public.clips c where c.job_id = p_job_id
    union
    -- Manifest task: mp4 + srt/txt + ZIP. `output_path` đi kèm cho attempt đã
    -- upload xong nhưng chưa kịp ghi manifest.
    select coalesce(entry.value->>'bucket', 'renders'), entry.value->>'object'
      from public.tasks t
      left join public.clips c on c.id = t.clip_id
      cross join lateral jsonb_each(
        case when jsonb_typeof(t.output->'manifest'->'files') = 'object'
             then t.output->'manifest'->'files' else '{}'::jsonb end) entry
     where t.job_id = p_job_id or c.job_id = p_job_id
    union
    select coalesce(section.value->>'bucket', 'sources'), section.value->>'object'
      from public.tasks t
      left join public.clips c on c.id = t.clip_id
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(t.output->'manifest'->'sections') = 'array'
             then t.output->'manifest'->'sections' else '[]'::jsonb end) section
     where t.job_id = p_job_id or c.job_id = p_job_id
    union
    select 'renders', t.output_path
      from public.tasks t
      left join public.clips c on c.id = t.clip_id
     where t.job_id = p_job_id or c.job_id = p_job_id
    union
    -- B-roll: `storage_path` lưu kèm tên bucket ở segment đầu ('media/<uid>/…').
    select 'media', substring(m.storage_path from 7)
      from public.media_assets m
     where m.job_id = p_job_id and m.storage_path like 'media/%'
    union
    -- Cache section và proxy editor đã công bố của chính job.
    select coalesce(section.value->>'bucket', 'sources'), section.value->>'object'
      from jsonb_array_elements(
        case when jsonb_typeof(v_job.media_manifest->'sections') = 'array'
             then v_job.media_manifest->'sections' else '[]'::jsonb end) section
    union
    select coalesce(proxy.value->>'bucket', 'sources'), proxy.value->>'object'
      from jsonb_each(
        case when jsonb_typeof(v_job.media_manifest->'proxies') = 'object'
             then v_job.media_manifest->'proxies' else '{}'::jsonb end) proxy
    union
    -- Master + transcript của editor mới: worker ghi vào `renders`, một cặp
    -- cho mỗi clip. Cùng khuôn với nhánh `proxies` ngay trên, nhưng hai cột —
    -- transcript là một object riêng, và bỏ sót nó là một file JSON mồ côi
    -- sống mãi sau khi project đã bị dọn.
    select coalesce(master.value->>'bucket', 'renders'), master.value->>'object'
      from jsonb_each(
        case when jsonb_typeof(v_job.media_manifest->'masters') = 'object'
             then v_job.media_manifest->'masters' else '{}'::jsonb end) master
    union
    select coalesce(master.value->>'bucket', 'renders'), master.value->>'transcript'
      from jsonb_each(
        case when jsonb_typeof(v_job.media_manifest->'masters') = 'object'
             then v_job.media_manifest->'masters' else '{}'::jsonb end) master
    union
    -- Nguồn upload. Link YouTube không có object nào để xoá.
    select 'sources', substring(v_job.source_url from 11)
     where v_job.source_url like 'storage://%'
  ) as found_path
  where found_path.path is not null
    and found_path.path <> ''
    and found_path.path not like '%..%'
    and found_path.bucket in ('clips', 'sources', 'renders', 'media')
  on conflict (bucket, path) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;
