-- R6 (lộ trình dọn hệ video, report kiến trúc 06/10 vấn đề 5): một module credit.
--
-- Trước migration này có sáu kiểu giữ/kết toán/hoàn (job, generation, phụ đề, dịch phụ
-- đề, agent, CMO), mỗi kiểu tự `insert into credit_ledger` theo cách riêng. Sổ cái chỉ có
-- `job_id` để biết một dòng thuộc việc gì, và generation/phụ đề cũng ghi `job_id` của
-- project. Vì thế `job_credits_spent` cộng lẫn tiền của chúng vào tiền clip, và
-- `cancel_job` hoàn hai lần: `refund_job` hoàn hết tổng đó, rồi trigger của task bị huỷ
-- hoàn tiền generation/phụ đề thêm lần nữa.
--
-- Từ đây mỗi dòng ghi mới mang `(ref_kind, ref_id)` = việc nó thuộc về, và mọi đường tính
-- tiền đi qua bốn hàm:
--   credit_hold   — giữ/thu thêm một khoản cho một việc;
--   credit_settle — chốt số cuối của việc: ghi `đang giữ - số cuối` (hoàn phần thừa, hoặc
--                   thu thêm nếu âm);
--   credit_refund — hoàn hết số đang giữ của việc (= settle về 0, không bao giờ âm);
--   credit_held   — số đang giữ của một việc = −tổng delta theo ref.
-- Hoàn tiền tính theo tổng của chính việc đó, nên gọi lại lần hai ghi 0: không cần cờ riêng.
--
-- Các hàm bên dưới chép NGUYÊN bản đang chạy (pg_get_functiondef trên DB đã áp mọi migration
-- trước), chỉ thay câu insert. Giá, giới hạn, khoá và trạng thái giữ nguyên. Riêng thứ tự:
-- `request_media_captions` và `charge_caption_translation` giờ tạo hàng tham chiếu trước rồi
-- mới giữ tiền, để có id.
--
-- Mua gói Polar (`process_polar_event`) KHÔNG đi qua đây: đó là nạp tiền, chống trùng bằng
-- `external_id`, không có việc nào để giữ/hoàn.
--
-- Không backfill: production chưa có dữ liệu (chưa `db push`). Dòng cũ ở DB dev giữ ref null;
-- `credit_held('job', …)` vẫn đếm dòng cũ theo `job_id` để job dở dang ở dev hoàn đúng.

begin;

alter table public.credit_ledger
  add column ref_kind text
    check (ref_kind in ('job', 'generation', 'captions', 'caption_translation', 'agent_turn', 'cmo_run')),
  add column ref_id uuid,
  add constraint credit_ledger_ref_pair check ((ref_kind is null) = (ref_id is null));

create index credit_ledger_ref_idx on public.credit_ledger (ref_kind, ref_id) where ref_kind is not null;

create or replace function public.credit_held(p_ref_kind text, p_ref_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(-sum(delta), 0)::int from public.credit_ledger
  where (ref_kind = p_ref_kind and ref_id = p_ref_id)
     -- Dòng trước R6 chỉ có `job_id`: thời đó mọi dòng có job_id được tính là của job.
     or (p_ref_kind = 'job' and ref_kind is null and job_id = p_ref_id);
$$;

create or replace function public.credit_hold(
  p_user uuid, p_ref_kind text, p_ref_id uuid, p_amount int, p_reason text, p_job_id uuid default null
)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if p_amount is null or p_amount <= 0 then
    return 0;
  end if;
  -- Cùng khoá với trigger cập nhật số dư (`profiles`), lấy ở đúng chỗ trigger đã lấy: thứ
  -- tự khoá của các flow không đổi.
  perform public.lock_credit_owner(p_user);
  if public.credit_balance(p_user) < p_amount then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      p_amount, public.credit_balance(p_user) using errcode = 'P0001';
  end if;
  insert into public.credit_ledger (user_id, delta, reason, job_id, ref_kind, ref_id)
  values (p_user, -p_amount, p_reason, p_job_id, p_ref_kind, p_ref_id);
  return p_amount;
end;
$$;

create or replace function public.credit_settle(
  p_user uuid, p_ref_kind text, p_ref_id uuid, p_final int, p_reason text, p_job_id uuid default null
)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_delta int;
begin
  perform public.lock_credit_owner(p_user);
  v_delta := public.credit_held(p_ref_kind, p_ref_id) - greatest(coalesce(p_final, 0), 0);
  if v_delta = 0 then
    return 0;
  end if;
  if v_delta < 0 and public.credit_balance(p_user) < -v_delta then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      -v_delta, public.credit_balance(p_user) using errcode = 'P0001';
  end if;
  insert into public.credit_ledger (user_id, delta, reason, job_id, ref_kind, ref_id)
  values (p_user, v_delta, p_reason, p_job_id, p_ref_kind, p_ref_id);
  return v_delta;
end;
$$;

create or replace function public.credit_refund(
  p_user uuid, p_ref_kind text, p_ref_id uuid, p_reason text, p_job_id uuid default null
)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform public.lock_credit_owner(p_user);
  -- Không bao giờ thu thêm khi "hoàn": số đang giữ âm (đã hoàn quá) thì thôi.
  if public.credit_held(p_ref_kind, p_ref_id) <= 0 then
    return 0;
  end if;
  return public.credit_settle(p_user, p_ref_kind, p_ref_id, 0, p_reason, p_job_id);
end;
$$;

-- Chỉ các hàm security definer (chạy dưới quyền owner) và worker gọi được.
revoke execute on function public.credit_held(text, uuid) from public, anon, authenticated;
revoke execute on function public.credit_hold(uuid, text, uuid, int, text, uuid) from public, anon, authenticated;
revoke execute on function public.credit_settle(uuid, text, uuid, int, text, uuid) from public, anon, authenticated;
revoke execute on function public.credit_refund(uuid, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.credit_held(text, uuid) to service_role;
grant execute on function public.credit_hold(uuid, text, uuid, int, text, uuid) to service_role;
grant execute on function public.credit_settle(uuid, text, uuid, int, text, uuid) to service_role;
grant execute on function public.credit_refund(uuid, text, uuid, text, uuid) to service_role;

-- Tiền đã tiêu của MỘT job clip — không còn lẫn generation/phụ đề cùng project.
create or replace function public.job_credits_spent(p_job_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select public.credit_held('job', p_job_id);
$$;


-- agent_auto_extend
CREATE OR REPLACE FUNCTION public.agent_auto_extend(p_turn_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
  v_more int;
begin
  perform public.lock_credit_owner(v_user);
  select t.* into v_turn from public.agent_turns t
  join public.agent_sessions s on s.id = t.session_id
  where t.id = p_turn_id and s.user_id = v_user
  for update of t;
  if not found then
    raise exception 'Turn not found.' using errcode = 'P0002';
  end if;
  v_more := least(public.agent_extend_credits(), public.agent_auto_hold_cap() - v_turn.hold_credits);
  if v_turn.status <> 'running' or v_more <= 0 or public.credit_balance(v_user) < v_more then
    return v_turn.hold_credits;
  end if;
  perform public.credit_hold(v_user, 'agent_turn', v_turn.id, v_more, 'Assistant hold');
  update public.agent_turns set hold_credits = hold_credits + v_more where id = v_turn.id;
  return v_turn.hold_credits + v_more;
end;
$function$
;

-- agent_begin_turn
CREATE OR REPLACE FUNCTION public.agent_begin_turn(p_session_id uuid, p_prompt text, p_content jsonb)
 RETURNS agent_turns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid := public.require_user();
  v_session public.agent_sessions;
  v_running public.agent_turns;
  v_hold int := public.agent_hold_credits();
  v_turn public.agent_turns;
  v_recent int;
begin
  if p_prompt is null or char_length(trim(p_prompt)) = 0 then
    raise exception 'Tell the assistant what to do.' using errcode = '22023';
  end if;
  if char_length(p_prompt) > 4000 then
    raise exception 'That request is too long. Keep it under 4000 characters.' using errcode = '22023';
  end if;
  if p_content is null or jsonb_typeof(p_content) <> 'array' then
    raise exception 'Invalid assistant message.' using errcode = '22023';
  end if;

  perform public.agent_owned_session(p_session_id, v_user);
  perform public.lock_credit_owner(v_user);
  select * into v_session from public.agent_sessions where id = p_session_id for update;

  select * into v_running from public.agent_turns
  where session_id = p_session_id
    and status in ('running', 'awaiting_browser', 'awaiting_approval', 'awaiting_input', 'awaiting_continue')
  order by number desc limit 1;
  if found then
    if v_session.lock_until is not null and v_session.lock_until > now() then
      raise exception 'The assistant is already working on this clip.' using errcode = 'P0001';
    end if;
    perform public.agent_close_turn(v_running.id, 'failed', 'The assistant stopped responding.');
  end if;

  select count(*) into v_recent from public.agent_turns t
  join public.agent_sessions s on s.id = t.session_id
  where s.user_id = v_user and t.created_at > now() - interval '1 hour';
  if v_recent >= 60 then
    raise exception 'Too many assistant requests. Try again in a few minutes.' using errcode = 'P0001';
  end if;

  if public.credit_balance(v_user) < v_hold then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_hold, public.credit_balance(v_user) using errcode = 'P0001';
  end if;

  insert into public.agent_turns(session_id, number, prompt, hold_credits)
  values (
    p_session_id,
    coalesce((select max(number) from public.agent_turns where session_id = p_session_id), 0) + 1,
    p_prompt, v_hold
  ) returning * into v_turn;

  perform public.credit_hold(v_user, 'agent_turn', v_turn.id, v_hold, 'Assistant hold');

  insert into public.agent_messages(session_id, turn_id, seq, role, content)
  values (
    p_session_id, v_turn.id,
    coalesce((select max(seq) from public.agent_messages where session_id = p_session_id), 0) + 1,
    'user', p_content
  );

  update public.agent_sessions
  set lock_until = now() + interval '6 minutes', updated_at = now()
  where id = p_session_id;
  return v_turn;
end;
$function$
;

-- agent_close_turn
CREATE OR REPLACE FUNCTION public.agent_close_turn(p_turn_id uuid, p_status text, p_error text)
 RETURNS agent_turns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_turn public.agent_turns;
  v_user uuid;
  v_credits int;
begin
  select s.user_id into v_user from public.agent_turns t
  join public.agent_sessions s on s.id = t.session_id where t.id = p_turn_id;
  perform public.lock_credit_owner(v_user);

  select * into v_turn from public.agent_turns where id = p_turn_id for update;
  if v_turn.status not in ('running', 'awaiting_browser', 'awaiting_approval', 'awaiting_input', 'awaiting_continue') then
    return v_turn;
  end if;

  select least(v_turn.hold_credits, public.agent_credits(coalesce(sum(u.micro_usd), 0)::bigint))
    into v_credits
  from public.agent_usage u where u.turn_id = p_turn_id;

  -- Hoàn phần giữ chưa dùng: đang giữ (= hold_credits) − số đã dùng.
  perform public.credit_settle(v_user, 'agent_turn', v_turn.id, v_credits, 'Assistant refund');

  update public.agent_tool_calls set status = 'failed', result = '{"summary":"Not completed"}'::jsonb
  where turn_id = p_turn_id and status = 'pending';

  update public.agent_turns
  set status = p_status, pause_reason = null, error = left(p_error, 500), credits = v_credits, finished_at = now()
  where id = p_turn_id returning * into v_turn;

  update public.agent_sessions set lock_until = null, updated_at = now()
  where id = v_turn.session_id;
  return v_turn;
end;
$function$
;

-- agent_extend_hold
CREATE OR REPLACE FUNCTION public.agent_extend_hold(p_session_id uuid)
 RETURNS agent_turns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
  v_more int := public.agent_extend_credits();
begin
  perform public.agent_owned_session(p_session_id, v_user);
  perform public.lock_credit_owner(v_user);
  select * into v_turn from public.agent_turns
  where session_id = p_session_id and status = 'awaiting_continue' and pause_reason = 'budget'
  order by number desc limit 1
  for update;
  if not found then
    raise exception 'The assistant is not waiting for more credits.' using errcode = 'P0001';
  end if;
  if public.credit_balance(v_user) < v_more then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_more, public.credit_balance(v_user) using errcode = 'P0001';
  end if;
  perform public.credit_hold(v_user, 'agent_turn', v_turn.id, v_more, 'Assistant hold');
  update public.agent_turns
  set hold_credits = hold_credits + v_more, status = 'running', pause_reason = null
  where id = v_turn.id returning * into v_turn;
  update public.agent_sessions set lock_until = now() + interval '6 minutes', updated_at = now()
  where id = p_session_id;
  return v_turn;
end;
$function$
;

-- agent_raise_hold_3d
CREATE OR REPLACE FUNCTION public.agent_raise_hold_3d(p_turn_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
  v_more int;
begin
  perform public.lock_credit_owner(v_user);
  select t.* into v_turn from public.agent_turns t
  join public.agent_sessions s on s.id = t.session_id
  where t.id = p_turn_id and s.user_id = v_user
  for update of t;
  if not found then
    raise exception 'Turn not found.' using errcode = 'P0002';
  end if;
  v_more := public.agent_3d_hold_credits() - v_turn.hold_credits;
  if v_turn.status <> 'running' or v_more <= 0
     or not exists (select 1 from public.agent_tool_calls c where c.turn_id = v_turn.id and c.name = 'preview_3d')
     or public.credit_balance(v_user) < v_more then
    return v_turn.hold_credits;
  end if;
  perform public.credit_hold(v_user, 'agent_turn', v_turn.id, v_more, 'Assistant hold (3D)');
  update public.agent_turns set hold_credits = hold_credits + v_more where id = v_turn.id;
  return v_turn.hold_credits + v_more;
end;
$function$
;

-- cancel_job
CREATE OR REPLACE FUNCTION public.cancel_job(p_job_id uuid)
 RETURNS jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid := public.require_user();
  v_job public.jobs;
  v_was_running boolean;
  v_refunded int;
begin
  -- Cùng thứ tự profiles -> jobs với settle/finalize để tránh deadlock.
  perform public.lock_credit_owner(v_user);
  select * into v_job from public.jobs
  where id = p_job_id and user_id = v_user for update;
  if not found then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if v_job.status = 'cancelled' then return v_job; end if;
  if v_job.status not in ('queued', 'running') then
    raise exception 'This project has already finished.' using errcode = '22023';
  end if;
  -- Đọc TRƯỚC lệnh update: `returning * into v_job` ghi đè hàng cũ ngay sau đó.
  v_was_running := v_job.status = 'running';
  update public.jobs set status = 'cancelled', stage = 'cancelled',
    finished_at = now(), lease_until = null
  where id = p_job_id returning * into v_job;
  v_refunded := public.refund_job(p_job_id, 'Refund: project cancelled');
  -- Job đã `running` nghĩa là worker đã tải/giải mã thật. Hoàn đủ thì start rồi
  -- huỷ là một vòng lặp compute miễn phí. Giữ lại 1 credit — ghi thành dòng
  -- ledger RIÊNG chứ không trừ vào số hoàn, để đối soát đọc được cả hai vế.
  -- Job `failed` vẫn hoàn đủ: lỗi thường là của ta, không phải của người dùng.
  if v_was_running and v_refunded > 1 then
    perform public.credit_hold(v_user, 'job', p_job_id, 1, 'Cancelled while running', p_job_id);
  end if;
  update public.tasks set status = 'cancelled', finished_at = now(), lease_until = null
  where status in ('queued', 'running') and (
    job_id = p_job_id or clip_id in (select id from public.clips where job_id = p_job_id)
    or asset_id in (select id from public.media_assets where job_id = p_job_id)
  );
  return v_job;
end;
$function$
;

-- charge_caption_translation
CREATE OR REPLACE FUNCTION public.charge_caption_translation(p_clip_id uuid, p_seconds numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid := public.require_user();
  v_clip public.clips;
  v_credits int;
  v_row public.caption_translations;
begin
  v_clip := public.owned_clip(p_clip_id, v_user);
  if p_seconds is null or p_seconds <= 0 then
    raise exception 'These captions are empty.' using errcode = '22023';
  end if;
  if p_seconds > public.captions_max_seconds() then
    raise exception 'Translation works on up to % minutes of captions at a time.', public.captions_max_seconds() / 60
      using errcode = '22023';
  end if;
  v_credits := public.captions_credits(p_seconds);
  perform public.lock_credit_owner(v_user);
  if public.credit_balance(v_user) < v_credits then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_credits, public.credit_balance(v_user) using errcode = 'P0001';
  end if;
  insert into public.caption_translations (user_id, clip_id, credits)
  values (v_user, p_clip_id, v_credits) returning * into v_row;
  perform public.credit_hold(v_user, 'caption_translation', v_row.id, v_credits, 'Caption translation', v_clip.job_id);
  return jsonb_build_object('charge_id', v_row.id, 'credits', v_credits);
end;
$function$
;

-- cmo_enqueue
CREATE OR REPLACE FUNCTION public.cmo_enqueue(p_user uuid, p_kind text, p_input jsonb)
 RETURNS cmo_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.cmo_runs;
  v_price integer := public.cmo_job_price(p_kind);
begin
  if p_kind is null or p_kind not in ('plan_week', 'post_draft', 'sales_scan', 'video_pack', 'competitor_research', 'pull_metrics') then
    raise exception 'Unknown task.' using errcode = '22023';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' or octet_length(p_input::text) > 4096 then
    raise exception 'This request is not valid.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':cmo_run', 1713));

  select * into v_row from public.cmo_runs
  where user_id = p_user and kind = p_kind and status in ('queued', 'running')
    and (status = 'queued' or lease_until is null or lease_until > now())
  order by created_at desc limit 1;
  if found then
    return v_row;
  end if;

  if (select count(*) from public.cmo_runs
      where user_id = p_user and kind = p_kind and created_at > now() - interval '1 day') >= public.cmo_job_daily_limit(p_kind) then
    raise exception 'You have reached today''s limit for this task. Try again tomorrow.' using errcode = 'P0001';
  end if;
  if v_price > 0 and public.credit_balance(p_user) < v_price then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_price, public.credit_balance(p_user) using errcode = 'P0001';
  end if;

  insert into public.cmo_runs (user_id, kind, status, input, credits)
  values (p_user, p_kind, 'queued', p_input, v_price) returning * into v_row;
  if v_price > 0 then
    perform public.credit_hold(p_user, 'cmo_run', v_row.id, v_price, 'CMO hold');
  end if;
  return v_row;
end;
$function$
;

-- cmo_refund_run
CREATE OR REPLACE FUNCTION public.cmo_refund_run(p_run cmo_runs)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_run.credits > 0 then
    perform public.credit_refund(p_run.user_id, 'cmo_run', p_run.id, 'CMO refund');
  end if;
end;
$function$
;

-- complete_generation
CREATE OR REPLACE FUNCTION public.complete_generation(p_task_id uuid, p_attempt_id uuid, p_object_name text, p_name text, p_duration numeric, p_width integer, p_height integer, p_credits integer, p_words jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_task public.tasks;
  v_generation public.generations;
  v_asset public.media_assets;
  v_final int;
  v_words jsonb;
begin
  select * into v_task from public.tasks
  where id = p_task_id and kind = 'generate' and attempt_id is not distinct from p_attempt_id
  for update;
  if not found then return false; end if;
  select * into v_generation from public.generations where task_id = p_task_id for update;
  if not found then return false; end if;
  if v_task.status = 'done' then
    return v_generation.status = 'done';
  end if;
  if v_task.status <> 'running' then return false; end if;
  -- Đường dẫn do worker tự đặt; kiểm lại để một lỗi ở worker không gắn file của
  -- project khác vào generation này.
  if p_object_name is null
     or p_object_name !~ ('^' || v_task.user_id || '/' || v_task.job_id || '/gen-[0-9a-f-]{36}\.[a-z0-9]{2,5}$') then
    raise exception 'invalid generated object name';
  end if;

  -- Mốc chữ chỉ có nghĩa với giọng đọc. Sai hình dạng thì BỎ, không làm hỏng
  -- lượt sinh đã trả tiền: voiceover vẫn dùng được, chỉ không có phụ đề.
  if v_generation.kind = 'voice' and p_words is not null
     and jsonb_typeof(p_words) = 'array'
     and jsonb_array_length(p_words) <= 20000
     and octet_length(p_words::text) < 524288
     and not exists (
       select 1 from jsonb_array_elements(p_words) w
       where jsonb_typeof(w) <> 'object'
          or jsonb_typeof(w->'text') is distinct from 'string'
          or jsonb_typeof(w->'start') is distinct from 'number'
          or jsonb_typeof(w->'end') is distinct from 'number'
          or (w->>'start')::numeric < 0
          or (w->>'end')::numeric < (w->>'start')::numeric
     ) then
    v_words := p_words;
  end if;

  insert into public.media_assets (user_id, job_id, storage_path, name, duration, width, height, status, words)
  values (v_task.user_id, v_task.job_id, 'media/' || p_object_name, left(coalesce(nullif(btrim(p_name), ''), 'Generated'), 200),
          p_duration, p_width, p_height, 'ready', v_words)
  returning * into v_asset;

  v_final := least(v_generation.credits_reserved, greatest(coalesce(p_credits, v_generation.credits_reserved), 0));
  update public.generations
  set status = 'done', credits_final = v_final, media_asset_id = v_asset.id, error = null, finished_at = now()
  where id = v_generation.id;
  if v_generation.credits_reserved - v_final > 0 then
    perform public.credit_settle(v_task.user_id, 'generation', v_generation.id, v_final, 'Generate refund', v_task.job_id);
  end if;
  update public.tasks
  set status = 'done', output = jsonb_build_object('media_asset_id', v_asset.id), error = null,
      finished_at = now(), lease_until = null
  where id = p_task_id;
  return true;
end;
$function$
;

-- create_generation
CREATE OR REPLACE FUNCTION public.create_generation(p_job_id uuid, p_clip_id uuid, p_model text, p_spec jsonb, p_spec_hash text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid := public.require_user();
  v_model public.ai_models;
  v_generation public.generations;
  v_task public.tasks;
  v_price int;
begin
  if p_request_id is null then
    raise exception 'Missing request id.' using errcode = '22023';
  end if;
  if p_spec_hash is null or p_spec_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid generation request.' using errcode = '22023';
  end if;
  -- Khoá theo người dùng: kiểm số dư, trần đang chạy và trùng hash phải đọc
  -- một trạng thái mà hai request song song không cùng thấy.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 2905));

  -- Gửi lại cùng request id (mạng rớt sau khi server đã ghi) → trả lại đúng lượt đó.
  select g.* into v_generation from public.generations g
  join public.tasks t on t.id = g.task_id
  where t.request_id = p_request_id and g.user_id = v_user;
  if found then
    return jsonb_build_object('generation', to_jsonb(v_generation), 'reused', true);
  end if;
  if exists (select 1 from public.tasks where request_id = p_request_id) then
    raise exception 'That request id was already used.' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.jobs
    where id = p_job_id and user_id = v_user and purging_at is null
  ) then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if p_clip_id is not null and not exists (
    select 1 from public.clips where id = p_clip_id and job_id = p_job_id
  ) then
    raise exception 'Clip not found.' using errcode = 'P0002';
  end if;

  select * into v_model from public.ai_models where id = p_model and enabled;
  if not found then
    raise exception 'This model is not available.' using errcode = '22023';
  end if;
  perform public.ai_check_spec(v_model, p_spec);

  select * into v_generation from public.generations
  where job_id = p_job_id and spec_hash = p_spec_hash and status in ('queued', 'running', 'done');
  if found then
    return jsonb_build_object('generation', to_jsonb(v_generation), 'reused', true);
  end if;

  if (select count(*) from public.generations
      where user_id = v_user and status in ('queued', 'running')) >= public.generation_active_limit() then
    raise exception 'Too many generations are running. Wait for one to finish.' using errcode = 'P0001';
  end if;

  v_price := public.ai_price(v_model, p_spec);
  if public.credit_balance(v_user) < v_price then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_price, public.credit_balance(v_user) using errcode = 'P0001';
  end if;

  insert into public.generations (user_id, job_id, clip_id, kind, model, spec, spec_hash, credits_reserved)
  values (v_user, p_job_id, p_clip_id, v_model.kind, v_model.id, p_spec, p_spec_hash, v_price)
  returning * into v_generation;
  insert into public.tasks (user_id, kind, job_id, clip_id, payload, request_id)
  values (v_user, 'generate', p_job_id, p_clip_id, jsonb_build_object('generation_id', v_generation.id), p_request_id)
  returning * into v_task;
  update public.generations set task_id = v_task.id where id = v_generation.id returning * into v_generation;
  if v_price > 0 then
    perform public.credit_hold(v_user, 'generation', v_generation.id, v_price, 'Generate hold', p_job_id);
  end if;

  return jsonb_build_object('generation', to_jsonb(v_generation), 'reused', false);
end;
$function$
;

-- create_job
CREATE OR REPLACE FUNCTION public.create_job(p_source_url text, p_clips integer DEFAULT 5, p_length text DEFAULT 'auto'::text, p_segments jsonb DEFAULT NULL::jsonb, p_mode text DEFAULT 'clip'::text, p_aspect text DEFAULT '9:16'::text, p_layout text DEFAULT 'auto'::text, p_captions boolean DEFAULT true, p_caption_preset text DEFAULT 'bold'::text)
 RETURNS jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid := public.require_user();
  v_hold int := public.job_hold_credits();
  v_balance int;
  v_plan text;
  v_length text := coalesce(p_length, 'auto');
  v_job public.jobs;
  v_source text := trim(coalesce(p_source_url, ''));
  v_segments jsonb := p_segments;
  v_clips int := p_clips;
  v_mode text := coalesce(p_mode, 'clip');
  v_aspect text := coalesce(p_aspect, '9:16');
  v_layout text := coalesce(p_layout, 'auto');
  v_captions boolean := coalesce(p_captions, true);
  v_preset text := coalesce(p_caption_preset, 'bold');
  v_prev numeric;
  v_item jsonb;
begin
  if v_source = '' then
    raise exception 'Missing video link.' using errcode = '22023';
  end if;
  if v_source not like 'storage://%'
     and (
       v_source !~* '^https?://[^/@[:space:]]+([/:?#]|$)'
       or v_source ~* '^https?://[^/]*@'
       or v_source ~* '^https?://(localhost|127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)([/:?#]|[0-9])'
       or v_source ~* '^https?://\[::1\]([/:?#]|$)'
     )
  then
    raise exception 'Paste a public HTTP or HTTPS video link.' using errcode = '22023';
  end if;

  if v_mode not in ('clip', 'full') then
    raise exception 'Choose whether to clip the video or download it whole.' using errcode = '22023';
  end if;

  if v_segments is not null and jsonb_typeof(v_segments) = 'array'
     and jsonb_array_length(v_segments) = 0 then
    v_segments := null;
  end if;
  if v_mode = 'full' then
    if v_segments is not null then
      raise exception 'Picked moments only apply when we clip your video.' using errcode = '22023';
    end if;
    v_clips := 1;
  end if;

  if v_segments is not null then
    if jsonb_typeof(v_segments) <> 'array' then
      raise exception 'Pick the moments you want on the timeline.' using errcode = '22023';
    end if;
    if jsonb_array_length(v_segments) > 10 then
      raise exception 'Pick at most 10 moments.' using errcode = '22023';
    end if;

    v_prev := null;
    for v_item in
      select value from jsonb_array_elements(v_segments)
      order by (value ->> 'start')::numeric
    loop
      if jsonb_typeof(v_item) is distinct from 'object'
         or jsonb_typeof(v_item -> 'start') is distinct from 'number'
         or jsonb_typeof(v_item -> 'end') is distinct from 'number' then
        raise exception 'Each moment needs a start and end time.' using errcode = '22023';
      end if;
      if (v_item ->> 'start')::numeric < 0 then
        raise exception 'A moment cannot start before the video does.' using errcode = '22023';
      end if;
      if (v_item ->> 'end')::numeric - (v_item ->> 'start')::numeric < 1 then
        raise exception 'Each moment must be at least 1 second long.' using errcode = '22023';
      end if;
      if (v_item ->> 'end')::numeric - (v_item ->> 'start')::numeric > 180 then
        raise exception 'Each moment must be 3 minutes or shorter.' using errcode = '22023';
      end if;
      if v_prev is not null and (v_item ->> 'start')::numeric < v_prev then
        raise exception 'Your moments overlap. Move them apart and try again.' using errcode = '22023';
      end if;
      v_prev := (v_item ->> 'end')::numeric;
    end loop;

    select jsonb_agg(value order by (value ->> 'start')::numeric)
    into v_segments from jsonb_array_elements(v_segments);
    v_clips := jsonb_array_length(v_segments);
  end if;

  if v_clips < 1 or v_clips > 10 then
    raise exception 'Clip count must be between 1 and 10.' using errcode = '22023';
  end if;
  if v_length not in ('auto', 'short', 'medium', 'long') then
    raise exception 'Choose a clip length.' using errcode = '22023';
  end if;
  if v_aspect not in ('9:16', '1:1', '16:9') then
    raise exception 'Unsupported aspect ratio.' using errcode = '22023';
  end if;
  if v_layout not in ('auto', 'fill', 'fit') then
    raise exception 'Unsupported frame layout.' using errcode = '22023';
  end if;
  if v_preset not in ('bold', 'clean', 'minimal') then
    raise exception 'Unsupported caption style.' using errcode = '22023';
  end if;

  if (select count(*) from public.jobs
      where user_id = v_user and status in ('queued', 'running') and purging_at is null) >= 3
  then
    raise exception 'You already have 3 projects in progress. Please wait for one to finish.'
      using errcode = 'P0001';
  end if;

  if not public.rate_limit_hit('jobs', 10, 3600) then
    raise exception 'Too many projects started. Please wait a while and try again.'
      using errcode = 'P0001';
  end if;

  if v_source like 'storage://%' then
    perform public.consume_upload_reservation('sources', substring(v_source from 11), null);
  end if;

  perform 1 from public.profiles where id = v_user for update;
  v_balance := public.credit_balance(v_user);
  if v_balance < v_hold then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_hold, v_balance using errcode = 'P0001';
  end if;
  select plan into v_plan from public.profiles where id = v_user;

  insert into public.jobs(
    user_id, source_url, clips_requested, clip_length, watermark, segments,
    mode, aspect, layout, captions, caption_preset
  ) values(
    v_user, v_source, v_clips, v_length, coalesce(v_plan, 'free') = 'free', v_segments,
    v_mode, v_aspect, v_layout, v_captions, v_preset
  ) returning * into v_job;

  perform public.credit_hold(v_user, 'job', v_job.id, v_hold, 'Hold for new job', v_job.id);
  return v_job;
end;
$function$
;

-- finalize_job_failure
CREATE OR REPLACE FUNCTION public.finalize_job_failure(p_job_id uuid, p_attempt_id uuid, p_error text, p_operation_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid;
  v_prev jsonb;
  v_rows int;
  v_refund int := 0;
  v_result jsonb;
begin
  select user_id into v_user from public.jobs where id = p_job_id;
  if v_user is null then
    return jsonb_build_object('transitioned', false, 'refunded', 0);
  end if;

  perform public.lock_credit_owner(v_user);

  select result into v_prev
  from public.worker_operations where operation_key = p_operation_key;
  if found then
    return v_prev;
  end if;

  update public.jobs
  set status = 'failed',
      error = left(p_error, 2000),
      finished_at = now(),
      lease_until = null
  where id = p_job_id
    and status = 'running'
    and attempt_id is not distinct from p_attempt_id;
  get diagnostics v_rows = row_count;

  if v_rows > 0 then
    v_refund := public.credit_refund(v_user, 'job', p_job_id, 'Refund: job failed', p_job_id);
  end if;

  v_result := jsonb_build_object('transitioned', v_rows > 0, 'refunded', v_refund);

  insert into public.worker_operations (operation_key, job_id, kind, result)
  values (p_operation_key, p_job_id, 'fail', v_result);

  return v_result;
end;
$function$
;

-- reclaim_expired_jobs
CREATE OR REPLACE FUNCTION public.reclaim_expired_jobs(p_max_attempts integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record;
  v_requeued int := 0;
  v_failed int := 0;
begin
  for r in
    select id, user_id, attempt, attempt_id
    from public.jobs
    where status = 'running' and attempt_id is not null and lease_until < now()
    order by lease_until
    limit 50
  loop
    if r.attempt < p_max_attempts then
      update public.jobs
      set status = 'queued', attempt_id = null, lease_until = null,
          heartbeat_at = null, call_id = null
      where id = r.id and status = 'running'
        and attempt_id = r.attempt_id and lease_until < now();
      if found then
        v_requeued := v_requeued + 1;
      end if;
    else
      perform public.lock_credit_owner(r.user_id);

      update public.jobs
      set status = 'failed',
          error = 'Processing was interrupted too many times.',
          finished_at = now(),
          lease_until = null
      where id = r.id and status = 'running'
        and attempt_id = r.attempt_id and lease_until < now();

      if found then
        perform public.credit_refund(r.user_id, 'job', r.id, 'Refund: job failed', r.id);
        v_failed := v_failed + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('requeued', v_requeued, 'failed', v_failed);
end;
$function$
;

-- refund_caption_translation
CREATE OR REPLACE FUNCTION public.refund_caption_translation(p_charge_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid := public.require_user();
  v_row public.caption_translations;
begin
  select * into v_row from public.caption_translations
  where id = p_charge_id and user_id = v_user for update;
  if not found or v_row.status <> 'charged' then
    return false;
  end if;
  update public.caption_translations set status = 'refunded' where id = v_row.id;
  perform public.credit_refund(v_user, 'caption_translation', v_row.id, 'Caption translation refund',
    (select job_id from public.clips where id = v_row.clip_id));
  return true;
end;
$function$
;

-- refund_job
CREATE OR REPLACE FUNCTION public.refund_job(p_job_id uuid, p_reason text DEFAULT 'Refund: job failed'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid;
begin
  select user_id into v_user from public.jobs where id = p_job_id;
  if v_user is null then
    return 0;
  end if;

  perform public.lock_credit_owner(v_user);

  return public.credit_refund(v_user, 'job', p_job_id, p_reason, p_job_id);
end;
$function$
;

-- refund_media_captions_from_task
CREATE OR REPLACE FUNCTION public.refund_media_captions_from_task()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_credits int := coalesce((new.payload ->> 'credits')::int, 0);
begin
  if new.kind = 'transcribe_media' and new.status in ('failed', 'cancelled')
     and old.status not in ('failed', 'cancelled', 'done') and v_credits > 0 then
    perform public.credit_refund(new.user_id, 'captions', new.id, 'Captions refund', new.job_id);
  end if;
  return new;
end;
$function$
;

-- request_media_captions
CREATE OR REPLACE FUNCTION public.request_media_captions(p_clip_id uuid, p_media_id uuid, p_source_in numeric DEFAULT 0, p_source_out numeric DEFAULT NULL::numeric, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid := public.require_user();
  v_clip public.clips;
  v_asset public.media_assets;
  v_in numeric;
  v_out numeric;
  v_credits int;
  v_task public.tasks;
begin
  v_clip := public.owned_clip(p_clip_id, v_user);
  select * into v_asset from public.media_assets
  where id = p_media_id and user_id = v_user and job_id = v_clip.job_id
    and status <> 'rejected' and storage_path like 'media/%';
  if not found then
    raise exception 'This file is not stored with this project. Wait for it to finish uploading.' using errcode = 'P0002';
  end if;
  -- Thư viện báo "synced" ngay khi upload xong, trước khi worker đo xong độ dài: client
  -- thấy câu "still being processed" (409) thì chờ rồi gọi lại, không bắt người dùng bấm lần hai.
  if v_asset.status <> 'ready' then
    raise exception 'This file is still being processed. Try again in a moment.' using errcode = 'P0001';
  end if;
  if v_asset.duration is null or v_asset.duration <= 0 then
    raise exception 'This file has no audio to caption.' using errcode = '22023';
  end if;

  v_in := greatest(0, coalesce(p_source_in, 0));
  v_out := least(v_asset.duration, coalesce(p_source_out, v_asset.duration));
  if v_out - v_in < 0.5 then
    raise exception 'Choose a longer part of the file to caption.' using errcode = '22023';
  end if;
  if v_out - v_in > public.captions_max_seconds() then
    raise exception 'Captions work on up to % minutes at a time. Trim the clip first.', public.captions_max_seconds() / 60
      using errcode = '22023';
  end if;
  v_credits := public.captions_credits(v_out - v_in);

  perform public.lock_credit_owner(v_user);
  if p_request_id is not null then
    select * into v_task from public.tasks where request_id = p_request_id and user_id = v_user;
    if found then
      return jsonb_build_object('task_id', v_task.id, 'credits', (v_task.payload ->> 'credits')::int);
    end if;
  end if;
  select * into v_task from public.tasks
  where user_id = v_user and kind = 'transcribe_media' and clip_id = p_clip_id and asset_id = p_media_id
    and status in ('queued', 'running')
    and (payload ->> 'source_in')::numeric = v_in and (payload ->> 'source_out')::numeric = v_out
  limit 1;
  if found then
    return jsonb_build_object('task_id', v_task.id, 'credits', (v_task.payload ->> 'credits')::int);
  end if;

  if public.credit_balance(v_user) < v_credits then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_credits, public.credit_balance(v_user) using errcode = 'P0001';
  end if;
  insert into public.tasks (user_id, kind, clip_id, job_id, asset_id, payload, status, request_id)
  values (v_user, 'transcribe_media', p_clip_id, v_clip.job_id, p_media_id,
          jsonb_build_object('source_in', v_in, 'source_out', v_out, 'credits', v_credits),
          'queued', coalesce(p_request_id, gen_random_uuid()))
  returning * into v_task;
  perform public.credit_hold(v_user, 'captions', v_task.id, v_credits, 'Captions', v_clip.job_id);
  return jsonb_build_object('task_id', v_task.id, 'credits', v_credits);
end;
$function$
;

-- retry_job
CREATE OR REPLACE FUNCTION public.retry_job(p_job_id uuid)
 RETURNS jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid := public.require_user();
  v_hold int := public.job_hold_credits();
  v_spent int;
  v_balance int;
  v_status public.job_status;
  v_job public.jobs;
begin
  -- Khoá hồ sơ TRƯỚC khi đọc số dư, đúng thứ tự của `create_job`: hai tab bấm
  -- Retry cùng lúc không được tiêu quá số dư.
  perform 1 from public.profiles where id = v_user for update;

  select status into v_status
  from public.jobs
  where id = p_job_id and user_id = v_user
  for update;

  if not found then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if v_status not in ('failed', 'cancelled') then
    raise exception 'Only a failed project can be run again.' using errcode = '22023';
  end if;

  -- Lần chạy trước có thể đã được hoàn credit (`finalize_job_failure`). Giữ lại
  -- đúng phần còn thiếu để một job không bao giờ bị tính tiền hai lần.
  v_spent := public.job_credits_spent(p_job_id);
  if v_spent < v_hold then
    select coalesce(sum(delta), 0)::int into v_balance
    from public.credit_ledger where user_id = v_user;

    if v_balance < v_hold - v_spent then
      raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
        v_hold - v_spent, v_balance using errcode = 'P0001';
    end if;

    perform public.credit_hold(v_user, 'job', p_job_id, v_hold - v_spent, 'Hold for retry', p_job_id);
  end if;

  update public.jobs
  set status = 'queued',
      stage = 'queued',
      error = null,
      finished_at = null,
      -- attempt_id để null: worker của lần chạy cũ (nếu còn sống) ghi bằng
      -- attempt_id cũ sẽ bị mọi RPC có fence từ chối.
      attempt_id = null,
      lease_until = null,
      heartbeat_at = null,
      attempt_started_at = now(),
      call_id = null,
      attempt = 0
  where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$function$
;

-- settle_job_credits
CREATE OR REPLACE FUNCTION public.settle_job_credits(p_job_id uuid, p_duration_seconds numeric, p_operation_key text DEFAULT NULL::text, p_attempt_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid;
  v_status public.job_status;
  v_attempt uuid;
  v_prev jsonb;
  v_ok boolean;
  v_spent int;
  v_actual int;
  v_diff int;
begin
  select user_id into v_user from public.jobs where id = p_job_id;
  if v_user is null then
    raise exception 'No such job: %', p_job_id;
  end if;

  perform public.lock_credit_owner(v_user);

  if p_operation_key is not null then
    select result into v_prev
    from public.worker_operations where operation_key = p_operation_key;
    if found then
      return (v_prev->>'ok')::boolean;
    end if;
  end if;

  select status, attempt_id into v_status, v_attempt
  from public.jobs where id = p_job_id;

  if v_status <> 'running'
     or (p_attempt_id is not null and v_attempt is distinct from p_attempt_id) then
    v_ok := null;
  else
    -- 1 credit = 1 phút nguồn, làm tròn lên. Video 30 giây vẫn tính 1 phút.
    v_actual := greatest(1, ceil(coalesce(p_duration_seconds, 0) / 60.0)::int);
    v_spent := public.job_credits_spent(p_job_id);
    v_diff := v_actual - v_spent;
    v_ok := true;

    if v_diff > 0 and public.credit_balance(v_user) < v_diff then
      perform public.credit_refund(v_user, 'job', p_job_id, 'Refund: not enough credits for the real length', p_job_id);
      v_ok := false;
    elsif v_diff <> 0 then
      -- đang giữ − số thật = −v_diff.
      perform public.credit_settle(v_user, 'job', p_job_id, v_actual, 'Adjusted to real video length', p_job_id);
    end if;
  end if;

  if p_operation_key is not null then
    insert into public.worker_operations (operation_key, job_id, kind, result)
    values (p_operation_key, p_job_id, 'settle', jsonb_build_object('ok', v_ok));
  end if;

  return v_ok;
end;
$function$
;

-- sync_generation_from_task
CREATE OR REPLACE FUNCTION public.sync_generation_from_task()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_generation public.generations;
begin
  if new.kind <> 'generate' or new.status is not distinct from old.status then
    return new;
  end if;
  select * into v_generation from public.generations where task_id = new.id for update;
  if not found or v_generation.status in ('done', 'failed', 'cancelled') then
    return new;
  end if;
  if new.status = 'running' then
    update public.generations set status = 'running' where id = v_generation.id;
  elsif new.status = 'queued' then
    update public.generations set status = 'queued' where id = v_generation.id;
  elsif new.status in ('failed', 'cancelled') then
    update public.generations
    set status = new.status,
        credits_final = 0,
        -- Lỗi chung của vòng lặp worker và của reclaim nói về "Rendering";
        -- người dùng đang sinh media, không render — thay bằng câu đúng việc.
        error = case when new.status = 'failed' then
          case when new.error is null or new.error ilike 'Rendering%'
            then 'Generation failed. Your credits were refunded.'
            else left(new.error, 500) end
        end,
        finished_at = now()
    where id = v_generation.id;
    perform public.credit_refund(v_generation.user_id, 'generation', v_generation.id, 'Generate refund', v_generation.job_id);
  end if;
  return new;
end;
$function$
;

commit;
