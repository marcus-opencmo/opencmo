-- 20261027090000: cắt clip từ trong editor (G1-b) + chốt xác nhận chính chủ cho MỌI job.
--
-- Rà luồng cắt clip 04/10 thấy `/app/video` nhận link mà không hỏi "Is this your video?" —
-- chỉ CMO video pack có hộp xác nhận (luật 3, Creem cấm "content downloaders"). Giờ một
-- cửa duy nhất: `create_clip_job` = `create_job` + ghi `video_ownership`, một giao dịch.
-- Link (`https://`) mà không xác nhận thì từ chối; file tải lên là của người dùng theo
-- định nghĩa và vẫn được ghi `source = 'upload'`.
--
-- `create_job` thôi công khai: gọi thẳng RPC đó bằng curl là bỏ qua được hộp xác nhận.
-- Các RPC security definer (`create_video_pack`) vẫn gọi được nó như cũ.

begin;

create or replace function public.create_clip_job(
  p_source_url text,
  p_clips int default 5,
  p_length text default 'auto',
  p_segments jsonb default null,
  p_mode text default 'clip',
  p_aspect text default '9:16',
  p_layout text default 'auto',
  p_captions boolean default true,
  p_caption_preset text default 'bold',
  p_ownership_confirmed boolean default false
)
returns public.jobs
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_source text := btrim(coalesce(p_source_url, ''));
  v_upload boolean := v_source like 'storage://%';
  v_job public.jobs;
begin
  if not v_upload and not coalesce(p_ownership_confirmed, false) then
    raise exception 'Confirm this is your own video to continue.' using errcode = '22023';
  end if;
  v_job := public.create_job(v_source, p_clips, p_length, p_segments, p_mode, p_aspect, p_layout, p_captions, p_caption_preset);
  insert into public.video_ownership (job_id, user_id, source, url)
  values (v_job.id, v_user, case when v_upload then 'upload' else 'link' end, case when v_upload then null else v_source end);
  return v_job;
end;
$$;

revoke all on function public.create_clip_job(text, int, text, jsonb, text, text, text, boolean, text, boolean) from public, anon;
grant execute on function public.create_clip_job(text, int, text, jsonb, text, text, text, boolean, text, boolean) to authenticated;

revoke execute on function public.create_job(text, int, text, jsonb, text, text, text, boolean, text) from authenticated;

commit;
