"""Phân loại transcript để chọn LLM hay fallback video ít lời."""

from itertools import pairwise

from opencmo.config import Config
from opencmo.models import Transcript, TranscriptSegment
from opencmo.quality import fallback_moments, speech_coverage, transcript_has_enough_speech


def test_sparse_music_transcript_uses_visual_fallback_instead_of_rejection():
    transcript = Transcript([TranscriptSegment(i * 60, i * 60 + 1, "Thank you") for i in range(13)])
    assert not transcript_has_enough_speech(transcript, 1800)

    moments = fallback_moments(1800, 3, 10, 60)
    assert len(moments) == 3
    assert all(10 <= moment.duration <= 60 for moment in moments)
    assert all(left.end <= right.start for left, right in pairwise(moments))
    assert moments[0].hook == "Video highlight 1"


def test_normal_speech_and_unspaced_languages_are_accepted():
    assert transcript_has_enough_speech(
        Transcript([TranscriptSegment(0, 20, "Words about making a product " * 8)]), 30
    )
    assert transcript_has_enough_speech(
        Transcript([TranscriptSegment(0, 20, "这是一个有关产品的故事。" * 10)]), 30
    )


def test_do_phu_tinh_tren_cua_so_da_chon_khong_phai_ca_video():
    """Nhánh người dùng tự chọn đoạn chỉ xét đúng đoạn đó.

    40 giây lời nói liên tục trong một video 54 phút cho tỉ lệ 0,012 nếu chia
    cho cả thời lượng — trượt mọi ngưỡng, dù đoạn được chọn kín tiếng từ đầu tới
    cuối. Chia cho cửa sổ đã chọn mới là con số có nghĩa.
    """
    transcript = Transcript([TranscriptSegment(600, 640, "Words about a product " * 12)])

    coverage, considered, _ = speech_coverage(transcript, 3240)
    assert considered == 3240
    assert not transcript_has_enough_speech(transcript, 3240)

    coverage, considered, _ = speech_coverage(transcript, 3240, [(600.0, 640.0)])
    assert (coverage, considered) == (40.0, 40.0)
    assert transcript_has_enough_speech(transcript, 3240, [(600.0, 640.0)])


def test_do_phu_khong_cong_trung_khi_segment_chong_lan():
    """Phụ đề cuộn của YouTube sinh ra các cue chồng lấn nhau."""
    transcript = Transcript(
        [TranscriptSegment(0, 20, "a b c"), TranscriptSegment(10, 30, "c d e")]
    )
    coverage, considered, _ = speech_coverage(transcript, 30)
    assert (coverage, considered) == (30.0, 30.0)


def test_do_phu_bo_qua_loi_noi_nam_ngoai_cua_so():
    """Lời nói ngoài đoạn đã chọn không được cứu một lựa chọn im lặng."""
    transcript = Transcript(
        [TranscriptSegment(0, 500, "Words about a product " * 200), TranscriptSegment(600, 601, "hm")]
    )
    coverage, considered, _ = speech_coverage(transcript, 3240, [(600.0, 640.0)])
    assert (coverage, considered) == (1.0, 40.0)
    assert not transcript_has_enough_speech(transcript, 3240, [(600.0, 640.0)])


def test_parallelism_cannot_exceed_memory_budget(monkeypatch):
    monkeypatch.setenv("OPENCMO_MAX_PARALLEL", "32")
    assert 1 <= Config().max_parallel <= 2
    monkeypatch.setenv("OPENCMO_MAX_PARALLEL", "0")
    assert Config().max_parallel >= 1


def test_proxy_session_is_stable_within_job_and_unique_across_jobs():
    from opencmo.steps.download import _base_opts

    proxy = "http://user:pass_country-us_session-old_lifetime-10m@geo.iproyal.com:12321"
    first, second = Config(proxy=proxy), Config(proxy=proxy)
    assert first.proxy != second.proxy
    assert _base_opts(first)["proxy"] == _base_opts(first)["proxy"]
    assert "_lifetime-10m@" in first.proxy


def test_other_proxy_providers_are_not_rewritten():
    proxy = "http://user:password@proxy.example.com:1234"
    assert Config(proxy=proxy).proxy == proxy
