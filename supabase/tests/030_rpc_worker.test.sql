-- RPC của worker: vòng đời attempt + lease, và chốt chặn "người dùng đăng nhập
-- KHÔNG gọi được".
--
-- Ca quan trọng nhất trong file: attempt cũ về muộn sau khi reconciler đã
-- requeue. Nó phải bị BỎ, không được ghi đè kết quả của attempt đang chạy.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(35);

-- --------------------------------------------------------------- fixture
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-00000000000a', 'a@test.local');

insert into public.jobs (id, user_id, source_url, duration_seconds, status, expires_at) values
  ('a1000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a',
   'storage://a0000000-0000-4000-8000-00000000000a/one.mp4', 600, 'done', now() + interval '3 days');

insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('a2000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-00000000000a', 0, 1, 20, 1, 20),
  ('a2100000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-00000000000a', 1, 30, 50, 30, 50);

insert into public.media_assets (id, user_id, job_id, storage_path, name) values
  ('a5000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a',
   'a1000000-0000-4000-8000-00000000000a',
   'media/a0000000-0000-4000-8000-00000000000a/a1/one.mp4', 'one.mp4');

update public.jobs set attempt_id = 'a9000000-0000-4000-8000-000000000001';

-- ==================================================== create_clip_drafts
select is(
  public.create_clip_drafts('a1000000-0000-4000-8000-00000000000a', 'a9000000-0000-4000-8000-000000000001', jsonb_build_array(
    jsonb_build_object('clip_id', 'a2000000-0000-4000-8000-00000000000a',
                       'settings', '{"source_start": 1, "source_end": 20}'::jsonb,
                       'settings_hash', repeat('a', 64)),
    jsonb_build_object('clip_id', 'a2100000-0000-4000-8000-00000000000a',
                       'settings', '{"source_start": 30, "source_end": 50}'::jsonb,
                       'settings_hash', repeat('b', 64))
  )),
  2, 'create_clip_drafts tạo draft cho mọi clip của job'
);

select is(
  (select count(*) from public.clips where job_id = 'a1000000-0000-4000-8000-00000000000a' and settings is not null)::int, 2,
  'mỗi clip có settings gốc'
);

-- Retry cùng đầu vào không tạo revision mới.
select is(public.create_clip_drafts('a1000000-0000-4000-8000-00000000000a',
  'a9000000-0000-4000-8000-000000000001',
  (select revisions from public.worker_draft_initializations limit 1)),
  0, 'retry không tạo draft mới');

-- ============================================================ put_artifact
select is(
  (public.put_artifact('a1000000-0000-4000-8000-00000000000a', 'a9000000-0000-4000-8000-000000000001', 'transcript', '{"v": 1}'::jsonb)).version,
  1, 'artifact đầu tiên là version 1'
);
select is(
  (public.put_artifact('a1000000-0000-4000-8000-00000000000a', 'a9000000-0000-4000-8000-000000000001', 'transcript', '{"v": 1}'::jsonb)).version,
  1, 'retry giữ nguyên version'
);
select is(
  (select count(*) from public.artifacts where kind = 'transcript')::int, 1,
  'bản cũ vẫn còn'
);

-- ================================================================ claim
insert into public.tasks (id, user_id, kind, clip_id, settings_hash, request_id) values
  ('a6000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', 'zip',
   'a2000000-0000-4000-8000-00000000000a', repeat('1', 64), gen_random_uuid()),
  ('a6000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-00000000000a', 'render_document',
   'a2100000-0000-4000-8000-00000000000a', repeat('2', 64), gen_random_uuid());

select is(
  (select kind from public.claim_next_task(array['zip'])),
  'zip', 'claim_next_task lọc đúng loại việc'
);

select is(
  (select attempt from public.tasks where id = 'a6000000-0000-4000-8000-000000000001'),
  1, 'claim tăng số attempt'
);

select isnt(
  (select attempt_id from public.tasks where id = 'a6000000-0000-4000-8000-000000000001'),
  null, 'claim sinh attempt_id'
);

select ok(
  (select lease_until > now() from public.tasks where id = 'a6000000-0000-4000-8000-000000000001'),
  'claim đặt lease vào tương lai'
);

-- Hàng đợi loại đó đã rỗng: trả 0 hàng chứ không trả một hàng toàn null.
select is_empty(
  $$ select id from public.claim_next_task(array['zip']) $$,
  'hàng đợi rỗng thì claim không trả gì'
);

-- ============================================================ heartbeat
select ok(
  public.heartbeat_task('a6000000-0000-4000-8000-000000000001',
    (select attempt_id from public.tasks where id = 'a6000000-0000-4000-8000-000000000001')),
  'heartbeat của attempt hiện hành được nhận'
);

select ok(
  not public.heartbeat_task('a6000000-0000-4000-8000-000000000001', gen_random_uuid()),
  'heartbeat của attempt lạ bị từ chối'
);

-- ============================================================= complete
select ok(
  public.complete_task('a6000000-0000-4000-8000-000000000001',
    (select attempt_id from public.tasks where id = 'a6000000-0000-4000-8000-000000000001'),
    '{"output_path": "renders/a/one.mp4", "bytes": 1234, "width": 1080, "height": 1920, "duration": 19}'::jsonb),
  'complete_task chốt được task'
);

select is(
  (select output_path from public.tasks where id = 'a6000000-0000-4000-8000-000000000001'),
  'renders/a/one.mp4', 'cột rút ra từ output'
);
select is(
  (select bytes from public.tasks where id = 'a6000000-0000-4000-8000-000000000001'),
  1234::bigint, 'bytes rút ra từ output'
);
select is(
  (select status from public.tasks where id = 'a6000000-0000-4000-8000-000000000001'),
  'done', 'task ở trạng thái done'
);

-- Gọi lại sau khi mất response: vẫn true, không ghi lần hai.
select ok(
  public.complete_task('a6000000-0000-4000-8000-000000000001',
    (select attempt_id from public.tasks where id = 'a6000000-0000-4000-8000-000000000001'), '{}'::jsonb),
  'complete_task gọi lại là idempotent'
);

select ok(
  not public.complete_task('a6000000-0000-4000-8000-000000000001', gen_random_uuid(), '{}'::jsonb),
  'attempt lạ không chốt được task đã xong'
);

-- ================================================== reclaim + attempt cũ
select is((select kind from public.claim_next_task(array['render_document'])), 'render_document', 'claim task render_document');

-- Giả lập worker chết: lease hết hạn.
update public.tasks set lease_until = now() - interval '1 minute'
where id = 'a6000000-0000-4000-8000-000000000002';

-- Giữ lại attempt_id cũ để mô phỏng kết quả về muộn.
create temporary table stale_attempt on commit drop as
select attempt_id from public.tasks where id = 'a6000000-0000-4000-8000-000000000002';

select is(
  public.reclaim_expired_tasks() ->> 'requeued', '1',
  'reclaim đưa task lease hết hạn về hàng đợi'
);
select is(
  (select status from public.tasks where id = 'a6000000-0000-4000-8000-000000000002'),
  'queued', 'task quay lại hàng đợi'
);

-- Attempt mới nhận task.
select is((select kind from public.claim_next_task(array['render_document'])), 'render_document', 'attempt mới nhận lại task');

-- ĐÂY là ca quan trọng: attempt cũ về muộn.
select ok(
  not public.complete_task('a6000000-0000-4000-8000-000000000002',
    (select attempt_id from stale_attempt), '{"output_path": "cu.mp4"}'::jsonb),
  'attempt cũ về muộn KHÔNG chốt được task'
);
select is(
  (select status from public.tasks where id = 'a6000000-0000-4000-8000-000000000002'),
  'running', 'task vẫn thuộc về attempt đang chạy'
);
select is(
  (select output_path from public.tasks where id = 'a6000000-0000-4000-8000-000000000002'),
  null, 'kết quả của attempt cũ không ghi đè'
);

-- Quá số attempt thì chốt failed với câu tiếng Anh.
update public.tasks set attempt = 3, lease_until = now() - interval '1 minute'
where id = 'a6000000-0000-4000-8000-000000000002';

select is(
  public.reclaim_expired_tasks() ->> 'failed', '1',
  'quá số attempt thì chốt failed'
);
select is(
  (select error from public.tasks where id = 'a6000000-0000-4000-8000-000000000002'),
  'Rendering stopped unexpectedly. Please try again.',
  'lỗi hiện ra màn hình là tiếng Anh'
);

-- ==================================================== complete_media_probe
insert into public.tasks (id, user_id, kind, asset_id, request_id)
values ('a6000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-00000000000a',
        'probe_media', 'a5000000-0000-4000-8000-00000000000a', gen_random_uuid());

select ok(
  (select public.complete_media_probe(
     'a5000000-0000-4000-8000-00000000000a',
     (select attempt_id from public.claim_next_task(array['probe_media'])),
     12.5, 1920, 1080, true, null)),
  'probe chốt được asset'
);
select is(
  (select status from public.media_assets where id = 'a5000000-0000-4000-8000-00000000000a'),
  'ready', 'asset sẵn sàng dùng trong timeline'
);

-- =================================================== live_source_paths
-- Job done CHƯA hết hạn phải giữ nguồn: editor cần nó để render lại.
select is(
  (select count(*) from public.live_source_paths())::int, 1,
  'nguồn của job done chưa hết hạn vẫn được giữ'
);

-- =============================== người dùng đăng nhập không gọi được
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-00000000000a"}';

-- Kiểm quyền qua catalog, không gọi hàm thật: pgTAP trên Postgres 17 của
-- Supabase segfault backend khi bắt lỗi permission denied của HÀM
-- (GitHub Actions run 34956743124). Cùng cách đã dùng ở 020 và 027.
select is(
  has_function_privilege('authenticated', 'public.claim_next_task(text[], int)', 'execute'),
  false, 'authenticated không claim được task'
);
select is(
  has_function_privilege('authenticated', 'public.complete_task(uuid, uuid, jsonb)', 'execute'),
  false, 'authenticated không chốt được task'
);
select is(
  has_function_privilege('authenticated', 'public.reclaim_expired_tasks(int)', 'execute'),
  false, 'authenticated không chạy được reconciler'
);
select is(
  has_function_privilege('authenticated', 'public.live_source_paths()', 'execute'),
  false, 'authenticated không đọc được danh sách nguồn'
);

set local role postgres;
select * from finish();
rollback;
