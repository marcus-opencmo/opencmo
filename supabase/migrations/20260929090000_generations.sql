-- AI Studio P5: mặt phẳng Generate (spec §7).
--
-- Tiền theo khuôn đặt trước → chốt → hoàn:
--   * `create_generation` đặt trước credit và tạo task `generate` trong CÙNG
--     giao dịch — tách ra là mở khe cho task chạy mà không ai trả tiền, hoặc
--     tiền bị giữ mà không task nào chạy;
--   * `complete_generation` (worker) chốt theo chi phí thật, gắn media asset;
--   * task kết thúc `failed`/`cancelled` bằng BẤT KỲ đường nào (fail_task,
--     reclaim hết lượt thử, huỷ) → trigger hoàn toàn bộ. Một chỗ hoàn tiền duy
--     nhất, không phụ thuộc đường nào làm task chết.
--
-- Địa chỉ theo nội dung: cùng (project, hash JCS của {model, spec}) đang chạy
-- hoặc đã xong → trả lại generation cũ, không trừ credit lần hai. Phạm vi là
-- PROJECT chứ không phải người dùng: asset sinh ra là một `media_assets` của
-- job, dọn cùng job — trả kết quả của project khác là trả một file mà project
-- này không đọc được.

-- ================================================================ catalog
-- Bản sao của packages/contracts/ai-models.json. Giá và giới hạn phải nằm ở
-- đây vì RPC là lớp kiểm thứ hai (luật web số 2); check:api so hai bên.
create table public.ai_models (
  id text primary key,
  kind text not null check (kind in ('image', 'video', 'voice', 'audio')),
  provider text not null,
  name text not null,
  price jsonb not null,
  limits jsonb not null,
  enabled boolean not null default true
);
alter table public.ai_models enable row level security;
create policy "đọc catalog" on public.ai_models for select to authenticated using (true);

insert into public.ai_models (id, kind, provider, name, price, limits) values
  ('fake-image', 'image', 'fake', 'Test image', '{"unit":"generation","credits":1}',
   '{"maxPromptChars":2000,"aspectRatios":["16:9","9:16","1:1","4:3","3:4"],"maxReferences":0}'),
  ('fake-video', 'video', 'fake', 'Test video', '{"unit":"second","credits":1}',
   '{"maxPromptChars":2000,"aspectRatios":["16:9","9:16","1:1","4:3","3:4"],"durations":[3,5]}'),
  ('fake-voice', 'voice', 'fake', 'Test voice', '{"unit":"kchars","credits":1}',
   '{"maxPromptChars":5000,"voices":["Aria","Roger","Sarah"]}'),
  ('fake-audio', 'audio', 'fake', 'Test sound', '{"unit":"second","credits":1}',
   '{"maxPromptChars":500,"minSeconds":1,"maxSeconds":22}');

-- ================================================================ dữ liệu
create table public.generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  clip_id uuid references public.clips(id) on delete set null,
  kind text not null check (kind in ('image', 'video', 'voice', 'audio')),
  model text not null references public.ai_models(id),
  spec jsonb not null,
  spec_hash text not null check (spec_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  credits_reserved int not null check (credits_reserved >= 0),
  credits_final int check (credits_final >= 0),
  task_id uuid,
  media_asset_id uuid references public.media_assets(id) on delete set null,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
-- Một kết quả sống cho mỗi (project, spec). Lượt hỏng/huỷ không chặn lượt sau.
create unique index generations_live_hash_idx on public.generations (job_id, spec_hash)
  where status in ('queued', 'running', 'done');
create index generations_user_idx on public.generations (user_id, created_at desc);
create index generations_task_idx on public.generations (task_id);

alter table public.generations enable row level security;
create policy "đọc generation của chính mình" on public.generations for select to authenticated
  using (
    user_id = (select auth.uid())
    and not exists (select 1 from public.jobs j where j.id = generations.job_id and j.purging_at is not null)
  );
alter publication supabase_realtime add table public.generations;

alter table public.tasks drop constraint tasks_kind_check;
alter table public.tasks add constraint tasks_kind_check
  check (kind in ('preview', 'export', 'probe_media', 'zip', 'client_export', 'finalize', 'generate'));

-- File sinh ra nằm trong bucket `media` như B-roll ({user}/{job}/gen-{id}.{ext}):
-- đúng hình dạng mọi luật retention, purge và dọn mồ côi đã biết. Bucket mở
-- thêm ảnh và âm thanh; B-roll người dùng upload vẫn chỉ là video vì task
-- `probe_media` từ chối mọi thứ không phát được như video.
update storage.buckets
set allowed_mime_types = array[
  'video/*', 'image/png', 'image/jpeg', 'image/webp',
  'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4', 'audio/aac'
]
where id = 'media';

-- ================================================================ giá + kiểm spec
-- Cùng công thức với `priceOf` (editor-core/generate.ts) và `price_of` (worker).
create or replace function public.ai_price(p_model public.ai_models, p_spec jsonb)
returns int language sql immutable set search_path = public
as $$
  select case p_model.price->>'unit'
    when 'generation' then (p_model.price->>'credits')::int
    when 'second' then (p_model.price->>'credits')::int * ceil(coalesce((p_spec->>'duration')::numeric, 1))::int
    when 'kchars' then (p_model.price->>'credits')::int
      * greatest(1, ceil(length(btrim(p_spec->>'prompt')) / 1000.0)::int)
  end;
$$;

-- Lớp kiểm thứ hai: cùng luật với `specSchema` (TS) và `validate_spec` (Python).
create or replace function public.ai_check_spec(p_model public.ai_models, p_spec jsonb)
returns void language plpgsql stable set search_path = public
as $$
declare
  v_allowed text[] := case p_model.kind
    when 'image' then array['prompt', 'aspectRatio', 'seed']
    when 'video' then array['prompt', 'aspectRatio', 'duration', 'seed']
    when 'voice' then array['prompt', 'voice', 'seed']
    when 'audio' then array['prompt', 'duration', 'seed']
  end;
  v_prompt text;
begin
  if p_spec is null or jsonb_typeof(p_spec) <> 'object' then
    raise exception 'Invalid generation request.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_spec) k where k <> all (v_allowed)) then
    raise exception 'This request has settings the model does not take.' using errcode = '22023';
  end if;
  v_prompt := case when jsonb_typeof(p_spec->'prompt') = 'string' then p_spec->>'prompt' end;
  if v_prompt is null or btrim(v_prompt) = '' then
    raise exception 'Write a prompt first.' using errcode = '22023';
  end if;
  if length(v_prompt) > (p_model.limits->>'maxPromptChars')::int then
    raise exception 'Keep the prompt under % characters.', p_model.limits->>'maxPromptChars' using errcode = '22023';
  end if;
  if p_spec ? 'seed' and (jsonb_typeof(p_spec->'seed') <> 'number'
      or (p_spec->>'seed')::numeric <> trunc((p_spec->>'seed')::numeric)
      or (p_spec->>'seed')::numeric not between 0 and 2147483647) then
    raise exception 'Invalid seed.' using errcode = '22023';
  end if;
  if p_model.kind in ('image', 'video') and (jsonb_typeof(p_spec->'aspectRatio') is distinct from 'string'
      or not coalesce(p_model.limits->'aspectRatios' ? (p_spec->>'aspectRatio'), false)) then
    raise exception '% does not support that aspect ratio.', p_model.name using errcode = '22023';
  end if;
  if p_model.kind = 'video' and (jsonb_typeof(p_spec->'duration') is distinct from 'number'
      or not (p_model.limits->'durations') @> jsonb_build_array(p_spec->'duration')) then
    raise exception '% does not support that duration.', p_model.name using errcode = '22023';
  end if;
  if p_model.kind = 'voice' and (jsonb_typeof(p_spec->'voice') is distinct from 'string'
      or not coalesce(p_model.limits->'voices' ? (p_spec->>'voice'), false)) then
    raise exception 'Choose one of the listed voices.' using errcode = '22023';
  end if;
  if p_model.kind = 'audio' and (jsonb_typeof(p_spec->'duration') is distinct from 'number'
      or (p_spec->>'duration')::numeric <> trunc((p_spec->>'duration')::numeric)
      or (p_spec->>'duration')::numeric not between (p_model.limits->>'minSeconds')::numeric
                                             and (p_model.limits->>'maxSeconds')::numeric) then
    raise exception 'Sounds are % to % seconds long.', p_model.limits->>'minSeconds', p_model.limits->>'maxSeconds'
      using errcode = '22023';
  end if;
end;
$$;

-- ================================================================ tạo
-- Trần số generation đang chạy mỗi người: chặn một vòng lặp phía client giữ
-- hết credit và chiếm hết worker.
create or replace function public.generation_active_limit()
returns int language sql immutable set search_path = public as $$ select 6 $$;

create or replace function public.create_generation(
  p_job_id uuid,
  p_clip_id uuid,
  p_model text,
  p_spec jsonb,
  p_spec_hash text,
  p_request_id uuid
)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
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
    insert into public.credit_ledger (user_id, delta, reason, job_id)
    values (v_user, -v_price, 'Generate hold', p_job_id);
  end if;

  return jsonb_build_object('generation', to_jsonb(v_generation), 'reused', false);
end;
$$;

-- ================================================================ huỷ
-- Huỷ được khi còn queued hoặc đang chạy. Task đang chạy bị đánh dấu
-- cancelled: heartbeat của worker thua, `complete_generation` trả false và
-- worker xoá file vừa tải lên. Hoàn tiền nằm ở trigger bên dưới.
create or replace function public.cancel_generation(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_generation public.generations;
begin
  select * into v_generation from public.generations where id = p_id and user_id = v_user for update;
  if not found then
    raise exception 'Generation not found.' using errcode = 'P0002';
  end if;
  if v_generation.status in ('queued', 'running') then
    update public.tasks
    set status = 'cancelled', error = 'Cancelled.', finished_at = now(), lease_until = null
    where id = v_generation.task_id and status in ('queued', 'running');
  end if;
  select * into v_generation from public.generations where id = p_id;
  return to_jsonb(v_generation);
end;
$$;

-- ================================================================ trạng thái theo task
-- Generation đi theo task của nó. Mọi đường làm task chết đều đi qua đây, nên
-- đây là chỗ DUY NHẤT hoàn tiền cho lượt hỏng.
create or replace function public.sync_generation_from_task()
returns trigger language plpgsql security definer set search_path = public
as $$
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
    if v_generation.credits_reserved > 0 then
      insert into public.credit_ledger (user_id, delta, reason, job_id)
      values (v_generation.user_id, v_generation.credits_reserved, 'Generate refund', v_generation.job_id);
    end if;
  end if;
  return new;
end;
$$;

create trigger tasks_sync_generation
  after update of status on public.tasks
  for each row execute function public.sync_generation_from_task();

-- ================================================================ worker chốt
create or replace function public.complete_generation(
  p_task_id uuid,
  p_attempt_id uuid,
  p_object_name text,
  p_name text,
  p_duration numeric,
  p_width int,
  p_height int,
  p_credits int
)
returns boolean language plpgsql volatile security definer set search_path = public
as $$
declare
  v_task public.tasks;
  v_generation public.generations;
  v_asset public.media_assets;
  v_final int;
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

  insert into public.media_assets (user_id, job_id, storage_path, name, duration, width, height, status)
  values (v_task.user_id, v_task.job_id, 'media/' || p_object_name, left(coalesce(nullif(btrim(p_name), ''), 'Generated'), 200),
          p_duration, p_width, p_height, 'ready')
  returning * into v_asset;

  v_final := least(v_generation.credits_reserved, greatest(coalesce(p_credits, v_generation.credits_reserved), 0));
  update public.generations
  set status = 'done', credits_final = v_final, media_asset_id = v_asset.id, error = null, finished_at = now()
  where id = v_generation.id;
  if v_generation.credits_reserved - v_final > 0 then
    insert into public.credit_ledger (user_id, delta, reason, job_id)
    values (v_task.user_id, v_generation.credits_reserved - v_final, 'Generate refund', v_task.job_id);
  end if;
  update public.tasks
  set status = 'done', output = jsonb_build_object('media_asset_id', v_asset.id), error = null,
      finished_at = now(), lease_until = null
  where id = p_task_id;
  return true;
end;
$$;

revoke execute on function public.create_generation(uuid, uuid, text, jsonb, text, uuid) from public, anon;
revoke execute on function public.cancel_generation(uuid) from public, anon;
revoke execute on function public.complete_generation(uuid, uuid, text, text, numeric, int, int, int) from public, anon, authenticated;
revoke execute on function public.sync_generation_from_task() from public, anon, authenticated;
grant execute on function public.create_generation(uuid, uuid, text, jsonb, text, uuid) to authenticated;
grant execute on function public.cancel_generation(uuid) to authenticated;
grant execute on function public.complete_generation(uuid, uuid, text, text, numeric, int, int, int) to service_role;
