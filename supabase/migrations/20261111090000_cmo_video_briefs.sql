-- 20261111090000: CMO → editor assistant bridge (architecture P3).
--
-- The CMO chat can write a video brief (hook, b-roll, visuals, pacing) for clips cut from one of
-- the founder's OWN videos (a clipping job they started, after the ownership confirmation). The
-- brief is a card in Approvals. Approving it only opens the project with the brief filled into the
-- project assistant: the founder sends it, and every edit still waits for the assistant's own
-- approval card. Nothing is applied by the CMO.

begin;

create table public.cmo_video_briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  hook text not null check (char_length(hook) between 1 and 200),
  broll text not null default '' check (char_length(broll) <= 600),
  visuals text not null default '' check (char_length(visuals) <= 600),
  pacing text not null default '' check (char_length(pacing) <= 300),
  status text not null default 'in_review' check (status in ('in_review', 'approved', 'skipped')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index cmo_video_briefs_user_idx on public.cmo_video_briefs (user_id, status, created_at desc);
alter table public.cmo_video_briefs enable row level security;
create policy "read own video briefs" on public.cmo_video_briefs
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.cmo_video_briefs from anon, authenticated;

-- CMO chat (runs as the founder). The job must be theirs: briefs never point at someone else's video.
create or replace function public.cmo_create_video_brief(p_job uuid, p_hook text, p_broll text, p_visuals text, p_pacing text)
returns public.cmo_video_briefs language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_row public.cmo_video_briefs;
begin
  if not exists (select 1 from public.jobs where id = p_job and user_id = v_user) then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.clips where job_id = p_job and kind = 'moment') then
    raise exception 'This project has no clips yet. Make clips first.' using errcode = 'P0001';
  end if;
  if p_hook is null or char_length(trim(p_hook)) = 0 or char_length(p_hook) > 200 then
    raise exception 'The hook must be 1 to 200 characters.' using errcode = '22023';
  end if;
  if char_length(coalesce(p_broll, '')) > 600 or char_length(coalesce(p_visuals, '')) > 600 or char_length(coalesce(p_pacing, '')) > 300 then
    raise exception 'This brief is too long.' using errcode = '22023';
  end if;
  if (select count(*) from public.cmo_video_briefs where user_id = v_user and status = 'in_review') >= 10 then
    raise exception 'You have 10 video briefs waiting. Approve or skip some first.' using errcode = 'P0001';
  end if;
  insert into public.cmo_video_briefs (user_id, job_id, hook, broll, visuals, pacing)
  values (v_user, p_job, trim(p_hook), trim(coalesce(p_broll, '')), trim(coalesce(p_visuals, '')), trim(coalesce(p_pacing, '')))
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.cmo_create_video_brief(uuid, text, text, text, text) from public, anon;
grant execute on function public.cmo_create_video_brief(uuid, text, text, text, text) to authenticated;

-- The founder's decision. A skip reason teaches the CMO like the other cards do.
create or replace function public.cmo_decide_video_brief(p_id uuid, p_action text, p_reason text default null)
returns public.cmo_video_briefs language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_row public.cmo_video_briefs;
begin
  if p_action is null or p_action not in ('approve', 'skip') then
    raise exception 'Choose approve or skip.' using errcode = '22023';
  end if;
  update public.cmo_video_briefs
  set status = case p_action when 'approve' then 'approved' else 'skipped' end, decided_at = now()
  where id = p_id and user_id = v_user and status = 'in_review'
  returning * into v_row;
  if not found then
    if exists (select 1 from public.cmo_video_briefs where id = p_id and user_id = v_user) then
      raise exception 'This brief was already decided.' using errcode = 'P0001';
    end if;
    raise exception 'Brief not found.' using errcode = 'P0002';
  end if;
  if p_action = 'skip' and p_reason is not null and char_length(trim(p_reason)) > 0 then
    insert into public.cmo_memories (user_id, type, kind, topic, body)
    values (v_user, 'feedback', 'feedback', 'video', left('Skipped a video brief "' || left(v_row.hook, 120) || '": ' || trim(p_reason), 600));
  end if;
  return v_row;
end;
$$;
revoke all on function public.cmo_decide_video_brief(uuid, text, text) from public, anon;
grant execute on function public.cmo_decide_video_brief(uuid, text, text) to authenticated;

commit;
