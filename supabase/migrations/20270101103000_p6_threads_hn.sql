-- 20270101103000: P6, Hacker News threads in Sales (R4) and X threads (W4): B's requests 2 and 3 in
-- docs/plans/cmo/2026-10-28-p6-sessions/A.md. Also the planner's M1 note: two digest crons never send one expiring
-- email twice.

begin;

-- Two cron runs claiming the same founder's email at once: the second waits for the first, then sees its log row.
create or replace function public.email_log_claim(p_user uuid, p_kind text, p_approval_ids uuid[])
returns table (log_id uuid, approval_ids uuid[]) language plpgsql volatile security definer set search_path = public
as $$
declare
  v_day date := (now() at time zone public.schedule_timezone(p_user))::date;
  v_ids uuid[];
  v_id uuid;
begin
  if p_kind not in ('digest', 'expiring') then
    raise exception 'Unknown email kind.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('email_log:' || p_user::text, 0));
  if exists (select 1 from public.notify_settings n where n.user_id = p_user and not n.email_digest) then
    return;
  end if;
  -- Only the founder's own cards that still wait.
  select coalesce(array_agg(a.id order by a.created_at), '{}') into v_ids
  from public.approvals a
  where a.id = any(coalesce(p_approval_ids, '{}')) and a.user_id = p_user and a.status = 'waiting';
  if p_kind = 'expiring' then
    select coalesce(array_agg(i order by i), '{}') into v_ids from unnest(v_ids) i
    where not exists (select 1 from public.email_log l
                      where l.user_id = p_user and l.kind = 'expiring' and l.status <> 'failed' and i = any(l.approval_ids));
  end if;
  if cardinality(v_ids) = 0 then
    return;
  end if;
  v_ids := v_ids[1:50];
  insert into public.email_log (user_id, kind, day, approval_ids)
  values (p_user, p_kind, v_day, v_ids)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    return;
  end if;
  return query select v_id, v_ids;
end;
$$;
revoke all on function public.email_log_claim(uuid, text, uuid[]) from public, anon, authenticated;
grant execute on function public.email_log_claim(uuid, text, uuid[]) to service_role;

-- Hacker News threads (R4). The URL is the thread's own item page; nothing else is stored as a thread link.
alter table public.opportunities drop constraint opportunities_platform_check;
alter table public.opportunities add constraint opportunities_platform_check check (platform in ('reddit', 'hn'));
alter table public.opportunities drop constraint opportunities_url_check;
alter table public.opportunities add constraint opportunities_url_check check (char_length(url) <= 500 and (
  (platform = 'reddit' and url ~ '^https://(www\.|old\.)?reddit\.com/')
  or (platform = 'hn' and url ~ '^https://news\.ycombinator\.com/item\?id=[0-9]{1,12}$')));

-- As in 20261231150000, plus each item's `platform` (default reddit).
create or replace function public.cmo_save_opportunities(p_user uuid, p_run uuid, p_items jsonb)
returns integer language plpgsql security definer set search_path = public
as $$
declare
  v_item jsonb;
  v_count integer := 0;
  v_score integer;
  v_gen jsonb;
  v_rule text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 10 then
    raise exception 'These conversations are not valid.' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_score := least(100, greatest(0, coalesce((v_item->>'score')::integer, 0)));
    v_gen := case when jsonb_typeof(v_item->'gen') = 'object' then jsonb_strip_nulls(jsonb_build_object(
      'model', left(v_item->'gen'->>'model', 100),
      'prompt_version', left(v_item->'gen'->>'prompt_version', 40))) else '{}'::jsonb end;
    -- The subreddit's rule the draft was written under (P5 R1); a skipped thread is kept without a draft.
    v_rule := case when v_item->>'rule' in ('mention_ok', 'help_only', 'skip') then v_item->>'rule' end;
    if v_rule is distinct from 'skip' and coalesce(v_item->>'reply', '') = '' then
      continue;
    end if;
    if coalesce(v_item->>'platform', 'reddit') not in ('reddit', 'hn') then
      raise exception 'A conversation comes from Reddit or Hacker News.' using errcode = '22023';
    end if;
    insert into public.opportunities (
      user_id, run_id, platform, url, community, title, author, snippet, posted_at, comments, score, score_parts, reply,
      priority, gen, rule, rule_why
    ) values (
      p_user, p_run, coalesce(v_item->>'platform', 'reddit'), v_item->>'url', left(coalesce(v_item->>'community', ''), 100),
      left(v_item->>'title', 400),
      left(coalesce(v_item->>'author', ''), 100), left(coalesce(v_item->>'snippet', ''), 1200),
      nullif(v_item->>'posted_at', '')::timestamptz, greatest(0, coalesce((v_item->>'comments')::integer, 0)),
      v_score, coalesce(v_item->'score_parts', '[]'::jsonb),
      case when v_rule = 'skip' then null else left(v_item->>'reply', 3000) end,
      case when v_score >= 85 then 'high' when v_score >= 70 then 'medium' else 'low' end,
      v_gen, v_rule, left(nullif(trim(coalesce(v_item->>'rule_why', '')), ''), 200)
    )
    on conflict (user_id, url) do nothing;
    if found then
      v_count := v_count + 1;
    end if;
  end loop;
  update public.content_items set status = 'published', published_at = now(), updated_at = now()
  where user_id = p_user and department = 'sales' and status = 'planned' and day <= current_date;
  return v_count;
end;
$$;
revoke all on function public.cmo_save_opportunities(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.cmo_save_opportunities(uuid, uuid, jsonb) to service_role;

-- An X thread (W4): 5 to 8 posts of 1 to 280 characters (code points, as X and `checkPost` count), the first being
-- the post's `text`, so every reader of single posts still sees the hook.
create or replace function public.thread_valid(p_body jsonb)
returns boolean language sql immutable set search_path = public
as $$
  select jsonb_typeof(p_body->'thread') = 'array'
    and jsonb_array_length(p_body->'thread') between 5 and 8
    and not exists (select 1 from jsonb_array_elements(p_body->'thread') p
                    where jsonb_typeof(p) <> 'string' or char_length(p #>> '{}') not between 1 and 280)
    and p_body->'thread'->>0 = p_body->>'text';
$$;
revoke all on function public.thread_valid(jsonb) from public, anon, authenticated;

-- As in 20261229110000, plus the thread check.
create or replace function public.cmo_save_draft(p_user uuid, p_run uuid, p_item uuid, p_idea text, p_body jsonb,
  p_priority text default 'medium', p_platform text default null)
returns public.content_items language plpgsql security definer set search_path = public
as $$
declare
  v_row public.content_items;
  v_profile jsonb := public.platform_profile(public.platform_profile_id(p_platform));
  v_post boolean := coalesce(v_profile->>'kind' = 'post', false);
  v_platform text := case when v_post then v_profile->>'label' else 'x' end;
begin
  if p_body is null or jsonb_typeof(p_body) <> 'object' or coalesce(p_body->>'text', '') = '' then
    raise exception 'This draft is not valid.' using errcode = '22023';
  end if;
  if p_body ? 'thread' then
    if not public.thread_valid(p_body) then
      raise exception 'A thread has 5 to 8 posts of at most 280 characters, the first being the post.' using errcode = '22023';
    end if;
    if coalesce(public.platform_profile_id(case when p_item is not null
         then (select platform from public.content_items where id = p_item and user_id = p_user) else v_platform end), 'x') <> 'x' then
      raise exception 'Only an X post can be a thread.' using errcode = '22023';
    end if;
  end if;
  if p_item is not null then
    update public.content_items
    set status = 'in_review', body = p_body, priority = coalesce(p_priority, 'medium'), run_id = p_run, updated_at = now()
    where id = p_item and user_id = p_user and status in ('planned', 'drafting')
    returning * into v_row;
    if not found then
      raise exception 'This calendar item is no longer open.' using errcode = 'P0002';
    end if;
  else
    insert into public.content_items (user_id, run_id, department, platform, day, idea, status, priority, body)
    values (p_user, p_run, 'post', v_platform, current_date,
            left(coalesce(nullif(p_idea, ''), 'Post for ' || case when v_post then v_profile->>'label' else 'X' end), 300),
            'in_review', coalesce(p_priority, 'medium'), p_body)
    returning * into v_row;
  end if;
  return v_row;
end;
$$;
revoke all on function public.cmo_save_draft(uuid, uuid, uuid, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.cmo_save_draft(uuid, uuid, uuid, text, jsonb, text, text) to service_role;

-- The cards: a post card carries its thread, a reply card from Hacker News says so. Reddit replies and single posts
-- keep the snapshot (and hash) they had. The look note stays as in 20270101100000.
create or replace function public.approval_snapshot(p_ref_kind text, p_ref_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  v jsonb := public.approval_snapshot_base(p_ref_kind, p_ref_id);
  v_look public.look_checks;
  v_extra jsonb;
begin
  if v is null then
    return v;
  end if;
  if p_ref_kind = 'content_item' then
    select case when public.thread_valid(body) then jsonb_build_object('thread', body->'thread') end into v_extra
    from public.content_items where id = p_ref_id;
    return v || coalesce(v_extra, '{}'::jsonb);
  end if;
  if p_ref_kind = 'opportunity' then
    select case when platform <> 'reddit' then jsonb_build_object('platform', platform) end into v_extra
    from public.opportunities where id = p_ref_id;
    return v || coalesce(v_extra, '{}'::jsonb);
  end if;
  if p_ref_kind not in ('editor_project', 'short_batch', 'studio_step') then
    return v;
  end if;
  select * into v_look from public.look_checks c
  where c.ref_kind = p_ref_kind and c.ref_id = p_ref_id and c.status = 'failed'
    and c.doc_key = coalesce(v->>'document_hash', v->>'parent_hash')
  order by c.round desc, c.created_at desc limit 1;
  if found and coalesce(v_look.result->>'note', '') <> '' then
    v := v || jsonb_build_object('look', jsonb_build_object('pass', false, 'round', v_look.round,
      'note', left(v_look.result->>'note', 200)));
  end if;
  return v;
end;
$$;
revoke all on function public.approval_snapshot(text, uuid) from public, anon, authenticated;

-- What a schedule card posts (as in 20261231140000): a thread goes out as one, and its posts are part of the hash so
-- changing one asks again. A single post keeps the hash it had.
create or replace function public.schedule_content(p_deliverable uuid, p_platform text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  v_d public.deliverables;
  v_text text;
  v_title text;
  v_doc text;
  v_image_clip uuid;
  v_image jsonb;
  v_thread jsonb;
begin
  select * into v_d from public.deliverables where id = p_deliverable;
  if not found then
    return null;
  end if;
  if v_d.ref_kind = 'content_item' then
    select coalesce(body->>'text', ''), case when public.thread_valid(body) then body->'thread' end
    into v_text, v_thread from public.content_items where id = v_d.ref_id;
    -- The post's newest image (P5 B4), as its cover still of the image's document as it is now. Only a post with an
    -- image carries the key, so the hash of a post without one is what it was before P5.
    select i.ref_id into v_image_clip from public.deliverables i
    where i.post_id = v_d.ref_id and i.kind = 'image' order by i.created_at desc limit 1;
    if v_image_clip is not null then
      select jsonb_build_object('clip_id', v_image_clip,
          'object', t.output->'stills'->coalesce((t.output->>'cover_index')::integer, 0)->>'object',
          'bytes', t.output->'stills'->coalesce((t.output->>'cover_index')::integer, 0)->'bytes')
        into v_image
      from public.tasks t join public.editor_projects p on p.clip_id = t.clip_id
      where t.clip_id = v_image_clip and t.kind = 'render_stills' and t.status = 'done'
        and t.settings_hash = public.editor_document_hash(p.document)
      order by t.finished_at desc nulls last limit 1;
      if v_image->>'object' is null then
        v_image := null;
      end if;
    end if;
    return jsonb_build_object('clip_id', null, 'text', v_text, 'title', null,
      'content_hash', public.approval_hash(jsonb_build_object('text', v_text)
        || case when v_image is not null then jsonb_build_object('image', v_image->>'object') else '{}'::jsonb end
        || case when v_thread is not null then jsonb_build_object('thread', v_thread) else '{}'::jsonb end))
      || case when v_image is not null then jsonb_build_object('image', v_image) else '{}'::jsonb end
      || case when v_thread is not null then jsonb_build_object('thread', v_thread) else '{}'::jsonb end;
  elsif v_d.ref_kind = 'clip' then
    select public.editor_document_hash(document) into v_doc from public.editor_projects where clip_id = v_d.ref_id;
    select body->>'text', body->>'title' into v_text, v_title
    from public.content_items
    where clip_id = v_d.ref_id and department = 'video' and platform = public.platform_profile_id(p_platform)
      and status in ('approved', 'published');
    return jsonb_build_object('clip_id', v_d.ref_id, 'text', v_text, 'title', v_title,
      'content_hash', public.approval_hash(jsonb_strip_nulls(jsonb_build_object('document_hash', v_doc, 'text', v_text,
        'title', v_title))));
  end if;
  return null;
end;
$$;
revoke all on function public.schedule_content(uuid, text) from public, anon, authenticated;

commit;
