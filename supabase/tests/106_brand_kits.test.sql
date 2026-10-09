-- Brand Kit (20261008090000): ghi chỉ qua RPC, kit đầu tự mặc định, một mặc
-- định mỗi người, logo phải nằm trong thư mục của chính mình, bucket `brand`.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

insert into auth.users (id, email) values
  ('e1060000-0000-4000-8000-00000000000a', 'brand-a@test.local'),
  ('e1060000-0000-4000-8000-00000000000b', 'brand-b@test.local');

create temp table kit as select jsonb_build_object(
  'version', 1,
  'colors', jsonb_build_object('primary', '#FF5A1F', 'secondary', '#1F2937', 'accent', '#22C55E', 'text', '#F9FAFB', 'background', '#111827'),
  'fonts', jsonb_build_object('heading', 'Anton', 'body', 'DM Sans'),
  'captions', jsonb_build_object('preset', 'spotlight'),
  'layout', jsonb_build_object('aspect', '9:16', 'fit', 'fill'),
  'logo', null
) as value;
grant select on kit to authenticated;

select is((select allowed_mime_types from storage.buckets where id = 'brand'), array['image/png'], 'bucket brand chỉ nhận PNG');
select is((select file_size_limit from storage.buckets where id = 'brand'), 2097152::bigint, 'logo tối đa 2 MB');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1060000-0000-4000-8000-00000000000a"}';

select throws_ok($$ insert into public.brand_kits (user_id, name, kit) values ('e1060000-0000-4000-8000-00000000000a', 'x', '{}') $$,
  '42501', null, 'không insert thẳng được');

select is((select (public.save_brand_kit(null, 'Acme', (select value from kit))).is_default), true, 'kit đầu tiên tự mặc định');
select is((select (public.save_brand_kit(null, 'Acme dark', (select value from kit))).is_default), false, 'kit thứ hai không');
select throws_ok($$ select public.save_brand_kit(null, 'acme', (select value from kit)) $$,
  '23505', 'A brand kit with this name already exists.', 'trùng tên (không phân biệt hoa thường)');
select throws_ok($$ select public.save_brand_kit(null, 'Bad', jsonb_set((select value from kit), '{colors,accent}', '"green"')) $$,
  '22023', 'Brand colors are hex, like #FFD400.', 'màu không phải hex');
select throws_ok($$ select public.save_brand_kit(null, 'Bad', jsonb_set((select value from kit), '{fonts,heading}', '"<script>"')) $$,
  '22023', 'Choose a font from the list.', 'font lạ');
select throws_ok($$ select public.save_brand_kit(null, 'Theft', jsonb_set((select value from kit), '{logo}',
    '{"object":"e1060000-0000-4000-8000-00000000000b/logo-e1060000-0000-4000-8000-0000000000cc.png"}')) $$,
  '22023', 'Upload the logo again.', 'logo của người khác bị chặn');
select lives_ok($$ select public.save_brand_kit(null, 'With logo', jsonb_set((select value from kit), '{logo}',
    '{"object":"e1060000-0000-4000-8000-00000000000a/logo-e1060000-0000-4000-8000-0000000000cc.png","width":400,"height":200,"corner":"top-left","size":0.2,"opacity":1}')) $$,
  'logo của mình thì được');

select lives_ok($$ select public.set_default_brand_kit((select id from public.brand_kits where name = 'Acme dark')) $$, 'đổi mặc định');
select is((select count(*) from public.brand_kits where is_default), 1::bigint, 'luôn chỉ một mặc định');
select is((select name from public.brand_kits where is_default), 'Acme dark', 'mặc định mới');

select is(public.delete_brand_kit((select id from public.brand_kits where name = 'With logo')), true, 'xoá kit');
select is(public.brand_logo_allows('e1060000-0000-4000-8000-00000000000a/logo-e1060000-0000-4000-8000-0000000000dd.png'), true, 'đường dẫn logo hợp lệ');
select is(public.brand_logo_allows('e1060000-0000-4000-8000-00000000000b/logo-e1060000-0000-4000-8000-0000000000dd.png'), false, 'không ghi vào thư mục người khác');
select is(public.brand_logo_allows('e1060000-0000-4000-8000-00000000000a/../x.png'), false, 'đường dẫn lạ bị chặn');

-- Người B không thấy, không sửa được kit của A (id lấy khi còn là A).
create temp table a_kit as select id from public.brand_kits where name = 'Acme';
set local request.jwt.claims = '{"sub":"e1060000-0000-4000-8000-00000000000b"}';
select is((select count(*) from public.brand_kits), 0::bigint, 'B không đọc được kit của A');
select throws_ok($$ select public.save_brand_kit((select id from a_kit), 'x', (select value from kit)) $$,
  'P0002', 'Brand kit not found.', 'B không sửa được kit của A');

reset role;
select is((select count(*) from public.storage_deletions where bucket = 'brand'), 1::bigint, 'logo không còn kit nào dùng thì vào hàng xoá');

select * from finish();
rollback;
