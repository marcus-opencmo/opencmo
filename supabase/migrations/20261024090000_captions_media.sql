-- 20261024090000: phụ đề cho media bất kỳ + dịch phụ đề (E4-e, học Palmier add_captions).
--
-- Marcus duyệt giá 04/10: tạo phụ đề 1 credit/phút (làm tròn lên) của đoạn chọn, dịch
-- 1 credit/phút của phụ đề; hỏng thì hoàn. Transcript kết quả nằm CÙNG bảng
-- `editor_transcripts` với transcript đã sửa, nên lớp `captions` trỏ vào
-- `assets/transcripts/<hash>.json` và export đọc được qua `get_editor_transcript` như cũ.
--
-- Tạo phụ đề: task `transcribe_media` trên worker (tải file thư viện đã lên Storage, rút
-- audio đúng đoạn sourceIn…sourceOut, Groq Whisper). Trừ credit lúc tạo task; trigger
-- hoàn khi task failed/cancelled — một chỗ duy nhất, như `sync_generation_from_task`.
--
-- Dịch: chạy trong route Next (gọi model chữ), nên chia ba bước: `charge_` trừ trước,
-- `complete_` ghi transcript và CHỐT phí, `refund_` chỉ hoàn phí chưa chốt. Người dùng tự
-- gọi `refund_` giữa chừng thì `complete_` từ chối → route không trả bản dịch: không có
-- đường nào lấy bản dịch mà không trả tiền.

begin;

alter table public.tasks drop constraint tasks_kind_check;
alter table public.tasks
  add constraint tasks_kind_check
  check (kind in ('preview', 'export', 'probe_media', 'zip', 'client_export', 'finalize', 'generate',
                  'render_document', 'prepare_full', 'transcribe_media'));

/** Trần một lượt phụ đề/dịch (giây): một lượt Whisper và một file audio vừa phải. */
create or replace function public.captions_max_seconds()
returns int language sql immutable as $$ select 1800 $$;

/** 1 credit/phút, làm tròn lên, tối thiểu 1. */
create or replace function public.captions_credits(p_seconds numeric)
returns int language sql immutable as $$ select greatest(1, ceil(p_seconds / 60.0)::int) $$;

-- Hình dạng transcript mà `resolveTranscript` đọc: mảng đoạn {text, words[]}. Dùng chung
-- cho kết quả worker và bản dịch.
create or replace function public.check_transcript_body(p_body text)
returns void
language plpgsql
immutable
as $$
declare
  v_json jsonb;
begin
  if p_body is null or octet_length(p_body) >= 524288 then
    raise exception 'These captions are too large to save.' using errcode = '22023';
  end if;
  begin
    v_json := p_body::jsonb;
  exception when others then
    raise exception 'These captions are not valid JSON.' using errcode = '22023';
  end;
  if jsonb_typeof(v_json) <> 'array' or exists (
    select 1 from jsonb_array_elements(v_json) as segment
    where jsonb_typeof(segment) <> 'object'
       or jsonb_typeof(segment -> 'text') is distinct from 'string'
       or jsonb_typeof(segment -> 'words') is distinct from 'array'
  ) then
    raise exception 'These captions have an unexpected shape.' using errcode = '22023';
  end if;
end;
$$;

-- ============================================================ tạo phụ đề
-- Trả {task_id, credits}. Gọi lại cùng request_id hoặc cùng file + đoạn khi task còn chạy
-- thì trả task đó, không trừ lần hai.
create or replace function public.request_media_captions(
  p_clip_id uuid,
  p_media_id uuid,
  p_source_in numeric default 0,
  p_source_out numeric default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
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
  insert into public.credit_ledger (user_id, delta, reason, job_id)
  values (v_user, -v_credits, 'Captions', v_clip.job_id);
  insert into public.tasks (user_id, kind, clip_id, job_id, asset_id, payload, status, request_id)
  values (v_user, 'transcribe_media', p_clip_id, v_clip.job_id, p_media_id,
          jsonb_build_object('source_in', v_in, 'source_out', v_out, 'credits', v_credits),
          'queued', coalesce(p_request_id, gen_random_uuid()))
  returning * into v_task;
  return jsonb_build_object('task_id', v_task.id, 'credits', v_credits);
end;
$$;

revoke all on function public.request_media_captions(uuid, uuid, numeric, numeric, uuid) from public, anon;
grant execute on function public.request_media_captions(uuid, uuid, numeric, numeric, uuid) to authenticated;

-- Worker chốt: ghi transcript (địa chỉ theo nội dung) + xong task, một giao dịch.
create or replace function public.complete_media_captions(p_task_id uuid, p_attempt_id uuid, p_body text)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_task public.tasks;
  v_hash text;
begin
  select * into v_task from public.tasks
  where id = p_task_id and kind = 'transcribe_media' and status = 'running'
    and attempt_id is not distinct from p_attempt_id
  for update;
  if not found then
    select output ->> 'hash' into v_hash from public.tasks
    where id = p_task_id and status = 'done' and attempt_id is not distinct from p_attempt_id;
    return v_hash;
  end if;
  perform public.check_transcript_body(p_body);
  v_hash := encode(sha256(convert_to(p_body, 'UTF8')), 'hex');
  insert into public.editor_transcripts (clip_id, hash, body)
  values (v_task.clip_id, v_hash, p_body)
  on conflict (clip_id, hash) do nothing;
  update public.tasks
  set status = 'done', error = null, finished_at = now(), lease_until = null,
      output = jsonb_build_object('hash', v_hash, 'src', 'assets/transcripts/' || v_hash || '.json')
  where id = p_task_id;
  return v_hash;
end;
$$;

revoke all on function public.complete_media_captions(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.complete_media_captions(uuid, uuid, text) to service_role;

-- Chỗ DUY NHẤT hoàn credit cho lượt phụ đề hỏng/huỷ (worker fail_task, reclaim hết lượt).
create or replace function public.refund_media_captions_from_task()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_credits int := coalesce((new.payload ->> 'credits')::int, 0);
begin
  if new.kind = 'transcribe_media' and new.status in ('failed', 'cancelled')
     and old.status not in ('failed', 'cancelled', 'done') and v_credits > 0 then
    insert into public.credit_ledger (user_id, delta, reason, job_id)
    values (new.user_id, v_credits, 'Captions refund', new.job_id);
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_refund_media_captions on public.tasks;
create trigger tasks_refund_media_captions
  after update of status on public.tasks
  for each row execute function public.refund_media_captions_from_task();

-- ============================================================ dịch phụ đề
create table if not exists public.caption_translations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  clip_id    uuid not null references public.clips(id) on delete cascade,
  credits    int not null check (credits > 0),
  status     text not null default 'charged' check (status in ('charged', 'done', 'refunded')),
  hash       text check (hash is null or hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index if not exists caption_translations_user_idx on public.caption_translations (user_id, created_at desc);
alter table public.caption_translations enable row level security;
drop policy if exists "đọc lượt dịch của chính mình" on public.caption_translations;
create policy "đọc lượt dịch của chính mình"
  on public.caption_translations for select to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.charge_caption_translation(p_clip_id uuid, p_seconds numeric)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
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
  insert into public.credit_ledger (user_id, delta, reason, job_id)
  values (v_user, -v_credits, 'Caption translation', v_clip.job_id);
  insert into public.caption_translations (user_id, clip_id, credits)
  values (v_user, p_clip_id, v_credits) returning * into v_row;
  return jsonb_build_object('charge_id', v_row.id, 'credits', v_credits);
end;
$$;

create or replace function public.complete_caption_translation(p_charge_id uuid, p_body text)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_row public.caption_translations;
  v_hash text;
begin
  select * into v_row from public.caption_translations
  where id = p_charge_id and user_id = v_user for update;
  if not found or v_row.status <> 'charged' then
    raise exception 'This translation was cancelled. Try again.' using errcode = 'P0001';
  end if;
  perform public.owned_clip(v_row.clip_id, v_user);
  perform public.check_transcript_body(p_body);
  v_hash := encode(sha256(convert_to(p_body, 'UTF8')), 'hex');
  insert into public.editor_transcripts (clip_id, hash, body)
  values (v_row.clip_id, v_hash, p_body)
  on conflict (clip_id, hash) do nothing;
  update public.caption_translations set status = 'done', hash = v_hash where id = v_row.id;
  return v_hash;
end;
$$;

create or replace function public.refund_caption_translation(p_charge_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
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
  insert into public.credit_ledger (user_id, delta, reason, job_id)
  values (v_user, v_row.credits, 'Caption translation refund', (select job_id from public.clips where id = v_row.clip_id));
  return true;
end;
$$;

revoke all on function public.charge_caption_translation(uuid, numeric) from public, anon;
revoke all on function public.complete_caption_translation(uuid, text) from public, anon;
revoke all on function public.refund_caption_translation(uuid) from public, anon;
grant execute on function public.charge_caption_translation(uuid, numeric) to authenticated;
grant execute on function public.complete_caption_translation(uuid, text) to authenticated;
grant execute on function public.refund_caption_translation(uuid) to authenticated;
grant execute on function public.captions_credits(numeric) to authenticated;
grant execute on function public.captions_max_seconds() to authenticated;

commit;
