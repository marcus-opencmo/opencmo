"""ElevenLabs Scribe: request shape and how words become segments."""

from __future__ import annotations

import pytest

from opencmo.config import Config
from opencmo.models import Word
from opencmo.steps import transcribe


def _word(text: str, start: float, end: float) -> dict:
    return {"text": text, "start": start, "end": end, "type": "word"}


def test_sends_word_timestamps_request_with_api_key(monkeypatch, tmp_path):
    seen = {}

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "language_code": "vie",
                "words": [
                    _word("Xin", 0.0, 0.3), {"text": " ", "start": 0.3, "end": 0.35, "type": "spacing"},
                    _word("chào.", 0.35, 0.8), {"text": "(laughs)", "start": 0.9, "end": 1.0, "type": "audio_event"},
                ],
            }

    def post(url, **kwargs):
        seen.update(url=url, **kwargs)
        return Response()

    monkeypatch.setattr(transcribe.httpx, "post", post)
    audio = tmp_path / "a.m4a"
    audio.write_bytes(b"audio")
    transcript = transcribe.transcribe_audio(audio, Config(elevenlabs_api_key="xi"))

    assert seen["url"].endswith("/v1/speech-to-text")
    assert seen["headers"] == {"xi-api-key": "xi"}
    assert seen["data"]["timestamps_granularity"] == "word"
    assert transcript.language == "vi"
    assert [segment.text for segment in transcript.segments] == ["Xin chào."]
    assert [word.text for word in transcript.segments[0].words] == ["Xin", "chào."]


def test_segments_break_on_sentence_end_pause_and_length():
    words = [
        Word(0.0, 0.4, "First"), Word(0.4, 0.9, "line."),
        Word(1.0, 1.4, "After"), Word(1.4, 1.8, "a"),
        Word(3.0, 3.5, "pause"),
    ] + [Word(5.0 + i, 5.9 + i, "long") for i in range(14)]
    segments = transcribe.segments_from_words(words)

    assert [segment.text for segment in segments[:3]] == ["First line.", "After a", "pause"]
    assert all(segment.end - segment.start <= 12.0 for segment in segments)
    assert sum(len(segment.words) for segment in segments) == len(words)


def test_error_status_uses_the_mapped_prefix(monkeypatch, tmp_path):
    class Response:
        status_code = 429
        text = "busy"

    monkeypatch.setattr(transcribe.httpx, "post", lambda *_a, **_k: Response())
    audio = tmp_path / "a.m4a"
    audio.write_bytes(b"audio")
    with pytest.raises(RuntimeError, match="^Speech-to-text returned 429"):
        transcribe.transcribe_audio(audio, Config(elevenlabs_api_key="xi"))


def test_missing_key_fails_clearly(tmp_path):
    audio = tmp_path / "a.m4a"
    audio.write_bytes(b"audio")
    with pytest.raises(RuntimeError, match="ELEVENLABS_API_KEY"):
        transcribe.transcribe_audio(audio, Config(elevenlabs_api_key=""))
