-- 20270101150000: P6 A3 (R3), what the founder's reply got (research-sales.md §6 "Outcome check").
--
-- Three days after "replied", `pull_metrics` re-reads the thread, finds the founder's reply (by the link they pasted,
-- else by its text) and stores its votes and replies on the reply's outcome row. Memory gets one line per checked
-- reply, built here from our own numbers and the community name; the thread's own words never go into memory.

begin;

-- Replies due a check (service role): replied at least three days ago, never checked, newest first.
create or replace function public.cmo_reply_outcomes_due(p_user uuid, p_limit integer)
returns table (outcome_id uuid, opportunity_id uuid, platform text, url text, community text, reply text, outcome_url text)
language sql stable security definer set search_path = public
as $$
  select o.id, p.id, p.platform, p.url, p.community, p.reply, o.outcome_url
  from public.cmo_draft_outcomes o
  join public.opportunities p on p.id = o.item_id and p.user_id = o.user_id
  where o.user_id = p_user and o.department = 'sales' and o.action = 'replied' and o.outcome_checked_at is null
    and o.decided_at <= now() - interval '3 days' and p.reply is not null
  order by o.decided_at desc
  limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;
revoke all on function public.cmo_reply_outcomes_due(uuid, integer) from public, anon, authenticated;
grant execute on function public.cmo_reply_outcomes_due(uuid, integer) to service_role;

-- Stores one check (service role). `found` needs at least one number; `not_found` and `gone` store none. Checked once:
-- a second call for the same outcome changes nothing. Returns whether it stored.
create or replace function public.cmo_save_reply_outcome(p_user uuid, p_outcome uuid, p_status text, p_votes integer,
  p_replies integer)
returns boolean language plpgsql security definer set search_path = public
as $$
declare
  v_row public.cmo_draft_outcomes;
  v_opp public.opportunities;
  v_where text;
begin
  if p_status is null or p_status not in ('found', 'not_found', 'gone')
     or (p_status = 'found' and p_votes is null and p_replies is null)
     or (p_status <> 'found' and (p_votes is not null or p_replies is not null)) then
    raise exception 'This reply check is not valid.' using errcode = '22023';
  end if;
  update public.cmo_draft_outcomes
  set outcome_status = p_status, outcome_votes = p_votes, outcome_replies = case when p_replies is null then null else greatest(0, p_replies) end, outcome_checked_at = now()
  where id = p_outcome and user_id = p_user and department = 'sales' and action = 'replied' and outcome_checked_at is null
  returning * into v_row;
  if not found then
    return false;
  end if;
  if p_status = 'found' then
    select * into v_opp from public.opportunities where id = v_row.item_id;
    v_where := case when v_opp.platform = 'hn' then 'on Hacker News'
                    when coalesce(v_opp.community, '') ~ '^r/[A-Za-z0-9_]{1,40}$' then 'in ' || v_opp.community
                    else 'on Reddit' end;
    insert into public.cmo_memories (user_id, type, body)
    values (p_user, 'feedback', left(format('A reply %s %s got %s and %s three days later.', v_where,
      case when v_row.mentioned_product then 'that named the product' else 'that only helped' end,
      case when p_votes is null then 'no vote count' when p_votes = 1 then '1 vote' else p_votes || ' votes' end,
      case when p_replies is null then 'no reply count' when p_replies = 1 then '1 reply' else p_replies || ' replies' end), 600));
  end if;
  return true;
end;
$$;
revoke all on function public.cmo_save_reply_outcome(uuid, uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.cmo_save_reply_outcome(uuid, uuid, text, integer, integer) to service_role;

-- The founder pastes the link to the reply they posted (the reply card, after "replied"). Only a link into the same
-- thread is kept: a Reddit comment under the thread's own path, or a Hacker News item.
create or replace function public.opportunity_reply_url(p_id uuid, p_url text)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_opp public.opportunities;
  v_url text := trim(coalesce(p_url, ''));
  v_base text;
begin
  select * into v_opp from public.opportunities where id = p_id and user_id = v_user and status = 'replied';
  if not found then
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;
  v_base := regexp_replace(v_opp.url, '^https://(www\.|old\.)?reddit\.com', '');
  if char_length(v_url) > 500
     or not ((v_opp.platform = 'hn' and v_url ~ '^https://news\.ycombinator\.com/item\?id=[0-9]{1,12}$')
          or (v_opp.platform = 'reddit' and v_url ~ '^https://(www\.|old\.)?reddit\.com/r/'
              and position(rtrim(v_base, '/') || '/' in regexp_replace(v_url, '^https://(www\.|old\.)?reddit\.com', '')) = 1)) then
    raise exception 'Paste the link to your reply in this thread.' using errcode = '22023';
  end if;
  update public.cmo_draft_outcomes set outcome_url = v_url
  where user_id = v_user and department = 'sales' and item_id = p_id and action = 'replied';
end;
$$;
revoke all on function public.opportunity_reply_url(uuid, text) from public, anon;
grant execute on function public.opportunity_reply_url(uuid, text) to authenticated;

commit;
