-- R1 (lộ trình dọn hệ video): gỡ đường export cũ theo settings.
--
-- Từ editor-rewrite C3, mọi bản xuất đi qua document: `request_document_export`
-- → task `render_document` → clip-export. Đường cũ (`save_draft` → `request_preview`
-- / `request_export` → task `preview`/`export` → ffmpeg+ASS) chỉ còn Crop nhanh
-- dùng, mà Crop nhanh đã bỏ. Hai đường sống song song nghĩa là cùng một clip ra
-- hai kiểu phụ đề, và trang project / ZIP không thấy bản xuất từ editor.
--
-- Xoá hàng cũ thay vì giữ làm lịch sử (khác quyết định ở `drop_client_export`):
-- sản phẩm CHƯA deploy lần nào, nên chỉ DB local có các hàng này. Trigger dọn
-- Storage trên `tasks` ghi lại file của chúng để cron xoá như mọi task khác.
--
-- GIỮ `clip_drafts`/`clip_revisions`: đó là settings gốc pipeline ghi khi publish
-- clip, và bộ sinh project editor đọc từ đó. Gỡ chúng cần chỗ chứa khác (R7).

begin;

delete from public.tasks where kind in ('preview', 'export', 'client_export', 'finalize');

alter table public.tasks drop constraint tasks_kind_check;
alter table public.tasks
  add constraint tasks_kind_check
  check (kind in ('probe_media', 'zip', 'generate', 'render_document', 'prepare_full', 'transcribe_media'));

-- Hai index khử trùng chỉ phục vụ task `preview`/`export`.
drop index if exists public.tasks_preview_dedupe_idx;
drop index if exists public.tasks_export_active_idx;

drop function if exists public.request_preview(uuid, jsonb, text, uuid);
drop function if exists public.request_export(uuid, uuid, uuid);
drop function if exists public.save_draft(uuid, int, jsonb, text);

-- ZIP gói bản xuất từ editor: `render_document` đã xong mới nhất của mỗi clip.
-- Payload giữ đúng hợp đồng với `opencmo/worker/zip_task.py` (`export_task_ids`).
create or replace function public.request_zip(
  p_job_id uuid,
  p_clip_ids uuid[],
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
  v_count int;
  v_items jsonb;
  v_task public.tasks;
begin
  if p_request_id is null then
    raise exception 'Missing request id.' using errcode = '22023';
  end if;
  if p_clip_ids is null or array_length(p_clip_ids, 1) is null then
    raise exception 'Choose at least one clip.' using errcode = '22023';
  end if;
  -- Trần 10: `zip_task.py` từ chối payload dài hơn thế.
  if array_length(p_clip_ids, 1) > 10 then
    raise exception 'Choose at most 10 clips.' using errcode = '22023';
  end if;

  if not exists (select 1 from public.jobs where id = p_job_id and user_id = v_user) then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;

  -- Gọi lại cùng request_id (mạng gửi lại, bấm hai lần) trả đúng task cũ.
  select * into v_task from public.tasks where request_id = p_request_id;
  if found then
    if v_task.kind <> 'zip' or v_task.job_id is distinct from p_job_id then
      raise exception 'This request id was already used for something else.'
        using errcode = '22023';
    end if;
    return v_task;
  end if;

  -- Ảnh chụp lúc bấm: bản mới nhất là revision editor LỚN NHẤT, không phải task
  -- xong sau cùng — cùng luật với `latestExportByRevision` của trang project, để
  -- ZIP chứa đúng file mà trang đang cho tải. Chỉ clip thuộc đúng project + đúng
  -- người dùng: worker chạy bằng service role sẽ gói bất cứ id nào ở đây.
  select count(*), jsonb_agg(to_jsonb(t.id::text) order by t.idx)
    into v_count, v_items
  from (
    select distinct on (c.id)
      c.id as clip_id, c.idx, k.id
    from public.clips c
    join public.jobs j on j.id = c.job_id
    join public.tasks k on k.clip_id = c.id
    join public.editor_revisions r on r.id = k.editor_revision_id
    where c.id = any(p_clip_ids)
      and c.job_id = p_job_id
      and j.user_id = v_user
      and k.kind = 'render_document'
      and k.status = 'done'
    order by c.id, r.number desc, k.finished_at desc nulls last
  ) t;

  if v_count = 0 then
    raise exception 'Export these clips before downloading them together.'
      using errcode = 'P0002';
  end if;

  insert into public.tasks (user_id, kind, job_id, payload, request_id)
  values (v_user, 'zip', p_job_id, jsonb_build_object('export_task_ids', v_items), p_request_id)
  on conflict do nothing
  returning * into v_task;

  if not found then
    select * into v_task from public.tasks where request_id = p_request_id;
    if not found then
      raise exception 'Could not start the download. Please try again.' using errcode = 'P0001';
    end if;
  end if;
  return v_task;
end;
$$;

commit;
