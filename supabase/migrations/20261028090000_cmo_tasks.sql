-- 20261028090000: CMO chat giao việc có hẹn ngày (H3).
--
-- `create_task` của CMO chat: việc "làm ngay" vào hàng đợi `cmo_runs` như cũ; việc có ngày, và
-- MỌI việc video (luật 3: người dùng tự đưa video của mình vào), thành một mục `planned` trên lịch.
-- Cron chạy mục X/Reddit tới hạn; mục video có nút "Make clips" mở tab Clips của editor.
-- Trước đây chỉ W1 (service role) ghi được lịch — người dùng/agent chat không thêm được mục nào.

begin;

create or replace function public.cmo_add_item(
  p_department text,
  p_idea text,
  p_day date,
  p_reason text default '',
  p_body jsonb default '{}'::jsonb
)
returns public.content_items language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_platform text;
  v_row public.content_items;
begin
  if p_department is null or p_department not in ('post', 'sales', 'video') then
    raise exception 'Pick X, Reddit or video for this task.' using errcode = '22023';
  end if;
  if p_idea is null or char_length(trim(p_idea)) = 0 or char_length(p_idea) > 300 then
    raise exception 'Write the idea in 300 characters or fewer.' using errcode = '22023';
  end if;
  if p_day is null or p_day < current_date or p_day > current_date + 13 then
    raise exception 'Pick a day in the next two weeks.' using errcode = '22023';
  end if;
  if char_length(coalesce(p_reason, '')) > 300 then
    raise exception 'Keep the reason under 300 characters.' using errcode = '22023';
  end if;
  if p_body is null or jsonb_typeof(p_body) <> 'object' or octet_length(p_body::text) > 4096 then
    raise exception 'This task has too much detail.' using errcode = '22023';
  end if;
  -- Trần mục còn mở: một agent chat lặp vòng không được đổ đầy lịch.
  if (select count(*) from public.content_items where user_id = v_user and status = 'planned' and day >= current_date) >= 40 then
    raise exception 'Your calendar is full for the next two weeks. Remove an item first.' using errcode = 'P0001';
  end if;
  v_platform := case p_department when 'post' then 'X' when 'sales' then 'Reddit' else 'Shorts' end;
  insert into public.content_items (user_id, department, platform, day, idea, reason, body)
  values (v_user, p_department, v_platform, p_day, trim(p_idea), coalesce(trim(p_reason), ''), p_body || jsonb_build_object('source', 'cmo_chat'))
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.cmo_add_item(text, text, date, text, jsonb) from public, anon;
grant execute on function public.cmo_add_item(text, text, date, text, jsonb) to authenticated;

commit;
