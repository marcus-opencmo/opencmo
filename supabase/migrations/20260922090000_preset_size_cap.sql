-- `save_preset` kiểm trần kích thước, đối xứng với `save_draft`.
--
-- Bảng `presets` đã có `check (pg_column_size(settings) < 16384)`, nhưng vượt
-- trần thì Postgres ném `23514` thô: PostgREST trả nguyên văn tên ràng buộc về
-- client, và người dùng đọc được "presets_settings_check". `save_draft` đã kiểm
-- trước và trả một câu tiếng Anh; hàm này thì chưa.
--
-- Ngưỡng 16000 chứ không 16384: `pg_column_size` đo giá trị SAU khi nén, nên
-- kiểm trước lúc insert với đúng con số của ràng buộc có thể lọt qua rồi vẫn bị
-- ràng buộc chặn. Chừa biên để câu lỗi tiếng Anh luôn tới trước.
create or replace function public.save_preset(p_name text, p_settings jsonb)
returns public.presets
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_name text := trim(coalesce(p_name, ''));
  v_preset public.presets;
begin
  if v_name = '' then
    raise exception 'Name this preset before saving it.' using errcode = '22023';
  end if;
  if char_length(v_name) > 60 then
    raise exception 'Keep the preset name under 60 characters.' using errcode = '22023';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'Preset settings must be an object.' using errcode = '22023';
  end if;
  if pg_column_size(p_settings) >= 16000 then
    raise exception 'This preset is too large to save.' using errcode = '22023';
  end if;

  begin
    insert into public.presets (user_id, name, settings)
    values (v_user, v_name, p_settings)
    returning * into v_preset;
  exception when unique_violation then
    raise exception 'A preset with this name already exists.' using errcode = '23505';
  end;

  return v_preset;
end;
$$;
