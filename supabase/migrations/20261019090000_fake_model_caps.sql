-- Model giả (chỉ dev/CI) có đủ khả năng của model thật: frame đầu/cuối, độ phân giải,
-- ảnh tham chiếu. Nhờ vậy e2e và UAT chạy được cả đường ảnh-đầu-vào (UI → route →
-- `ai_media_ref_ok` → worker tải/kiểm duyệt → provider) mà không cần khoá fal.
-- Cùng giá trị với packages/contracts/ai-models.json.

begin;

update public.ai_models
set limits = limits || '{"maxReferences":2}'
where id = 'fake-image';

update public.ai_models
set limits = limits || '{"resolutions":["480p","720p"],"firstFrame":true,"lastFrame":true}',
    price = price || '{"resolution":{"480p":1,"720p":2}}'
where id = 'fake-video';

commit;
