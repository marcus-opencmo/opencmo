-- G2 (học Palmier: image-to-video): Veo 3.1 Fast nhận ảnh đầu ở mọi độ dài 4/6/8 s.
-- Khung cuối và ảnh tham chiếu của Veo bắt buộc 8 s — catalog chưa diễn tả được luật đó
-- nên chưa bật. Cùng giá trị với packages/contracts/ai-models.json.

begin;

update public.ai_models
set limits = limits || '{"firstFrame":true}'
where id = 'gemini-video';

commit;
