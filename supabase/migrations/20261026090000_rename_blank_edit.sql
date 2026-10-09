-- 20261026090000: đổi tên bản New edit (G1-a). Tên nằm ở `jobs.title` và `clips.hook`
-- (ô chọn clip đọc cả hai) — đổi cùng lúc, chỉ cho bản `blank` của chính người gọi.

begin;

create or replace function public.rename_blank_edit(p_clip_id uuid, p_name text)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_name text := left(btrim(coalesce(p_name, '')), 120);
  v_clip public.clips;
begin
  if v_name = '' then
    raise exception 'Give the edit a name.' using errcode = '22023';
  end if;
  v_clip := public.owned_clip(p_clip_id, v_user);
  if v_clip.kind <> 'blank' then
    raise exception 'Only edits started from a blank canvas can be renamed here.' using errcode = '22023';
  end if;
  update public.clips set hook = v_name where id = v_clip.id;
  update public.jobs set title = v_name where id = v_clip.job_id;
  return v_name;
end;
$$;

revoke all on function public.rename_blank_edit(uuid, text) from public, anon;
grant execute on function public.rename_blank_edit(uuid, text) to authenticated;

commit;
