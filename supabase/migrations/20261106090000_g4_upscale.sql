-- G4 (học Palmier: upscale): model nâng độ phân giải video có sẵn.
--
-- Dùng lại năng lực `sourceVideo` của G2 (video nguồn của chính người gọi, worker cắt đoạn và
-- kiểm duyệt); cờ `upscale` chỉ để provider gửi tham số nâng cấp thay cho prompt. Độ dài 1–15 s,
-- đích 1080p hay 2160p (giá ×3). Giá TẠM. Cùng giá trị với packages/contracts/ai-models.json.

begin;

insert into public.ai_models (id, kind, provider, name, price, limits) values
  ('fake-upscale', 'video', 'fake', 'Test upscale', '{"unit":"second","credits":1,"resolution":{"1080p":1,"2160p":3}}',
   '{"maxPromptChars":200,"aspectRatios":["9:16","16:9","1:1"],"durations":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],"resolutions":["1080p","2160p"],"sourceVideo":true,"upscale":true}'),
  ('fal-seedvr-upscale', 'video', 'fal', 'Upscale', '{"unit":"second","credits":2,"resolution":{"1080p":1,"2160p":3}}',
   '{"maxPromptChars":200,"aspectRatios":["9:16","16:9","1:1"],"durations":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],"resolutions":["1080p","2160p"],"sourceVideo":true,"upscale":true}');

commit;
