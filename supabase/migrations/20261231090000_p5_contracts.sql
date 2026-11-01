-- 20261231090000: P5 A0, the contracts of safe Sales, niche video research and slideshows
-- (docs/plans/cmo/2026-10-28-p5-research-sales-slides-plan.md, sessions/A.md).
--
-- Skeleton only: the tables, kinds and card shapes the three sessions build on. Nothing reads subreddit rules,
-- counts mentions, researches videos or builds a slideshow yet (A1, A2, B3).

begin;

-- One verdict per subreddit, read from its rules page (data, never instructions) and shared by every founder: the
-- rules are public and the same for all. Fresh for 7 days (A1); only the service role (the scan) writes it.
create table public.subreddit_rules (
  subreddit text primary key check (subreddit ~ '^[a-z0-9_]{2,21}$'),
  verdict text not null check (verdict in ('mention_ok', 'help_only', 'skip')),
  -- The one line a Sales card shows: "r/x forbids self-promotion".
  summary text not null default '' check (char_length(summary) <= 200),
  read_at timestamptz not null default now()
);

-- Per founder: subreddits never scanned, and pairs of terms that must both appear in a thread before it is scored.
create table public.sales_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  excluded_subreddits text[] not null default '{}' check (cardinality(excluded_subreddits) <= 50),
  co_occurrence jsonb not null default '[]'::jsonb
    check (jsonb_typeof(co_occurrence) = 'array' and jsonb_array_length(co_occurrence) <= 20
      and octet_length(co_occurrence::text) <= 4096),
  updated_at timestamptz not null default now()
);

alter table public.subreddit_rules enable row level security;
alter table public.sales_settings enable row level security;
create policy "read subreddit rules" on public.subreddit_rules for select to authenticated using (true);
create policy "read own sales settings" on public.sales_settings for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.subreddit_rules, public.sales_settings from anon, authenticated;
grant select on public.subreddit_rules, public.sales_settings to authenticated;
grant select, insert, update, delete on public.subreddit_rules, public.sales_settings to service_role;

-- The founder's Sales settings (C2). Names are stored lowercase without `r/`; each pair is two distinct terms.
create or replace function public.sales_settings_save(p_excluded text[], p_pairs jsonb)
returns public.sales_settings language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_excluded text[];
  v_pairs jsonb;
  v_row public.sales_settings;
begin
  select coalesce(array_agg(distinct n order by n), '{}') into v_excluded
  from (select regexp_replace(lower(btrim(e)), '^/?r/', '') as n from unnest(coalesce(p_excluded, '{}')) e) s
  where n <> '';
  if cardinality(v_excluded) > 50 then
    raise exception 'Exclude at most 50 subreddits.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_excluded) n where n !~ '^[a-z0-9_]{2,21}$') then
    raise exception 'A subreddit name has 2 to 21 letters, digits or underscores.' using errcode = '22023';
  end if;
  if p_pairs is null or jsonb_typeof(p_pairs) <> 'array' then
    raise exception 'Term pairs must be a list.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_pairs) > 20 then
    raise exception 'Add at most 20 term pairs.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_pairs) p
             where jsonb_typeof(p) <> 'array' or jsonb_array_length(p) <> 2
               or jsonb_typeof(p->0) <> 'string' or jsonb_typeof(p->1) <> 'string') then
    raise exception 'Each pair has exactly two terms.' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_array(a, b)), '[]'::jsonb) into v_pairs
  from (select lower(btrim(p->>0)) as a, lower(btrim(p->>1)) as b from jsonb_array_elements(p_pairs) p) s;
  if exists (select 1 from jsonb_array_elements(v_pairs) p
             where char_length(p->>0) not between 1 and 60 or char_length(p->>1) not between 1 and 60 or p->>0 = p->>1) then
    raise exception 'Each term has 1 to 60 characters, and the two terms of a pair differ.' using errcode = '22023';
  end if;
  insert into public.sales_settings (user_id, excluded_subreddits, co_occurrence, updated_at)
  values (v_user, v_excluded, v_pairs, now())
  on conflict (user_id) do update
    set excluded_subreddits = excluded.excluded_subreddits, co_occurrence = excluded.co_occurrence, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.sales_settings_save(text[], jsonb) from public, anon;
grant execute on function public.sales_settings_save(text[], jsonb) to authenticated;

-- The rule a thread was drafted under (A1). `skip` keeps the thread for the Sales screen's "skipped and why" but it
-- gets no draft and no card.
alter table public.opportunities
  add column rule text check (rule in ('mention_ok', 'help_only', 'skip')),
  add column rule_why text check (char_length(rule_why) <= 200);
alter table public.opportunities alter column reply drop not null;
alter table public.opportunities add constraint opportunities_reply_or_skip check (reply is not null or rule = 'skip');

-- Set in code from the final approved text (A1), never from the draft's intent: the 1-in-10 rule counts these.
alter table public.cmo_draft_outcomes add column mentioned_product boolean;

alter table public.cmo_insights drop constraint cmo_insights_kind_check;
alter table public.cmo_insights add constraint cmo_insights_kind_check check (kind in ('competitors', 'niche_video'));

alter table public.clips drop constraint clips_kind_check;
alter table public.clips add constraint clips_kind_check check (kind in ('full', 'blank', 'short', 'slideshow'));

alter table public.deliverables drop constraint deliverables_kind_check;
alter table public.deliverables add constraint deliverables_kind_check check (kind in ('post', 'caption', 'video', 'short',
  'slideshow', 'image', 'reply', 'insight', 'metric'));

-- The Slideshow squad's one card (B3) is a Studio step.
alter table public.studio_steps drop constraint studio_steps_kind_check;
alter table public.studio_steps add constraint studio_steps_kind_check check (kind in ('script', 'price', 'slideshow'));

-- One PNG per slide (B2); its handler lands with the kind (packages/contracts/task-kinds.json).
alter table public.tasks drop constraint tasks_kind_check;
alter table public.tasks add constraint tasks_kind_check check (kind in ('probe_media', 'generate', 'render_document',
  'render_stills', 'transcribe_media', 'transcribe_asset', 'capture_page', 'publish_media'));

-- A slideshow is an edit of its own kind: the same job shape as a blank edit, opened in the Slides view (C1).
create or replace function public.create_slideshow(p_name text default null, p_aspect text default '9:16')
returns uuid language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_name text := nullif(left(btrim(coalesce(p_name, '')), 120), '');
  v_job uuid;
  v_clip uuid;
begin
  if p_aspect is null or p_aspect not in ('9:16', '1:1', '16:9') then
    raise exception 'Choose a frame: 9:16, 1:1 or 16:9.' using errcode = '22023';
  end if;
  -- Same ceiling as every other way of creating a project.
  if (select count(*) from public.jobs where user_id = v_user and kind = 'edit' and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'You have created many edits in the last hour. Try again later.' using errcode = 'P0001';
  end if;
  insert into public.jobs (user_id, kind, source_url, title, status, aspect, clips_requested, duration_seconds, finished_at)
  values (v_user, 'edit', 'editor://blank', coalesce(v_name, 'Untitled slideshow'), 'done', p_aspect, 0, 0, now())
  returning id into v_job;
  insert into public.clips (job_id, idx, hook, start_seconds, end_seconds, source_start, source_end, kind)
  values (v_job, -1, coalesce(v_name, 'Untitled slideshow'), 0, 0, null, null, 'slideshow')
  returning id into v_clip;
  return v_clip;
end;
$$;
revoke all on function public.create_slideshow(text, text) from public, anon;
grant execute on function public.create_slideshow(text, text) to authenticated;

create or replace function public.rename_blank_edit(p_clip_id uuid, p_name text)
returns text language plpgsql security definer set search_path = public
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
  if v_clip.kind not in ('blank', 'slideshow') then
    raise exception 'Only edits started from a blank canvas can be renamed here.' using errcode = '22023';
  end if;
  update public.clips set hook = v_name where id = v_clip.id;
  update public.jobs set title = v_name where id = v_clip.job_id;
  return v_name;
end;
$$;

-- What a card shows, now also the slideshow card (`studio_steps.kind = 'slideshow'`) and the Sales rule on a reply.
-- A skipped thread has no card. The rule is added only when set, so reply cards raised before P5 keep their hash.
create or replace function public.approval_snapshot(p_ref_kind text, p_ref_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  v jsonb;
  v_captions jsonb;
begin
  case p_ref_kind
    when 'content_item' then
      select jsonb_build_object('kind', 'post', 'platform', platform, 'day', day, 'idea', idea,
        'text', coalesce(body->>'text', ''),
        'alternates', case when jsonb_typeof(body->'alternates') = 'array' then body->'alternates' else '[]'::jsonb end,
        'rationale', coalesce(body->>'rationale', reason))
      into v from public.content_items where id = p_ref_id;
    when 'opportunity' then
      select jsonb_build_object('kind', 'reply', 'url', url, 'community', community, 'title', title,
        'reply', reply, 'score', score, 'score_parts', score_parts)
        || case when rule is not null then jsonb_build_object('rule', rule, 'rule_why', coalesce(rule_why, '')) else '{}'::jsonb end
      into v from public.opportunities where id = p_ref_id and (rule is distinct from 'skip');
    when 'goal' then
      select jsonb_build_object('kind', 'goal', 'week', week, 'goal', goal, 'metric', metric, 'target', target)
      into v from public.cmo_goals where id = p_ref_id;
    when 'correction' then
      select jsonb_build_object('kind', 'correction', 'rule', rule, 'source_edits', source_edits)
        || case when edit_mode is not null then jsonb_build_object('edit_mode', edit_mode, 'times', times) else '{}'::jsonb end
      into v from public.cmo_corrections where id = p_ref_id;
    when 'studio_step' then
      select case s.kind
        when 'script' then jsonb_build_object('kind', 'script', 'step_id', s.id, 'clip_id', s.clip_id, 'tool', s.tool,
          'title', coalesce(s.card->>'title', ''), 'seconds', s.card->'seconds', 'aspect', s.card->'aspect',
          'beats', case when jsonb_typeof(s.card->'beats') = 'array' then s.card->'beats' else '[]'::jsonb end,
          'price_credits', s.price_credits)
        -- The slideshow as built (B3): its slides, the MP4 and the PNG set of this exact document. Any edit to the
        -- document changes `document_hash` and supersedes the card.
        when 'slideshow' then jsonb_build_object('kind', 'slideshow', 'step_id', s.id, 'clip_id', s.clip_id,
          'title', coalesce(s.card->>'title', ''), 'aspect', s.card->'aspect',
          'slides', case when jsonb_typeof(s.card->'slides') = 'array' then s.card->'slides' else '[]'::jsonb end,
          'document_hash', (select public.editor_document_hash(p.document) from public.editor_projects p where p.clip_id = s.clip_id),
          'mp4_path', s.card->'mp4_path', 'png_set_path', s.card->'png_set_path')
        else jsonb_build_object('kind', 'price', 'step_id', s.id, 'clip_id', s.clip_id, 'tool', s.tool,
          'title', coalesce(s.card->>'title', ''), 'what', coalesce(s.card->>'what', ''), 'seconds', s.card->'seconds',
          'wait_minutes', s.card->'wait_minutes',
          'keyframes', case when jsonb_typeof(s.card->'keyframes') = 'array' then s.card->'keyframes' else '[]'::jsonb end,
          'shots', coalesce(s.card->'shots', '0'::jsonb), 'price_credits', s.price_credits)
        end
      into v from public.studio_steps s where s.id = p_ref_id;
    when 'editor_project' then
      select jsonb_build_object('kind', 'finished_video', 'clip_id', c.id, 'title', coalesce(c.hook, ''),
        'document_hash', public.editor_document_hash(p.document),
        'render_task_id', r.id, 'render_path', r.output_path, 'seconds', r.duration)
      into v
      from public.editor_projects p
      join public.clips c on c.id = p.clip_id
      left join lateral (
        select t.id, t.output_path, t.duration from public.tasks t
        where t.clip_id = p.clip_id and t.kind = 'render_document' and t.status = 'done'
          and t.settings_hash = public.editor_document_hash(p.document)
        order by t.finished_at desc nulls last, t.created_at desc
        limit 1
      ) r on true
      where p.clip_id = p_ref_id;
      v_captions := public.caption_snapshots(array[p_ref_id]);
    when 'short_batch' then
      select jsonb_build_object('kind', 'shorts_batch', 'batch_id', b.id, 'parent_clip_id', b.parent_clip_id,
        'title', coalesce(c.hook, ''), 'parent_hash', b.parent_hash,
        'shorts', coalesce((
          select jsonb_agg(jsonb_build_object('short_id', s.id, 'short_clip_id', s.short_clip_id,
            'start', s.source_start, 'end', s.source_end, 'hook', s.hook, 'reason', s.reason)
            order by s.source_start, s.id)
          from public.shorts s where s.batch_id = b.id and s.status <> 'failed'), '[]'::jsonb))
      into v
      from public.short_batches b
      left join public.clips c on c.id = b.parent_clip_id
      where b.id = p_ref_id;
      v_captions := public.caption_snapshots(array(
        select s.short_clip_id from public.shorts s
        where s.batch_id = p_ref_id and s.status <> 'failed' and s.short_clip_id is not null
        order by s.source_start, s.id));
    when 'schedule_slot' then
      -- Content, time, account and the platform's fields: everything the founder approves before it posts
      -- (approval.md rule 1). `content_hash` covers the words and the edit, so a change to either supersedes it.
      select jsonb_build_object('kind', 'schedule', 'slot_id', s.id, 'deliverable_id', s.deliverable_id,
        'deliverable_kind', d.kind, 'platform', s.platform, 'mode', s.mode, 'account_id', s.account_id,
        'handle', a.handle, 'publish_at', to_char(s.publish_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'options', s.options, 'last_error', s.error->>'message')
        || public.schedule_content(s.deliverable_id, s.platform)
      into v
      from public.schedule_slots s
      join public.deliverables d on d.id = s.deliverable_id
      left join public.social_accounts a on a.id = s.account_id
      where s.id = p_ref_id;
    else
      raise exception 'Unknown card source.' using errcode = '22023';
  end case;
  if v is not null and v_captions is not null then
    v := v || jsonb_build_object('captions', v_captions);
  end if;
  return v;
end;
$$;

-- A slideshow card belongs to Studio.
create or replace function public.approval_raise(p_user uuid, p_ref_kind text, p_ref_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_snapshot jsonb := public.approval_snapshot(p_ref_kind, p_ref_id);
  v_hash text;
  v_kind text;
  v_id uuid;
  v_expires timestamptz;
begin
  if v_snapshot is null then
    return;
  end if;
  v_hash := public.approval_hash(v_snapshot);
  if exists (select 1 from public.approvals
             where ref_kind = p_ref_kind and ref_id = p_ref_id and status = 'waiting' and content_hash = v_hash) then
    return;
  end if;
  update public.approvals set status = 'cancelled', decided_at = now()
  where ref_kind = p_ref_kind and ref_id = p_ref_id and status = 'waiting';
  v_kind := v_snapshot->>'kind';
  -- A failure card (it carries the last error) stays open while the slot's window lasts, so Retry can still post
  -- at the approved time; any other schedule card expires at its time.
  if v_kind = 'schedule' then
    select case when s.error is not null then s.window_ends_at else s.publish_at end into v_expires
    from public.schedule_slots s where s.id = p_ref_id;
  end if;
  -- A schedule card carries its time and account in the foot and expires when its time comes (rule 4).
  insert into public.approvals (user_id, kind, department, ref_kind, ref_id, snapshot, content_hash, price_credits,
    post_at, account, expires_at)
  values (p_user, v_kind,
    case v_kind when 'post' then 'writer' when 'reply' then 'sales'
      when 'script' then 'studio' when 'price' then 'studio' when 'finished_video' then 'studio'
      when 'shorts_batch' then 'studio' when 'slideshow' then 'studio' when 'schedule' then 'schedule' else 'brain' end,
    p_ref_kind, p_ref_id, v_snapshot, v_hash,
    case when v_kind in ('script', 'price') then (v_snapshot->>'price_credits')::integer end,
    case when v_kind = 'schedule' then (v_snapshot->>'publish_at')::timestamptz end,
    case when v_kind = 'schedule' then left(v_snapshot->>'handle', 100) end,
    v_expires)
  returning id into v_id;
  if v_kind = 'schedule' then
    update public.schedule_slots set approval_id = v_id, updated_at = now() where id = p_ref_id;
  end if;
end;
$$;

-- The PNG set (B2): `render_stills` writes one PNG per slide and a zip of them next to the MP4 exports.
update storage.buckets set allowed_mime_types = array['video/*', 'image/png', 'application/zip'] where id = 'exports';

-- One still export of a saved revision (B2), like `request_document_export`: the owner's clip, the same daily
-- export limit and in-progress cap. Objects keep three path levels: `<user>/<clip>/<task>.zip` and
-- `<user>/<clip>/<task>-01.png`…, so the existing ownership checks on `exports` paths hold.
create or replace function public.request_stills_export(p_clip_id uuid, p_revision_id uuid, p_request_id uuid)
returns public.tasks language plpgsql security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_plan text;
  v_quota record;
  v_revision public.editor_revisions;
  v_manifest jsonb;
  v_job_id uuid;
  v_task public.tasks;
  v_task_id uuid := gen_random_uuid();
  v_prefix text;
begin
  if p_request_id is null then
    raise exception 'Missing request id.' using errcode = '22023';
  end if;
  perform public.owned_clip(p_clip_id, v_user);
  select r.* into v_revision from public.editor_revisions r where r.id = p_revision_id and r.clip_id = p_clip_id;
  if not found then
    raise exception 'Save the project before exporting it.' using errcode = 'P0002';
  end if;
  select c.job_id into v_job_id from public.clips c where c.id = p_clip_id;
  select p.manifest into v_manifest from public.editor_projects p where p.clip_id = p_clip_id;

  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 1701));
  select * into v_task from public.tasks where request_id = p_request_id;
  if found then
    if v_task.user_id is distinct from v_user or v_task.kind <> 'render_stills'
       or v_task.clip_id is distinct from p_clip_id or v_task.editor_revision_id is distinct from p_revision_id then
      raise exception 'This export request was already used for another clip or revision.' using errcode = '22023';
    end if;
    return v_task;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 1702));
  if (select count(*) from public.tasks
      where user_id = v_user
        and kind in ('preview', 'export', 'client_export', 'finalize', 'render_document', 'render_stills')
        and status in ('awaiting_upload', 'queued', 'running')) >= 20 then
    raise exception 'You already have 20 previews or exports in progress. Please wait for one to finish.' using errcode = 'P0001';
  end if;
  select coalesce(plan, 'free') into v_plan from public.profiles where id = v_user;
  select * into v_quota from public.plan_quota(v_plan);
  if not public.rate_limit_hit('export', v_quota.exports_per_day, 86400) then
    raise exception 'You have reached today''s limit for this plan.' using errcode = 'P0001';
  end if;

  v_prefix := v_user::text || '/' || p_clip_id::text || '/' || v_task_id::text;
  insert into public.tasks (id, user_id, kind, clip_id, editor_revision_id, settings_hash, job_id, payload, status, request_id)
  values (v_task_id, v_user, 'render_stills', p_clip_id, p_revision_id, v_revision.source_hash, v_job_id,
    jsonb_build_object('bucket', 'exports', 'object', v_prefix || '.zip', 'still_prefix', v_prefix,
      'editor_revision_id', p_revision_id, 'source_hash', v_revision.source_hash,
      'manifest', coalesce(v_manifest, '{"version":1,"folders":[],"assets":[]}'::jsonb)),
    'queued', p_request_id)
  on conflict do nothing
  returning * into v_task;
  if not found then
    perform public.release_rate_limit_for(v_user, 'export', now());
    raise exception 'Could not start the export. Please try again.' using errcode = 'P0001';
  end if;
  return v_task;
end;
$$;
revoke all on function public.request_stills_export(uuid, uuid, uuid) from public, anon;
grant execute on function public.request_stills_export(uuid, uuid, uuid) to authenticated;

-- The Slideshow and Post image squads (B3, B4) run as Studio orders, claimed and charged like `build_video`;
-- niche video research (A2) is a Research order.
create or replace function public.studio_order_move(p_id uuid, p_to text, p_text text DEFAULT NULL::text, p_error jsonb DEFAULT NULL::jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_status text := (select status from public.work_orders where id = p_id and kind in ('build_video', 'cut_shorts', 'build_slideshow', 'build_post_image'));
begin
  if v_status is null or v_status in ('done', 'failed', 'cancelled') or v_status = p_to then
    return;
  end if;
  -- A card waits on the founder (a batch card raised while the runner was still finishing): it stays waiting. An
  -- approved card goes back to work through the claims' `running`, never straight to `waiting_order`.
  if p_to = 'waiting_order' and v_status = 'waiting_founder' then
    return;
  end if;
  if p_to = 'waiting_founder' then
    perform public.work_order_wait_founder(p_id, p_text);
  elsif p_to in ('waiting_order', 'running') then
    if v_status <> 'running' then
      perform public.work_order_move(p_id, 'running');
    end if;
    if p_to = 'waiting_order' then
      perform public.work_order_move(p_id, 'waiting_order', p_text);
    end if;
  elsif p_to = 'failed' then
    perform public.work_order_move(p_id, 'failed', p_text, p_error);
  else
    raise exception 'The order runner cannot move an order to %.', p_to using errcode = '22023';
  end if;
end;
$$;

create or replace function public.studio_orders_claim(p_order uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 3) RETURNS SETOF public.work_orders
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_id uuid;
begin
  for v_id in
    select o.id from public.work_orders o
    where o.status = 'queued' and o.kind in ('build_video', 'cut_shorts', 'build_slideshow', 'build_post_image') and (p_order is null or o.id = p_order)
      and not public.cmo_paused(o.user_id)
      and not exists (select 1 from unnest(o.depends_on) d(id) left join public.work_orders w on w.id = d.id
                      where w.status is distinct from 'done')
    order by o.created_at
    limit greatest(1, least(coalesce(p_limit, 3), 10))
    for update skip locked
  loop
    return next public.work_order_move(v_id, 'running');
  end loop;
end;
$$;

create or replace function public.studio_record_usage(p_order_id uuid, p_model text, p_input integer, p_output integer, p_cache_read integer, p_cache_write integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_total bigint;
  v_credits integer;
  v_held integer;
  v_charge integer;
begin
  if not public.studio_brain_call() then
    raise exception 'Only OpenCMO''s Studio team can do this.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.work_orders where id = p_order_id and user_id = v_user and kind in ('build_video', 'cut_shorts', 'build_slideshow', 'build_post_image')) then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if p_input is null or p_output is null or p_cache_read is null or p_cache_write is null
     or least(p_input, p_output, p_cache_read, p_cache_write) < 0 then
    raise exception 'Invalid usage.' using errcode = '22023';
  end if;
  perform public.lock_credit_owner(v_user);
  insert into public.work_order_usage (user_id, order_id, model, input_tokens, output_tokens, cache_read_tokens,
    cache_write_tokens, micro_usd)
  values (v_user, p_order_id, left(coalesce(nullif(p_model, ''), 'unknown'), 64), p_input, p_output, p_cache_read, p_cache_write,
    public.agent_micro_usd(p_model, p_input, p_output, p_cache_read, p_cache_write));
  select coalesce(sum(micro_usd), 0)::bigint into v_total from public.work_order_usage where order_id = p_order_id;
  v_credits := public.agent_credits(v_total);
  v_held := public.credit_held('work_order', p_order_id);
  if v_credits > v_held then
    v_charge := least(v_credits - v_held, greatest(public.credit_balance(v_user), 0));
    if v_charge > 0 then
      perform public.credit_settle(v_user, 'work_order', p_order_id, v_held + v_charge, 'CMO video team usage');
      perform public.work_order_spend(p_order_id, v_charge);
    end if;
  end if;
  return v_credits;
end;
$$;

create or replace function public.studio_work_count() RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select (
    (select count(*) from public.work_orders o where o.status = 'queued' and o.kind in ('build_video', 'cut_shorts', 'build_slideshow', 'build_post_image')
       and not public.cmo_paused(o.user_id)
       and not exists (select 1 from unnest(o.depends_on) d(id) left join public.work_orders w on w.id = d.id
                       where w.status is distinct from 'done'))
    + (select count(*) from public.studio_steps s join public.work_orders o on o.id = s.order_id
       where s.status = 'approved' and o.status not in ('done', 'failed', 'cancelled') and not public.cmo_paused(s.user_id)
         and (s.claimed_at is null or s.claimed_at < now() - interval '10 minutes'))
    + (select count(*) from public.studio_steps s join public.work_orders o on o.id = s.order_id
       where s.next is not null and s.next_done_at is null and o.status not in ('done', 'failed', 'cancelled')
         and not public.cmo_paused(s.user_id)
         and not exists (select 1 from unnest(s.wait_for) w(id) join public.generations g on g.id = w.id
                         where g.status in ('queued', 'running')))
  )::integer
$$;

create or replace function public.work_order_department(p_kind text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  select case p_kind
    when 'post_draft' then 'writer' when 'sales_scan' then 'sales'
    when 'competitor_research' then 'research' when 'pull_metrics' then 'research' when 'review_week' then 'research'
    when 'build_video' then 'studio' when 'cut_shorts' then 'studio' when 'build_slideshow' then 'studio' when 'build_post_image' then 'studio'
    when 'niche_video_research' then 'research'
    when 'publish_post' then 'publish' when 'write_caption' then 'writer' when 'write_video_brief' then 'writer' when 'write_slides' then 'writer'
    else 'brain' end
$$;

commit;
