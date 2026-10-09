"""File .srt/.txt của một revision: khớp chữ trên video, khớp đoạn trim."""

from __future__ import annotations

import json

from opencmo.editing.models import RevisionSettings, TextEdit, clip_segments
from opencmo.editing.subtitles import to_ds_transcript, to_srt, to_txt
from opencmo.models import Transcript, TranscriptSegment, Word


def _transcript() -> Transcript:
    return Transcript(
        segments=[
            TranscriptSegment(
                10.0,
                14.0,
                "chúng tôi làm nó trong một buổi tối",
                [
                    Word(10.0, 10.5, "chúng"),
                    Word(10.5, 11.0, "tôi"),
                    Word(11.0, 11.5, "làm"),
                    Word(11.5, 12.0, "nó"),
                    Word(12.0, 12.5, "trong"),
                    Word(12.5, 13.0, "một"),
                    Word(13.0, 13.5, "buổi"),
                    Word(13.5, 14.0, "tối"),
                ],
            ),
            TranscriptSegment(20.0, 22.0, "phần sau không nằm trong clip", None),
        ],
        language="vi",
    )


def test_srt_keeps_vietnamese_and_uses_clip_time_after_trim():
    settings = RevisionSettings(source_start=11.0, source_end=14.0)
    srt = to_srt(clip_segments(_transcript(), settings))

    assert "buổi tối" in srt
    # Mốc đầu tiên tính từ giây 0 của clip, không phải giây 11 của nguồn.
    assert srt.startswith("1\n00:00:00,000 --> ")
    assert "phần sau" not in srt
    # Dấu phẩy trước mili giây là đúng chuẩn SRT; dấu chấm là của .ass.
    assert "-->" in srt and "," in srt.splitlines()[1]


def test_txt_excludes_words_outside_trim():
    segments = clip_segments(_transcript(), RevisionSettings(11.0, 13.0))
    assert to_txt(segments) == "làm nó trong một\n"


def test_srt_follows_the_text_edits_saved_in_the_revision():
    settings = RevisionSettings(
        source_start=10.0,
        source_end=14.0,
        text_edits=(TextEdit(13.0, 14.0, "buổi sáng"),),
    )
    segments = clip_segments(_transcript(), settings)
    srt = to_srt(segments)
    txt = to_txt(segments)

    assert "buổi sáng" in srt and "buổi tối" not in srt
    assert txt.strip() == "chúng tôi làm nó trong một buổi sáng"


def test_srt_splits_long_segments_the_same_way_the_video_does():
    # Tám từ: phụ đề trên video chia làm hai cụm ≤5 từ, .srt phải chia y hệt.
    srt = to_srt(clip_segments(_transcript(), RevisionSettings(10.0, 14.0)))
    assert srt.count("-->") == 2


def test_segment_without_word_timings_stays_one_cue():
    transcript = Transcript(segments=[TranscriptSegment(0.0, 3.0, "no word timings here", None)])
    srt = to_srt(clip_segments(transcript, RevisionSettings(0.0, 3.0)))
    assert srt.count("-->") == 1
    assert "no word timings here" in srt


def test_empty_transcript_gives_empty_files_not_a_broken_cue():
    assert to_srt([]) == ""
    assert to_txt([]) == ""


def test_to_ds_transcript_giu_mocword_that():
    """`<captions>` của DS hiện TỪNG TỪ. Mốc phải là mốc thật, không phải mốc
    rải đều theo ký tự — đó là chỗ parser SRT sai và là lý do file này tồn tại."""
    data = json.loads(to_ds_transcript(_transcript().slice(10.0, 14.0)))

    assert [segment["text"] for segment in data] == ["chúng tôi làm nó trong một buổi tối"]
    words = data[0]["words"]
    assert [word["text"] for word in words][:3] == ["chúng", "tôi", "làm"]
    # Gốc 0 là giây 0 của FILE editor mở, không phải của video gốc.
    assert words[0]["start"] == 0.0
    assert words[1]["start"] == 0.5


def test_to_ds_transcript_khong_word_thi_mot_khoi_tron_cau():
    segment = TranscriptSegment(2.0, 5.0, "một câu không có mốc từng từ", None)

    data = json.loads(to_ds_transcript([segment]))

    assert data[0]["words"] == [
        {"text": "một câu không có mốc từng từ", "start": 2.0, "end": 5.0}
    ]


def test_to_ds_transcript_bo_segment_rong():
    """Segment rỗng lọt vào là một cue trống nhấp nháy trên canvas."""
    data = json.loads(to_ds_transcript([TranscriptSegment(1.0, 2.0, "   ", None)]))
    assert data == []
