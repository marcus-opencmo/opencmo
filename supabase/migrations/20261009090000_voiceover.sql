-- Voiceover (spec 2026-10-02-voiceover): giọng ElevenLabs có mốc từng chữ.
--
--   * `media_assets.words`: mốc chữ của một giọng đọc `[{text, start, end}]`,
--     giây tính từ đầu file. Editor dựng phụ đề của voiceover từ đây (ghi lại
--     thành `editor_transcripts` để export đọc như mọi transcript đã sửa).
--   * `complete_generation` nhận thêm `p_words` — chỉ giữ cho generation giọng.
--   * Model `elevenlabs-voice`; giọng thử đổi tên `Test A/B/C` để không trùng
--     tên giọng thật (giọng quyết định model — spec AI Studio §7.2).
-- Bản sao của packages/contracts/ai-models.json (check:api so hai bên).

alter table public.media_assets
  add column if not exists words jsonb
  check (words is null or (jsonb_typeof(words) = 'array' and octet_length(words::text) < 524288));

drop function if exists public.complete_generation(uuid, uuid, text, text, numeric, int, int, int);

create or replace function public.complete_generation(
  p_task_id uuid,
  p_attempt_id uuid,
  p_object_name text,
  p_name text,
  p_duration numeric,
  p_width int,
  p_height int,
  p_credits int,
  p_words jsonb default null
)
returns boolean language plpgsql volatile security definer set search_path = public
as $$
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

revoke execute on function public.complete_generation(uuid, uuid, text, text, numeric, int, int, int, jsonb) from public, anon, authenticated;
grant execute on function public.complete_generation(uuid, uuid, text, text, numeric, int, int, int, jsonb) to service_role;

update public.ai_models
set limits = jsonb_set(limits, '{voices}', '["Test A","Test B","Test C"]')
where id = 'fake-voice';

insert into public.ai_models (id, kind, provider, name, price, limits) values
  ('elevenlabs-voice', 'voice', 'elevenlabs', 'ElevenLabs voice', '{"unit":"kchars","credits":5}',
   '{"maxPromptChars":5000,"voices":["Aria","Roger","Sarah","Laura","Charlie","George","Callum","Liam","Charlotte","Matilda","Brian","Jessica"]}')
on conflict (id) do nothing;
