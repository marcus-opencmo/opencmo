-- Mô hình dữ liệu của editor: bảng, cột bắt buộc, index, và các check constraint.
--
-- Check constraint được kiểm bằng `throws_ok` chứ không chỉ bằng `has_check`:
-- một constraint tồn tại mà viết sai điều kiện vẫn cho dữ liệu hỏng đi qua.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(38);

-- ------------------------------------------------------------- fixture
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'schema@test.local');

insert into public.jobs (id, user_id, source_url, duration_seconds, status)
values ('bbbbbbbb-0000-4000-8000-000000000001',
        'aaaaaaaa-0000-4000-8000-000000000001', 'https://youtu.be/x', 600, 'done');

insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end)
values ('cccccccc-0000-4000-8000-000000000001',
        'bbbbbbbb-0000-4000-8000-000000000001', 0, 10, 40, 10, 40);

update public.clips set settings = '{"source_start": 10, "source_end": 40}'::jsonb, settings_hash = repeat('a', 64)
where id = 'cccccccc-0000-4000-8000-000000000001';

-- --------------------------------------------------------------- bảng
select has_table('public', 'artifacts', 'bảng artifacts');
select hasnt_table('public', 'clip_revisions', 'clip_revisions đã gỡ (R7): settings gốc ở clips.settings');
select hasnt_table('public', 'clip_drafts', 'clip_drafts đã gỡ (R7)');
select hasnt_table('public', 'presets', 'presets đã gỡ (R7): Brand kit thay thế');
select has_table('public', 'media_assets', 'bảng media_assets');
select has_table('public', 'tasks', 'bảng tasks');
select has_table('public', 'rate_limits', 'bảng rate_limits');

-- ----------------------------------------------------------- cột thêm
select has_column('public', 'jobs', 'name', 'jobs.name');
select has_column('public', 'jobs', 'stage', 'jobs.stage');
select has_column('public', 'jobs', 'progress', 'jobs.progress');
select has_column('public', 'jobs', 'pinned', 'jobs.pinned');
select has_column('public', 'clips', 'source_start', 'clips.source_start');
select has_column('public', 'clips', 'source_end', 'clips.source_end');

-- ------------------------------------------------------- cột bắt buộc
select col_not_null('public', 'artifacts', 'data', 'artifacts.data not null');
select has_column('public', 'clips', 'settings', 'clips.settings');
select has_column('public', 'clips', 'settings_hash', 'clips.settings_hash');
select hasnt_column('public', 'tasks', 'revision_id', 'tasks.revision_id đã gỡ (R7)');
select col_not_null('public', 'media_assets', 'storage_path', 'media_assets.storage_path not null');
select col_not_null('public', 'tasks', 'user_id', 'tasks.user_id not null');
select col_not_null('public', 'tasks', 'request_id', 'tasks.request_id not null');
select col_not_null('public', 'rate_limits', 'count', 'rate_limits.count not null');

-- ------------------------------------------------------------- index
select has_index('public', 'jobs', 'jobs_user_keyset_idx', 'keyset phân trang');
select has_index('public', 'tasks', 'tasks_queue_idx', 'claim chỉ quét hàng chờ');
select has_index('public', 'tasks', 'tasks_lease_idx', 'reconciler tìm lease hết hạn');
select has_index('public', 'tasks', 'tasks_user_created_idx', 'index cho policy tasks');
select has_index('public', 'media_assets', 'media_assets_job_created_idx', 'B-roll theo project');
select has_index('public', 'media_assets', 'media_assets_user_idx', 'index cho policy media_assets');

-- --------------------------------------------------------- enum + realtime
select ok(
  exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'job_status' and e.enumlabel = 'cancelled'
  ),
  'job_status có giá trị cancelled'
);
select ok(
  exists (select 1 from pg_publication_tables
          where pubname = 'supabase_realtime' and tablename = 'tasks'),
  'realtime phát tasks'
);
select ok(
  exists (select 1 from pg_publication_tables
          where pubname = 'supabase_realtime' and tablename = 'media_assets'),
  'realtime phát media_assets'
);

-- --------------------------------------------------------- check constraint
-- md5 nối nhau để jsonb không nén được xuống dưới trần.
select throws_ok(
  $$ update public.clips set settings = jsonb_build_object('headline',
       (select string_agg(md5(i::text), '') from generate_series(1, 3000) i)), settings_hash = repeat('b', 64)
     where id = 'cccccccc-0000-4000-8000-000000000001' $$,
  '23514', null, 'settings quá lớn bị chặn'
);

select throws_ok(
  $$ update public.clips set settings_hash = 'KHONG-PHAI-HEX'
     where id = 'cccccccc-0000-4000-8000-000000000001' $$,
  '23514', null, 'settings_hash phải là sha256 hex'
);

select throws_ok(
  $$ update public.clips set settings_hash = null
     where id = 'cccccccc-0000-4000-8000-000000000001' $$,
  '23514', null, 'settings đi cùng hash'
);

select throws_ok(
  $$ update public.clips set source_start = 40, source_end = 10
     where id = 'cccccccc-0000-4000-8000-000000000001' $$,
  '23514', null, 'source_end phải lớn hơn source_start'
);

select throws_ok(
  $$ insert into public.artifacts (job_id, kind, data)
     values ('bbbbbbbb-0000-4000-8000-000000000001', 'khong-ton-tai', '{}'::jsonb) $$,
  '23514', null, 'artifact kind nằm trong danh sách'
);

select throws_ok(
  $$ insert into public.tasks (user_id, kind, request_id)
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'khong-ton-tai', gen_random_uuid()) $$,
  '23514', null, 'task kind nằm trong danh sách'
);

select throws_ok(
  $$ insert into public.media_assets (user_id, job_id, storage_path, name, status)
     values ('aaaaaaaa-0000-4000-8000-000000000001',
             'bbbbbbbb-0000-4000-8000-000000000001', 'media/a/b/c.mp4', 'c.mp4', 'khong-ton-tai') $$,
  '23514', null, 'media status nằm trong danh sách'
);

select throws_ok(
  $$ update public.jobs set name = repeat('n', 121)
     where id = 'bbbbbbbb-0000-4000-8000-000000000001' $$,
  '23514', null, 'tên project tối đa 120 ký tự'
);

select * from finish();
rollback;
