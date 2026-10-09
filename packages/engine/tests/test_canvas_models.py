import pytest

from opencmo.editing.models import SettingsError, clip_segments, parse_settings
from opencmo.models import Transcript, TranscriptSegment, Word


def test_cut_order_maps_caption_times_and_removes_deleted_words():
    settings = parse_settings({
        "source_start": 0, "source_end": 10,
        "cuts": [{"start": 6, "end": 8}, {"start": 1, "end": 3}],
    }, source_duration=10)
    transcript = Transcript([
        TranscriptSegment(1, 4, "one deleted", [Word(1, 2, "one"), Word(3, 4, "deleted")]),
        TranscriptSegment(6, 8, "later", [Word(6, 8, "later")]),
    ])
    segments = clip_segments(transcript, settings)
    assert settings.duration == 4
    assert [(s.start, s.text) for s in segments] == [(0, "later"), (2, "one")]


@pytest.mark.parametrize("patch", [
    {"cuts": [{"start": 8, "end": 20}]},
    {"cuts": [{"start": 1, "end": 1}]},
    {"caption_style": {"font": "../../font"}},
    {"caption_style": {"size": 999}},
    {"headline_style": {"x": float("nan")}},
    {"broll": [{"asset_id": "../secret", "at": 0, "start": 0, "end": 1}]},
    {"broll": [{"asset_id": "valid.mp4", "at": 9, "start": 0, "end": 3}]},
    {"broll": [{"asset_id": "not a uuid", "at": 0, "start": 0, "end": 1}]},
])
def test_canvas_rejects_invalid_settings(patch):
    with pytest.raises(SettingsError):
        parse_settings({"source_start": 0, "source_end": 10, **patch}, source_duration=10)


def test_canvas_styles_roundtrip_and_old_revision_stays_compatible():
    old = parse_settings({"source_start": 0, "source_end": 10}, source_duration=10)
    assert old.duration == 10
    raw = {**old.to_dict(), "caption_style": {
        "font": "DejaVu Sans", "size": 64, "color": "#ff0000", "bold": False,
        "x": 0.4, "y": 0.6,
    }}
    parsed = parse_settings(raw, source_duration=10)
    assert parsed.to_dict()["caption_style"] == raw["caption_style"]


def test_adjacent_split_does_not_repeat_caption_words():
    transcript = Transcript([TranscriptSegment(0, 2, "hello", [Word(0, 2, "hello")])])
    settings = parse_settings({"source_start": 0, "source_end": 2,
        "cuts": [{"start": 0, "end": .5}, {"start": .5, "end": 2}]}, source_duration=2)
    assert [s.text for s in clip_segments(transcript, settings)] == ["hello"]


def test_broll_accepts_a_media_asset_uuid():
    """Web trỏ B-roll bằng uuid của `media_assets`, bản local bằng tên file.

    Cùng một revision phải đọc được ở cả hai nơi, nên `parse_settings` nhận cả
    hai hình dạng — và chỉ hai hình dạng đó.
    """
    settings = parse_settings({
        "source_start": 0, "source_end": 10,
        "broll": [{"asset_id": "c0ffee00-1111-4222-8333-444455556666",
                   "at": 0, "start": 0, "end": 2}],
    }, source_duration=10)
    assert settings.broll[0]["asset_id"] == "c0ffee00-1111-4222-8333-444455556666"
