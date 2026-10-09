-- Kiểm chính bộ test: pgTAP nạp được và nhìn thấy schema đã migrate.
--
-- `create extension` nằm ở file test chứ KHÔNG nằm trong migration: pgtap là
-- công cụ của máy dev, đưa vào migration là cài nó lên cả database production.
--
-- Đặt ngoài `begin` để lần chạy sau không phải tạo lại — phần còn lại của file
-- nằm trong transaction và rollback, nên test không để lại dữ liệu nào.
create extension if not exists pgtap with schema extensions;

begin;
-- pgtap nằm ở schema `extensions`, không tự có trên search_path lúc chạy test.
set search_path to public, extensions;

select plan(2);

select has_table('public', 'jobs', 'migration nền đã chạy');
select has_function('public', 'create_job', 'RPC tạo job có mặt');

select * from finish();
rollback;
