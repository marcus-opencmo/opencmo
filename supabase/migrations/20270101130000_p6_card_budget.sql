-- 20270101130000: P6 A4 (F4), the daily card budget (approval.md §6, §12 3; owner 2026-10-31).
--
-- About ten new cards a founder's local day. Past it a new card is `held` until the next local day and is not in the
-- queue; a time-bound card (one that expires: schedule cards) is never held. A card that replaces another one for the
-- same row (an edit, a re-render) is not new: it takes the old card's place, held or waiting, and is not counted.
-- Held cards are released oldest first, within the day's budget, by `approval_release_held` (the hourly cron).
--
-- Also from the M1 review: `held` joins the one-live-card index and the supersede, so a held card whose content
-- changes is replaced instead of lingering next to a new waiting card. From the P6 review: `approval_close` and the
-- work-order rule treat a held card as live too, so a held card whose row is deleted or decided elsewhere closes
-- instead of coming back the next day; and a released card carries `released_at`, so the push rule sees it as new.

begin;

create or replace function public.card_budget_rules() returns jsonb
language sql immutable set search_path = public
as $$ select '{"perDay": 10}'::jsonb $$;
revoke all on function public.card_budget_rules() from public, anon, authenticated;

drop index public.approvals_one_waiting;
create unique index approvals_one_waiting on public.approvals (ref_kind, ref_id) where status in ('waiting', 'held');
create index approvals_held_idx on public.approvals (held_until) where status = 'held';

-- When a held card entered the queue; `push_due` counts it as new from then.
alter table public.approvals add column released_at timestamptz;

-- As in 20261227100000, but a held card is live too: it closes with its row.
create or replace function public.approval_close(p_ref_kind text, p_ref_id uuid, p_status text)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  update public.approvals
  set status = p_status,
      decided_at = now(),
      decided_via = case when p_status in ('approved', 'edited', 'skipped')
        then coalesce(nullif(current_setting('opencmo.decided_via', true), ''), 'app') end
  where ref_kind = p_ref_kind and ref_id = p_ref_id and status in ('waiting', 'held');
end;
$$;
revoke all on function public.approval_close(text, uuid, text) from public, anon, authenticated;

-- The start of the founder's next local day.
create or replace function public.card_budget_next_day(p_user uuid) returns timestamptz
language sql stable security definer set search_path = public
as $$
  select (((now() at time zone public.schedule_timezone(p_user))::date + 1)::timestamp) at time zone public.schedule_timezone(p_user)
$$;
revoke all on function public.card_budget_next_day(uuid) from public, anon, authenticated;

-- Counts one new card on the founder's local day and says whether it fits; `p_force` counts it either way (a
-- time-bound card). Locks the day's row so two cards raised at once cannot both take the last place.
create or replace function public.card_budget_take(p_user uuid, p_force boolean) returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v_day date := (now() at time zone public.schedule_timezone(p_user))::date;
  v_raised integer;
begin
  insert into public.card_budget (user_id, day) values (p_user, v_day) on conflict (user_id, day) do nothing;
  select raised into v_raised from public.card_budget where user_id = p_user and day = v_day for update;
  if p_force or v_raised < (public.card_budget_rules()->>'perDay')::integer then
    update public.card_budget set raised = raised + 1 where user_id = p_user and day = v_day;
    return true;
  end if;
  update public.card_budget set held = held + 1 where user_id = p_user and day = v_day;
  return false;
end;
$$;
revoke all on function public.card_budget_take(uuid, boolean) from public, anon, authenticated;

-- As in 20261231090000, plus the budget and `held`.
create or replace function public.approval_raise(p_user uuid, p_ref_kind text, p_ref_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_snapshot jsonb := public.approval_snapshot(p_ref_kind, p_ref_id);
  v_hash text;
  v_kind text;
  v_id uuid;
  v_expires timestamptz;
  v_prev public.approvals;
  v_status text := 'waiting';
  v_held_until timestamptz;
begin
  if v_snapshot is null then
    return;
  end if;
  v_hash := public.approval_hash(v_snapshot);
  if exists (select 1 from public.approvals
             where ref_kind = p_ref_kind and ref_id = p_ref_id and status in ('waiting', 'held') and content_hash = v_hash) then
    return;
  end if;
  select * into v_prev from public.approvals
  where ref_kind = p_ref_kind and ref_id = p_ref_id and status in ('waiting', 'held') for update;
  update public.approvals set status = 'cancelled', decided_at = now()
  where ref_kind = p_ref_kind and ref_id = p_ref_id and status in ('waiting', 'held');
  v_kind := v_snapshot->>'kind';
  -- A failure card (it carries the last error) stays open while the slot's window lasts, so Retry can still post
  -- at the approved time; any other schedule card expires at its time.
  if v_kind = 'schedule' then
    select case when s.error is not null then s.window_ends_at else s.publish_at end into v_expires
    from public.schedule_slots s where s.id = p_ref_id;
  end if;
  if v_prev.id is not null then
    -- A replacement keeps its place: not counted again, still held if the old one was.
    v_status := case when v_prev.status = 'held' and v_expires is null then 'held' else 'waiting' end;
    v_held_until := case when v_status = 'held' then v_prev.held_until end;
  elsif not public.card_budget_take(p_user, v_expires is not null) then
    v_status := 'held';
    v_held_until := public.card_budget_next_day(p_user);
  end if;
  -- A schedule card carries its time and account in the foot and expires when its time comes (rule 4).
  insert into public.approvals (user_id, kind, department, ref_kind, ref_id, snapshot, content_hash, price_credits,
    post_at, account, expires_at, status, held_until)
  values (p_user, v_kind,
    case v_kind when 'post' then 'writer' when 'reply' then 'sales'
      when 'script' then 'studio' when 'price' then 'studio' when 'finished_video' then 'studio'
      when 'shorts_batch' then 'studio' when 'slideshow' then 'studio' when 'schedule' then 'schedule' else 'brain' end,
    p_ref_kind, p_ref_id, v_snapshot, v_hash,
    case when v_kind in ('script', 'price') then (v_snapshot->>'price_credits')::integer end,
    case when v_kind = 'schedule' then (v_snapshot->>'publish_at')::timestamptz end,
    case when v_kind = 'schedule' then left(v_snapshot->>'handle', 100) end,
    v_expires, v_status, v_held_until)
  returning id into v_id;
  if v_kind = 'schedule' then
    update public.schedule_slots set approval_id = v_id, updated_at = now() where id = p_ref_id;
  end if;
end;
$$;
revoke all on function public.approval_raise(uuid, text, uuid) from public, anon, authenticated;

-- As in 20261229110000: a held card shows its row as it is now too, so it is current when it is released.
create or replace function public.approval_refresh(p_ref_kind text, p_ref_id uuid) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_snapshot jsonb := public.approval_snapshot(p_ref_kind, p_ref_id);
begin
  if v_snapshot is null then
    return;
  end if;
  update public.approvals set snapshot = v_snapshot, content_hash = public.approval_hash(v_snapshot)
  where ref_kind = p_ref_kind and ref_id = p_ref_id and status in ('waiting', 'held')
    and content_hash is distinct from public.approval_hash(v_snapshot);
end;
$$;
revoke all on function public.approval_refresh(text, uuid) from public, anon, authenticated;

-- Releases held cards whose day has come, oldest first, as far as each founder's budget for today allows; the rest
-- wait for the next day. Service role (hourly cron). Returns how many cards it released.
create or replace function public.approval_release_held(p_limit integer default 500)
returns integer language plpgsql security definer set search_path = public
as $$
declare
  v_card public.approvals;
  v_n integer := 0;
begin
  for v_card in
    select * from public.approvals where status = 'held' and held_until <= now()
    order by user_id, created_at limit greatest(1, least(p_limit, 5000))
    for update skip locked
  loop
    if public.card_budget_take(v_card.user_id, false) then
      update public.approvals set status = 'waiting', held_until = null, released_at = now() where id = v_card.id;
      v_n := v_n + 1;
    else
      -- `card_budget_take` counted it as held again on today's row; it tries tomorrow.
      update public.approvals set held_until = public.card_budget_next_day(v_card.user_id) where id = v_card.id;
    end if;
  end loop;
  return v_n;
end;
$$;
revoke all on function public.approval_release_held(integer) from public, anon, authenticated;
grant execute on function public.approval_release_held(integer) to service_role;

-- As in 20261227110000, but a card that ends while held follows its order too (a held card is live: P6 A4).
-- A decided card decides its deliverable; an order whose deliverables are all decided is done.
create or replace function public.work_orders_follow_approval() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_order public.work_orders;
  v_ref_kind text := case new.ref_kind when 'content_item' then 'content_item' when 'opportunity' then 'opportunity' end;
begin
  if old.status not in ('waiting', 'held') or new.status in ('waiting', 'held') or v_ref_kind is null then
    return new;
  end if;
  -- A cancelled card is not a decision. `approval_raise` cancels the old card before it inserts the new one, so a
  -- row still in review is getting a fresh card: its deliverable keeps waiting. A row that left review without the
  -- founder (deleted, or back to drafting) sends its order back: cancelled when the row is gone, else queued.
  if new.status = 'cancelled' then
    begin
      if (v_ref_kind = 'content_item' and exists (select 1 from public.content_items where id = new.ref_id and status = 'in_review'))
         or (v_ref_kind = 'opportunity' and exists (select 1 from public.opportunities where id = new.ref_id and status = 'in_review')) then
        return new;
      end if;
      update public.deliverables set status = 'ready' where ref_kind = v_ref_kind and ref_id = new.ref_id;
      for v_order in
        select o.* from public.work_orders o join public.deliverables d on d.order_id = o.id
        where d.ref_kind = v_ref_kind and d.ref_id = new.ref_id and o.status = 'waiting_founder'
      loop
        if not exists (select 1 from public.deliverables where order_id = v_order.id and status = 'waiting_founder') then
          if (v_ref_kind = 'content_item' and not exists (select 1 from public.content_items where id = new.ref_id))
             or (v_ref_kind = 'opportunity' and not exists (select 1 from public.opportunities where id = new.ref_id)) then
            perform public.work_order_move(v_order.id, 'cancelled', 'The draft of “' || v_order.title || '” was deleted');
          else
            update public.work_orders set run_id = null where id = v_order.id;
            perform public.work_order_move(v_order.id, 'queued', '“' || v_order.title || '” went back to drafting');
          end if;
        end if;
      end loop;
    exception when others then
      raise warning 'work orders did not follow card %: %', new.id, sqlerrm;
    end;
    return new;
  end if;
  begin
    update public.deliverables set status = 'decided' where ref_kind = v_ref_kind and ref_id = new.ref_id;
    for v_order in
      select o.* from public.work_orders o join public.deliverables d on d.order_id = o.id
      where d.ref_kind = v_ref_kind and d.ref_id = new.ref_id and o.status = 'waiting_founder'
    loop
      if not exists (select 1 from public.deliverables where order_id = v_order.id and status = 'waiting_founder') then
        perform public.work_order_move(v_order.id, 'done', case new.status
          when 'approved' then 'You approved “' || v_order.title || '”'
          when 'edited' then 'You edited and approved “' || v_order.title || '”'
          when 'skipped' then 'You skipped “' || v_order.title || '”'
          else 'Finished “' || v_order.title || '”' end);
      end if;
    end loop;
  exception when others then
    raise warning 'work orders did not follow card %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function public.work_orders_follow_approval() from public, anon, authenticated;

commit;
