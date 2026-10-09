-- G3 (học Palmier: nhạc/SFX): hai model âm thanh thật qua ElevenLabs.
--
-- `elevenlabs-sfx` (/v1/sound-generation, 1–22 s) và `elevenlabs-music` (/v1/music, 10–60 s,
-- LUÔN không lời — provider gửi `force_instrumental`: không giọng hát nào giống người thật).
-- Giá TẠM (1 và 3 credit một lượt) tới khi đo chi phí thật, như elevenlabs-voice.
-- Chỉ bật khi có ELEVENLABS_API_KEY. Cùng giá trị với packages/contracts/ai-models.json.

begin;

insert into public.ai_models (id, kind, provider, name, price, limits) values
  ('elevenlabs-sfx', 'audio', 'elevenlabs', 'Sound effects', '{"unit":"generation","credits":1}',
   '{"maxPromptChars":450,"minSeconds":1,"maxSeconds":22}'),
  ('elevenlabs-music', 'audio', 'elevenlabs', 'Music', '{"unit":"generation","credits":3}',
   '{"maxPromptChars":2000,"minSeconds":10,"maxSeconds":60}');

commit;
