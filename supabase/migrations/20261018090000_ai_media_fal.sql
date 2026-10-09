-- Plan Palmier P1: ảnh/video AI có đủ khả năng theo model (học `VideoCaps` của Palmier).
--
-- Spec nhận thêm, CHỈ khi model khai báo trong `limits`:
--   resolution  (limits.resolutions)  — giá nhân `price.resolution[res]`, làm tròn lên;
--   startImage  (limits.firstFrame)   — ảnh làm frame đầu của video;
--   endImage    (limits.lastFrame)    — ảnh làm frame cuối;
--   references  (limits.maxReferences) — ảnh tham chiếu;
--   audio       (limits.audio)        — bật/tắt tiếng của video.
-- Ảnh là tên object trong bucket `media` của CHÍNH người gọi (`<uid>/...`) và phải
-- tồn tại: không ai đưa ảnh của người khác cho model bằng cách đoán đường dẫn. Worker
-- kiểm lại tiền tố theo chủ task và kiểm duyệt ảnh trước khi gửi đi.
--
-- Cùng luật với `specSchema`/`priceOf` (editor-core) và `validate_spec`/`price_of` (Python).

begin;

create or replace function public.ai_media_ref_ok(p_ref jsonb)
returns boolean language sql stable security definer set search_path = public, storage
as $$
  select jsonb_typeof(p_ref) = 'string'
     and length(p_ref #>> '{}') <= 500
     and (p_ref #>> '{}') like auth.uid()::text || '/%'
     and (p_ref #>> '{}') !~ '\.\.'
     and exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = p_ref #>> '{}');
$$;
revoke execute on function public.ai_media_ref_ok(jsonb) from public, anon, authenticated;

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
  v_scene boolean := coalesce((p_model.limits->>'scene')::boolean, false);
  v_max_refs int := coalesce((p_model.limits->>'maxReferences')::int, 0);
begin
  if v_scene then
    v_allowed := v_allowed || array['scene'];
  end if;
  if p_model.kind in ('image', 'video') then
    if p_model.limits ? 'resolutions' then v_allowed := v_allowed || array['resolution']; end if;
    if v_max_refs > 0 then v_allowed := v_allowed || array['references']; end if;
  end if;
  if p_model.kind = 'video' then
    if coalesce((p_model.limits->>'firstFrame')::boolean, false) then v_allowed := v_allowed || array['startImage']; end if;
    if coalesce((p_model.limits->>'lastFrame')::boolean, false) then v_allowed := v_allowed || array['endImage']; end if;
    if coalesce((p_model.limits->>'audio')::boolean, false) then v_allowed := v_allowed || array['audio']; end if;
  end if;
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
  if p_spec ? 'resolution' and (jsonb_typeof(p_spec->'resolution') is distinct from 'string'
      or not coalesce(p_model.limits->'resolutions' ? (p_spec->>'resolution'), false)) then
    raise exception '% does not support that resolution.', p_model.name using errcode = '22023';
  end if;
  if p_spec ? 'audio' and jsonb_typeof(p_spec->'audio') is distinct from 'boolean' then
    raise exception 'Invalid generation request.' using errcode = '22023';
  end if;
  if (p_spec ? 'startImage' and not public.ai_media_ref_ok(p_spec->'startImage'))
      or (p_spec ? 'endImage' and not public.ai_media_ref_ok(p_spec->'endImage')) then
    raise exception 'That image was not found in your library.' using errcode = '22023';
  end if;
  if p_spec ? 'references' then
    if jsonb_typeof(p_spec->'references') is distinct from 'array'
        or jsonb_array_length(p_spec->'references') not between 1 and v_max_refs then
      raise exception '% takes up to % reference images.', p_model.name, v_max_refs using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_spec->'references') r where not public.ai_media_ref_ok(r)) then
      raise exception 'That image was not found in your library.' using errcode = '22023';
    end if;
  end if;
  if v_scene and (jsonb_typeof(p_spec->'scene') is distinct from 'object'
      or jsonb_typeof(p_spec->'scene'->'template') is distinct from 'string') then
    raise exception 'Describe the 3D scene first.' using errcode = '22023';
  end if;
  if v_scene and octet_length((p_spec->'scene')::text) > 4000 then
    raise exception 'This 3D scene has too much data.' using errcode = '22023';
  end if;
  if v_scene and p_spec->'scene'->>'template' = 'code' and (
      jsonb_typeof(p_spec->'scene'->'code_ref') is distinct from 'string'
      or not exists (select 1 from public.scene_codes c
                     where c.user_id = auth.uid() and c.hash = p_spec->'scene'->>'code_ref')) then
    raise exception 'This 3D scene code was not found. Preview it again.' using errcode = '22023';
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

-- Giá: công thức cũ × hệ số độ phân giải (thiếu = 1), làm tròn lên.
create or replace function public.ai_price(p_model public.ai_models, p_spec jsonb)
returns int language sql immutable set search_path = public
as $$
  select ceil(
    (case p_model.price->>'unit'
      when 'generation' then (p_model.price->>'credits')::numeric
      when 'second' then (p_model.price->>'credits')::numeric * ceil(coalesce((p_spec->>'duration')::numeric, 1))
      when 'kchars' then (p_model.price->>'credits')::numeric
        * greatest(1, ceil(length(btrim(p_spec->>'prompt')) / 1000.0))
    end)
    * coalesce((p_model.price->'resolution'->>(p_spec->>'resolution'))::numeric, 1)
  )::int;
$$;

-- Model qua aggregator fal (một API cho nhiều lab). Giá TẠM theo 1 credit ≈ $0.05
-- chi phí (COSTS.md §6c); chỉ bật khi có FAL_KEY. Cùng thứ tự với ai-models.json.
insert into public.ai_models (id, kind, provider, name, price, limits) values
  ('fal-nano-banana', 'image', 'fal', 'Nano Banana', '{"unit":"generation","credits":1}',
   '{"maxPromptChars":3000,"aspectRatios":["1:1","16:9","9:16","4:3","3:4"],"maxReferences":4}'),
  ('fal-seedream', 'image', 'fal', 'Seedream 4', '{"unit":"generation","credits":1}',
   '{"maxPromptChars":3000,"aspectRatios":["1:1","16:9","9:16","4:3","3:4"],"maxReferences":4,"sizeParam":"image_size"}'),
  ('fal-seedance', 'video', 'fal', 'Seedance Lite', '{"unit":"second","credits":1,"resolution":{"480p":1,"720p":2}}',
   '{"maxPromptChars":2000,"aspectRatios":["16:9","9:16","1:1"],"durations":[5,10],"resolutions":["480p","720p"],"firstFrame":true,"lastFrame":true}'),
  ('fal-kling', 'video', 'fal', 'Kling 2.1 Master', '{"unit":"second","credits":6}',
   '{"maxPromptChars":2500,"aspectRatios":["16:9","9:16","1:1"],"durations":[5,10],"firstFrame":true}'),
  ('fal-hailuo', 'video', 'fal', 'Hailuo 02', '{"unit":"second","credits":1}',
   '{"maxPromptChars":2000,"aspectRatios":["16:9","9:16","1:1"],"durations":[6,10],"firstFrame":true}');

commit;
