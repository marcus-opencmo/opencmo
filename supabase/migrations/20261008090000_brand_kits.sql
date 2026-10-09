-- Brand Kit (spec 2026-10-01-brand-kit): màu, font, kiểu phụ đề, khung và logo
-- của một thương hiệu — đặt một lần, clip mới và visual tự theo.
--
-- Bảng mới thay vì `presets`: preset gắn với revision settings kiểu cũ (engine),
-- còn kit áp lên DOCUMENT của editor (op `apply_brand`). Luật đầy đủ của kit là
-- zod `BrandKitSchema` (route, lớp 1); ở đây kiểm hình dạng + những gì chỉ SQL
-- biết chắc: logo phải nằm trong thư mục của chính người dùng.
--
-- Logo: bucket `brand` riêng — ảnh PNG nhỏ (≤ 2 MB), KHÔNG hết hạn theo job
-- (bucket `media` bị dọn theo retention 7 ngày). Trình duyệt upload thẳng vào
-- thư mục của mình; trần 20 file mỗi người thay cho reservation (reservation
-- canh quota video, không hợp với vài logo vài trăm KB).

begin;

create table public.brand_kits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  kit jsonb not null check (jsonb_typeof(kit) = 'object' and octet_length(kit::text) <= 16384),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index brand_kits_user_name_idx on public.brand_kits (user_id, lower(name));
create unique index brand_kits_one_default_idx on public.brand_kits (user_id) where is_default;

alter table public.brand_kits enable row level security;
create policy "đọc brand kit của mình" on public.brand_kits
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.brand_kits from anon, authenticated;

-- Lớp kiểm thứ hai (lớp 1 là zod ở route): hình dạng + logo thuộc về người gọi.
create or replace function public.brand_check_kit(p_user uuid, p_kit jsonb)
returns void language plpgsql immutable set search_path = public
as $$
declare
  v_key text;
  v_font text;
begin
  if p_kit is null or jsonb_typeof(p_kit) <> 'object' or (p_kit->>'version') is distinct from '1' then
    raise exception 'This brand kit is not valid.' using errcode = '22023';
  end if;
  foreach v_key in array array['primary', 'secondary', 'accent', 'text', 'background'] loop
    if coalesce(p_kit->'colors'->>v_key, '') !~ '^#[0-9a-fA-F]{6}$' then
      raise exception 'Brand colors are hex, like #FFD400.' using errcode = '22023';
    end if;
  end loop;
  foreach v_font in array array[p_kit->'fonts'->>'heading', p_kit->'fonts'->>'body'] loop
    if coalesce(v_font, '') !~ '^[A-Za-z0-9 ]{2,40}$' then
      raise exception 'Choose a font from the list.' using errcode = '22023';
    end if;
  end loop;
  if jsonb_typeof(p_kit->'logo') = 'object'
     and coalesce(p_kit->'logo'->>'object', '') !~ ('^' || p_user::text || '/logo-[0-9a-f-]{36}\.png$') then
    raise exception 'Upload the logo again.' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.save_brand_kit(p_id uuid, p_name text, p_kit jsonb)
returns public.brand_kits
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_name text := btrim(coalesce(p_name, ''));
  v_row public.brand_kits;
begin
  if v_name = '' then
    raise exception 'Name this brand kit before saving it.' using errcode = '22023';
  end if;
  if char_length(v_name) > 60 then
    raise exception 'Keep the brand kit name under 60 characters.' using errcode = '22023';
  end if;
  if octet_length(coalesce(p_kit::text, '')) > 16384 then
    raise exception 'This brand kit is too large.' using errcode = '22023';
  end if;
  perform public.brand_check_kit(v_user, p_kit);

  begin
    if p_id is null then
      perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':brand', 1708));
      if (select count(*) from public.brand_kits where user_id = v_user) >= 20 then
        raise exception 'You can keep up to 20 brand kits.' using errcode = 'P0001';
      end if;
      -- Kit đầu tiên tự thành mặc định: tạo xong là clip mới dùng ngay.
      insert into public.brand_kits (user_id, name, kit, is_default)
      values (v_user, v_name, p_kit, not exists(select 1 from public.brand_kits where user_id = v_user))
      returning * into v_row;
    else
      update public.brand_kits set name = v_name, kit = p_kit, updated_at = now()
      where id = p_id and user_id = v_user
      returning * into v_row;
      if not found then
        raise exception 'Brand kit not found.' using errcode = 'P0002';
      end if;
    end if;
  exception when unique_violation then
    raise exception 'A brand kit with this name already exists.' using errcode = '23505';
  end;
  return v_row;
end;
$$;

create or replace function public.set_default_brand_kit(p_id uuid)
returns public.brand_kits
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_row public.brand_kits;
begin
  if not exists(select 1 from public.brand_kits where id = p_id and user_id = v_user) then
    raise exception 'Brand kit not found.' using errcode = 'P0002';
  end if;
  update public.brand_kits set is_default = false where user_id = v_user and is_default and id <> p_id;
  update public.brand_kits set is_default = true where id = p_id returning * into v_row;
  return v_row;
end;
$$;

-- Xoá kit: logo không kit nào khác còn dùng thì vào hàng xoá Storage (cron dọn).
create or replace function public.delete_brand_kit(p_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_row public.brand_kits;
  v_logo text;
begin
  delete from public.brand_kits where id = p_id and user_id = v_user returning * into v_row;
  if not found then return false; end if;
  v_logo := v_row.kit->'logo'->>'object';
  if v_logo is not null and not exists(
    select 1 from public.brand_kits where user_id = v_user and kit->'logo'->>'object' = v_logo
  ) then
    insert into public.storage_deletions (bucket, path, user_id) values ('brand', v_logo, v_user)
    on conflict (bucket, path) do nothing;
  end if;
  return true;
end;
$$;

-- ------------------------------------------------------------ Storage: logo

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brand', 'brand', false, 2097152, array['image/png'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.storage_deletions drop constraint storage_deletions_bucket_check;
alter table public.storage_deletions add constraint storage_deletions_bucket_check
  check (bucket in ('clips', 'sources', 'renders', 'media', 'exports', 'brand'));

-- Đường dẫn đúng dạng + chưa quá 20 file: đủ để một client hỏng không lấp đầy
-- bucket. Cỡ và loại file do chính bucket chặn (file_size_limit, mime).
create or replace function public.brand_logo_allows(p_name text)
returns boolean language sql stable security definer set search_path = public, storage
as $$
  select p_name ~ ('^' || (select auth.uid())::text || '/logo-[0-9a-f-]{36}\.png$')
    and (select count(*) from storage.objects o
         where o.bucket_id = 'brand' and (storage.foldername(o.name))[1] = (select auth.uid())::text) < 20;
$$;
revoke execute on function public.brand_logo_allows(text) from public, anon;
grant execute on function public.brand_logo_allows(text) to authenticated;

drop policy if exists "ghi logo brand vào thư mục của mình" on storage.objects;
create policy "ghi logo brand vào thư mục của mình"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'brand' and public.brand_logo_allows(name));

drop policy if exists "đọc logo brand của mình" on storage.objects;
create policy "đọc logo brand của mình"
  on storage.objects for select to authenticated
  using (bucket_id = 'brand' and (storage.foldername(name))[1] = (select auth.uid())::text);

do $$ declare f text; begin
  foreach f in array array[
    'public.save_brand_kit(uuid,text,jsonb)',
    'public.set_default_brand_kit(uuid)',
    'public.delete_brand_kit(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke execute on function public.brand_check_kit(uuid, jsonb) from public, anon, authenticated;

commit;
