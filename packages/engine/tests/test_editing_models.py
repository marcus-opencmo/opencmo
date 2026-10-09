"""Model chỉnh sửa: thời gian theo nguồn, giới hạn draft, artifact transcript."""

import json

import pytest

from opencmo.editing.models import (
    HEADLINE_FRAME_HEIGHT,
    HEADLINE_LINE_HEIGHT,
    MAX_HEADLINE,
    RevisionSettings,
    SettingsError,
    TextEdit,
    apply_text_edits,
    clip_headline,
    clip_segments,
    parse_settings,
    settings_hash,
    transcript_from_dict,
    transcript_to_dict,
)
from opencmo.models import Transcript, TranscriptSegment, Word


def _transcript() -> Transcript:
    return Transcript(
        segments=[
            TranscriptSegment(
                10.0,
                13.0,
                "we built this",
                [Word(10.0, 10.4, "we"), Word(10.5, 11.0, "built"), Word(12.0, 12.5, "this")],
            ),
            TranscriptSegment(
                20.0, 22.0, "later words", [Word(20.0, 21.0, "later"), Word(21.0, 22.0, "words")]
            ),
        ],
        language="en",
        source="whisper",
    )


def test_trim_maps_source_time_to_clip_time():
    transcript = _transcript()
    full = clip_segments(transcript, RevisionSettings(source_start=10.0, source_end=15.0))
    trimmed = clip_segments(transcript, RevisionSettings(source_start=10.75, source_end=15.0))

    assert len(full) == 1
    assert [(w.text, w.start) for w in full[0].words] == [("we", 0.0), ("built", 0.5), ("this", 2.0)]
    # Trim đầu: từ đã qua bị bỏ, từ vắt ranh giới bắt đầu ở 0, phần sau dời đúng 10.75s.
    assert [(w.text, w.start) for w in trimmed[0].words] == [("built", 0.0), ("this", 1.25)]


def test_text_edit_rewrites_words_by_source_time_without_touching_original():
    original = _transcript()
    edited = apply_text_edits(original, (TextEdit(10.4, 11.2, "shipped"),))

    assert edited.segments[0].text == "we shipped this"
    assert [w.text for w in edited.segments[0].words] == ["we", "shipped", "this"]
    assert original.segments[0].text == "we built this"


def test_empty_edit_removes_words_and_empty_segments():
    edited = apply_text_edits(_transcript(), (TextEdit(20.0, 22.0, ""),))
    assert [s.text for s in edited.segments] == ["we built this"]


def test_transcript_artifact_round_trips_through_json():
    transcript = _transcript()
    data = json.loads(json.dumps(transcript_to_dict(transcript)))
    assert transcript_from_dict(data) == transcript


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        ({"source_start": 30.0, "source_end": 20.0}, "inside the source"),
        ({"source_end": 61.0}, "inside the source"),
        ({"source_end": 10.5}, "between 1 and 180"),
        ({"source_start": float("nan")}, "finite numbers"),
        ({"source_end": float("inf")}, "finite numbers"),
        ({"source_start": True}, "finite numbers"),
        ({"output_path": "/etc/passwd"}, "Unknown clip setting"),
        ({"layout": "manual"}, "focus point"),
        ({"layout": "manual", "focus_x": 1.5}, "focus point"),
        ({"aspect": "4:5"}, "aspect ratio"),
        ({"captions": "yes"}, "on or off"),
        ({"headline": "x" * 121}, "headline"),
        ({"headline": "line\nbreak"}, "control characters"),
        ({"text_edits": [{"start": 5, "end": 70, "text": "x"}]}, "caption edit"),
        ({"text_edits": [{"start": 5, "end": 6, "text": "x", "path": "/tmp"}]}, "caption edit"),
    ],
)
def test_draft_settings_are_bounded(patch, message):
    raw = {"source_start": 10.0, "source_end": 40.0, **patch}
    with pytest.raises(SettingsError, match=message):
        parse_settings(raw, source_duration=60.0)


def test_valid_settings_round_trip_and_hash_is_stable():
    raw = {
        "source_start": 10,
        "source_end": 40.5,
        "layout": "manual",
        "focus_x": 0.3,
        "text_edits": [{"start": 14, "end": 15, "text": "B"}, {"start": 12, "end": 13, "text": "A"}],
    }
    settings = parse_settings(raw, source_duration=60.0)

    assert [e.text for e in settings.text_edits] == ["A", "B"]
    assert parse_settings(settings.to_dict(), source_duration=60.0) == settings
    assert settings_hash(settings.to_dict()) == settings_hash(
        json.loads(json.dumps(settings.to_dict()))
    )


def _headline_top(hook: str) -> float:
    """Mép TRÊN của khối tiêu đề, tính bằng pixel trên khung 1080×1920.

    Lớp chữ neo tâm, nên mép trên phải suy ra từ `y` và số dòng ước lượng —
    cùng công thức mà `clip_headline` dùng để đặt `y`.
    """
    layer = clip_headline(hook, duration=30.0)[0]
    size = layer["style"]["size"]
    per_line = 1080 * (1 - 2 * 0.08) / (0.54 * size)
    lines = -(-len(layer["text"]) // int(per_line)) if per_line >= 1 else len(layer["text"])
    block = lines * HEADLINE_LINE_HEIGHT * size
    return layer["style"]["y"] * HEADLINE_FRAME_HEIGHT - block / 2


def test_short_headline_keeps_its_old_place():
    """Tiêu đề một dòng không được xê dịch: đa số clip nhìn y như trước."""
    assert clip_headline("Bí quyết ngắn", duration=30.0)[0]["style"]["y"] == 0.12


def test_long_headline_stays_inside_the_frame():
    """Hook dài xuống nhiều dòng thì khối chữ bị đẩy XUỐNG, không tràn khỏi mép trên.

    Đo thật: hook 76 ký tự xuống 5 dòng, neo cố định ở `y=0.12` cắt mất dòng đầu
    khỏi khung. File vẫn ra, vẫn mở được, chỉ là thiếu chữ.
    """
    hook = "Ba câu hỏi khiến nhà đầu tư gật đầu ngay trong năm phút đầu tiên của buổi gặp"
    assert _headline_top(hook) >= 0
    # Cả hook dài nhất mà `parse_settings` chấp nhận cũng phải nằm trong khung.
    assert _headline_top("m" * MAX_HEADLINE) >= 0


def test_headline_never_reaches_the_middle_of_the_frame():
    """Đẩy xuống là để không mất chữ, không phải để tiêu đề đè lên mặt người nói."""
    assert clip_headline("m" * MAX_HEADLINE, duration=30.0)[0]["style"]["y"] < 0.35
