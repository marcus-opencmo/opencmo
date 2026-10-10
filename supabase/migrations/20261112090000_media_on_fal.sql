-- Every generated medium goes through fal: the Gemini (image, video, voice) and ElevenLabs
-- (voice, sound effects, music) models keep their ids, names, prices and limits, and only the
-- provider they route to changes. Saved documents and generations still point at the same ids.
-- Same values as packages/contracts/ai-models.json.

begin;

update public.ai_models
set provider = 'fal'
where id in ('gemini-image', 'gemini-video', 'gemini-voice', 'elevenlabs-voice', 'elevenlabs-sfx', 'elevenlabs-music');

commit;
