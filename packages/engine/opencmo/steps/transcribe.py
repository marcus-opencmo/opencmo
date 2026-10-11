"""Transcript through ElevenLabs Scribe.

Why an API rather than local Whisper: on CPU local Whisper takes minutes, uses 1–10 GB of RAM
and competes with ffmpeg for cores, which breaks the per-job budgets. Scribe returns word-level
timestamps in one call; segments are rebuilt from the words here.
"""

from __future__ import annotations

import logging
from pathlib import Path

import httpx

from ..config import Config
from ..models import Transcript, TranscriptSegment, Word

log = logging.getLogger(__name__)

_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text"
_TIMEOUT = httpx.Timeout(300.0, connect=15.0)
# Scribe accepts far larger files; this cap keeps the upload short so the "45 minutes -> 5 clips
# in under 3 minutes" budget holds (32 kbps mono fits ~100 minutes).
TRANSCRIBE_MAX_BYTES = 24 * 1024 * 1024

# A new segment starts after a sentence ends or after a pause, so captions and moment
# selection get sentence-sized lines like the old Whisper segments.
_SENTENCE_END = (".", "?", "!", "…", "。", "？", "！")
_PAUSE_SECONDS = 0.8
_MAX_SEGMENT_SECONDS = 12.0

# Scribe answers ISO 639-3; the rest of the engine uses two-letter codes like subtitles do.
_LANGUAGES = {
    "eng": "en", "vie": "vi", "spa": "es", "fra": "fr", "deu": "de", "por": "pt", "ita": "it",
    "jpn": "ja", "kor": "ko", "zho": "zh", "cmn": "zh", "rus": "ru", "hin": "hi", "ind": "id",
    "tha": "th", "ara": "ar", "nld": "nl", "pol": "pl", "tur": "tr", "ukr": "uk",
}


def _words(payload: dict) -> list[Word]:
    words: list[Word] = []
    for raw in payload.get("words") or []:
        if raw.get("type", "word") != "word":
            continue
        text = str(raw.get("text", "")).strip()
        if not text:
            continue
        start = float(raw.get("start", 0.0))
        words.append(Word(start=start, end=max(start, float(raw.get("end", start))), text=text))
    return words


def segments_from_words(words: list[Word]) -> list[TranscriptSegment]:
    """Groups words into sentence-sized segments; every segment keeps its words."""
    segments: list[TranscriptSegment] = []
    current: list[Word] = []

    def close() -> None:
        if current:
            segments.append(TranscriptSegment(
                start=current[0].start,
                end=current[-1].end,
                text=" ".join(word.text for word in current),
                words=list(current),
            ))
            current.clear()

    for word in words:
        if current and (
            word.start - current[-1].end > _PAUSE_SECONDS
            or word.end - current[0].start > _MAX_SEGMENT_SECONDS
        ):
            close()
        current.append(word)
        if word.text.endswith(_SENTENCE_END):
            close()
    close()
    return segments


def transcribe_audio(audio_path: Path, cfg: Config) -> Transcript:
    cfg.validate_for_transcribe()

    size = audio_path.stat().st_size
    if size > TRANSCRIBE_MAX_BYTES:
        # Fixed prefix: `worker/errors.py` maps it to a sentence for the user.
        raise RuntimeError(f"Audio is too large to transcribe: {size} bytes.")

    with audio_path.open("rb") as fh:
        response = httpx.post(
            _ENDPOINT,
            headers={"xi-api-key": cfg.elevenlabs_api_key},
            files={"file": (audio_path.name, fh, "audio/m4a")},
            data={
                "model_id": cfg.scribe_model,
                "timestamps_granularity": "word",
                "tag_audio_events": "false",
            },
            timeout=_TIMEOUT,
        )

    if response.status_code != 200:
        raise RuntimeError(
            f"Speech-to-text returned {response.status_code}: {response.text[:300]}"
        )

    payload = response.json()
    segments = segments_from_words(_words(payload))

    # Music without words, montages and silent footage can return no segments. That is a valid
    # result: the pipeline picks a fallback window and renders without captions.
    log.info("Transcribed: %d segments", len(segments))
    code = str(payload.get("language_code") or "en").lower()
    return Transcript(segments=segments, language=_LANGUAGES.get(code, code), source="scribe")
