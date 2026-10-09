-- AI Studio P6–P8: model sinh media thật đầu tiên — Gemini (giọng đọc, ảnh,
-- Veo). Một khoá GEMINI_API_KEY cho cả ba, cùng khoá engine và Assistant đang
-- dùng. Bản sao của packages/contracts/ai-models.json (check:api so hai bên).
--
-- Giá là TẠM (COSTS.md §6c), theo quy ước của Assistant: 1 credit ≈ 50.000
-- micro-USD. Đổi giá = UPDATE hàng ở đây + sửa file catalog, không đổi code.
insert into public.ai_models (id, kind, provider, name, price, limits) values
  ('gemini-image', 'image', 'gemini', 'Nano Banana', '{"unit":"generation","credits":1}',
   '{"maxPromptChars":2000,"aspectRatios":["16:9","9:16","1:1","4:3","3:4"],"maxReferences":0}'),
  ('gemini-video', 'video', 'gemini', 'Veo 3.1 Fast', '{"unit":"second","credits":3}',
   '{"maxPromptChars":2000,"aspectRatios":["9:16","16:9"],"durations":[4,6,8]}'),
  ('gemini-voice', 'voice', 'gemini', 'Gemini voice', '{"unit":"kchars","credits":1}',
   '{"maxPromptChars":5000,"voices":["Kore","Puck","Charon","Aoede","Fenrir","Leda","Orus","Zephyr"]}');
