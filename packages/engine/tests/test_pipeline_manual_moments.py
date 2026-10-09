"""Nhánh người dùng tự chọn đoạn: bỏ bước LLM, transcribe đúng đoạn đã tải.

Không chạm mạng. Bước trích audio và Whisper được thay bằng stub — thứ cần kiểm
ở đây là THỨ TỰ các bước và phép dời mốc thời gian, không phải ffmpeg.
"""

from pathlib import Path
from types import SimpleNamespace

import pytest

from opencmo import pipeline
from opencmo.config import Config
from opencmo.models import (
    Moment,
    SourceInfo,
    Transcript,
    TranscriptSegment,
    Word,
)


def _stub_steps(monkeypatch, *, subtitles: Transcript | None = None) -> dict:
    """Thay mọi bước đụng mạng/ffmpeg; trả về sổ ghi những gì đã được gọi."""
    goi: dict = {"select": 0, "subtitles": 0, "download_audio": 0, "audio_windows": []}
    source = SourceInfo(url="https://youtu.be/x", title="Talk", duration=3240.0)

    def select_moments(*_args, **_kwargs):
        goi["select"] += 1
        return [Moment(0.0, 30.0, "ai-hook")]

    def fetch_subtitles(*_args, **_kwargs):
        goi["subtitles"] += 1
        return subtitles

    def download_audio(*_args, **_kwargs):
        goi["download_audio"] += 1
        raise AssertionError("Nhánh manual không được tải audio của cả video.")

    def download_sections(_url, moments, _cfg, _work):
        goi["sections"] = list(moments)
        # lead_in = phần đệm đầu file section, giống `download.SECTION_PAD`.
        return [(Path(f"/tmp/section_{i:02d}.mp4"), 1.0) for i, _ in enumerate(moments)]

    def extract_audio(_source, target, *, start=0.0, duration=None):
        goi["audio_windows"].append((start, duration))
        return Path(target)

    def transcribe_audio(_audio, _cfg):
        # Mốc theo gốc 0 CỦA ĐOẠN — pipeline phải dời chúng về gốc video.
        return Transcript(
            segments=[
                TranscriptSegment(
                    1.0, 4.0, "xin chao", words=[Word(1.0, 2.0, "xin"), Word(2.0, 4.0, "chao")]
                )
            ],
            language="vi",
            source="whisper",
        )

    monkeypatch.setattr(pipeline, "require_binaries", lambda: None)
    monkeypatch.setattr(pipeline, "extract_audio", extract_audio)
    monkeypatch.setattr(
        pipeline.encoder_mod, "detect", lambda _p: SimpleNamespace(name="libx264")
    )
    monkeypatch.setattr(pipeline.download, "probe", lambda _url, _cfg: source)
    monkeypatch.setattr(pipeline.download, "fetch_subtitles", fetch_subtitles)
    monkeypatch.setattr(pipeline.download, "download_audio", download_audio)
    monkeypatch.setattr(pipeline.download, "download_sections", download_sections)
    monkeypatch.setattr(pipeline.select, "select_moments", select_moments)
    monkeypatch.setattr(pipeline.transcribe, "transcribe_audio", transcribe_audio)
    monkeypatch.setattr(pipeline.render, "render_all", lambda *a, **k: [])
    return goi


def _chay(tmp_path, **kwargs):
    return pipeline.run_pipeline("https://youtu.be/x", Config(out_dir=tmp_path), **kwargs)


def test_moments_nguoi_dung_thi_khong_goi_llm_va_khong_tai_audio_ca_video(
    monkeypatch, tmp_path
):
    """Lý do tồn tại của nhánh này: hai bước đắt nhất phải biến mất."""
    goi = _stub_steps(monkeypatch)
    chon = [Moment(600.0, 640.0, "Clip 1"), Moment(1200.0, 1230.0, "Clip 2")]

    ket_qua = _chay(tmp_path, moments=chon)

    assert goi["select"] == 0
    assert goi["download_audio"] == 0
    assert goi["sections"] == chon
    assert ket_qua.timings.select == 0.0


def test_tai_doan_truoc_roi_moi_transcribe(monkeypatch, tmp_path):
    """Thứ tự là cả điểm của thay đổi: tải xong mới biết transcribe cái gì."""
    _stub_steps(monkeypatch)
    thu_tu: list[str] = []

    _chay(
        tmp_path,
        moments=[Moment(600.0, 640.0, "Clip 1")],
        on_progress=thu_tu.append,
    )

    assert thu_tu == ["probe", "download", "transcribe", "render"]


def test_chi_transcribe_dung_cua_so_da_chon(monkeypatch, tmp_path):
    """Cắt từ `lead_in` đúng bằng độ dài đoạn — không phải cả file section."""
    goi = _stub_steps(monkeypatch)

    _chay(tmp_path, moments=[Moment(600.0, 640.0, "Clip 1"), Moment(1200.0, 1230.0, "Clip 2")])

    assert goi["audio_windows"] == [(1.0, 40.0), (1.0, 30.0)]


def test_moc_thoi_gian_duoc_doi_ve_goc_video(monkeypatch, tmp_path):
    """Whisper trả mốc theo gốc 0 của đoạn; phụ đề cắt theo gốc VIDEO.

    Quên phép dời này thì `transcript.slice(600, 640)` không khớp segment nào và
    clip ra không có chữ — file mp4 vẫn đúng dung lượng, vẫn mở được.
    """
    _stub_steps(monkeypatch)
    artifacts: dict = {}

    _chay(
        tmp_path,
        moments=[Moment(600.0, 640.0, "Clip 1")],
        on_artifact=lambda kind, data: artifacts.__setitem__(kind, data),
    )

    doan = artifacts["transcript"]["segments"][0]
    assert doan["start"] == 601.0
    assert doan["end"] == 604.0
    assert [w["start"] for w in doan["words"]] == [601.0, 602.0]


def test_phu_de_co_san_thi_khong_goi_whisper(monkeypatch, tmp_path):
    """Phụ đề YouTube vài KB, đã theo gốc video — rẻ hơn mọi đường khác."""
    co_san = Transcript(
        segments=[TranscriptSegment(600.0, 640.0, "co san")], source="subs"
    )
    goi = _stub_steps(monkeypatch, subtitles=co_san)

    _chay(tmp_path, moments=[Moment(600.0, 640.0, "Clip 1")])

    assert goi["subtitles"] == 1
    assert goi["audio_windows"] == []


def test_doan_khong_co_loi_noi_van_ra_clip(monkeypatch, tmp_path):
    """Người dùng đã tự chỉ vào đoạn này — từ chối cắt nó là hành vi thù địch.

    Nhánh AI vẫn ném lỗi ở ca tương đương, vì ở đó transcript thưa nghĩa là LLM
    sắp chọn bừa.
    """
    _stub_steps(monkeypatch, subtitles=Transcript(segments=[], source="subs"))

    # Không ném lỗi là toàn bộ nội dung của test này.
    _chay(tmp_path, moments=[Moment(600.0, 640.0, "Clip 1")])


def test_doan_nguoc_bi_tu_choi(monkeypatch, tmp_path):
    _stub_steps(monkeypatch)

    with pytest.raises(ValueError, match="end after it starts"):
        _chay(tmp_path, moments=[Moment(640.0, 600.0, "Clip 1")])
