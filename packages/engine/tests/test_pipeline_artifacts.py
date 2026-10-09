"""Pipeline phát artifact ngay khi có, kể cả khi bước sau hỏng — không chạm mạng/ffmpeg."""

from types import SimpleNamespace

import pytest

from opencmo import pipeline
from opencmo.config import Config
from opencmo.models import Moment, SourceInfo, Transcript, TranscriptSegment


def _stub_steps(monkeypatch, *, render_error: Exception | None = None) -> None:
    source = SourceInfo(url="https://youtu.be/x", title="Talk", duration=120.0)
    transcript = Transcript(segments=[TranscriptSegment(0.0, 60.0, "hello " * 50)])

    def render_all(*_args, **_kwargs):
        if render_error is not None:
            raise render_error
        return []

    monkeypatch.setattr(pipeline, "require_binaries", lambda: None)
    monkeypatch.setattr(pipeline, "transcript_has_enough_speech", lambda _t, _d: True)
    monkeypatch.setattr(
        pipeline.encoder_mod, "detect", lambda _preferred: SimpleNamespace(name="libx264")
    )
    monkeypatch.setattr(pipeline.download, "probe", lambda _url, _cfg: source)
    monkeypatch.setattr(pipeline.download, "fetch_subtitles", lambda _url, _cfg, _w: transcript)
    monkeypatch.setattr(
        pipeline.select,
        "select_moments",
        lambda _t, _cfg, count, source_duration: [Moment(10.0, 40.0, "hook", 8.0, "why")],
    )
    monkeypatch.setattr(
        pipeline.download, "download_sections", lambda _url, _m, _cfg, _w: [(None, 0.0)]
    )
    monkeypatch.setattr(pipeline.render, "render_all", render_all)


def test_artifacts_are_emitted_in_pipeline_order(monkeypatch, tmp_path):
    _stub_steps(monkeypatch)
    seen = []

    pipeline.run_pipeline(
        "https://youtu.be/x",
        Config(out_dir=tmp_path),
        clip_count=1,
        on_artifact=lambda kind, data: seen.append((kind, data)),
    )

    assert [kind for kind, _ in seen] == ["source", "transcript", "moments", "render_settings"]
    data = dict(seen)
    assert data["source"]["duration"] == 120.0
    assert data["transcript"]["version"] == 1
    assert data["moments"]["moments"][0]["start"] == 10.0
    assert data["render_settings"]["encoder"] == "libx264"


def test_transcript_is_kept_when_render_fails(monkeypatch, tmp_path):
    _stub_steps(monkeypatch, render_error=RuntimeError("ffmpeg died"))
    seen = []

    with pytest.raises(RuntimeError, match="ffmpeg died"):
        pipeline.run_pipeline(
            "https://youtu.be/x",
            Config(out_dir=tmp_path),
            clip_count=1,
            on_artifact=lambda kind, _data: seen.append(kind),
        )

    assert seen[:3] == ["source", "transcript", "moments"]


def test_sections_callback_reuses_exact_downloads(monkeypatch, tmp_path):
    _stub_steps(monkeypatch)
    seen = []

    pipeline.run_pipeline(
        "https://youtu.be/x",
        Config(out_dir=tmp_path),
        clip_count=1,
        on_sections=lambda moments, sections: seen.append((moments, sections)),
    )

    assert len(seen) == 1
    assert seen[0][0][0].start == 10.0
    assert seen[0][1] == [(None, 0.0)]


def test_music_without_speech_uses_fallback_and_never_calls_llm(monkeypatch, tmp_path):
    _stub_steps(monkeypatch)
    monkeypatch.setattr(pipeline, "transcript_has_enough_speech", lambda _t, _d: False)
    monkeypatch.setattr(
        pipeline.select,
        "select_moments",
        lambda *_args, **_kwargs: pytest.fail("music fallback must not call transcript LLM"),
    )
    seen = []

    pipeline.run_pipeline(
        "https://youtu.be/music",
        Config(out_dir=tmp_path),
        clip_count=3,
        on_artifact=lambda kind, data: seen.append((kind, data)),
    )

    moments = dict(seen)["moments"]["moments"]
    assert len(moments) == 3
    assert moments[0]["hook"] == "Video highlight 1"


def test_track_tu_on_sections_duoc_chuyen_thang_sang_render(monkeypatch, tmp_path):
    """Bám mặt của worker web phải tới được bước render.

    Không chuyển thì `plan_crop` lấy mẫu lại đúng section đó, đúng cửa sổ đó —
    MediaPipe chạy hai lần mỗi clip, phần đắt nhất của render.
    """
    _stub_steps(monkeypatch)
    nhan = {}

    def render_all(_sections, _moments, _transcript, _cfg, _enc, _out, _work, tracks=None):
        nhan["tracks"] = tracks
        return []

    monkeypatch.setattr(pipeline.render, "render_all", render_all)
    track = [(0.0, 0.4, 0.01)]

    pipeline.run_pipeline(
        "https://youtu.be/x",
        Config(out_dir=tmp_path),
        clip_count=1,
        on_sections=lambda _moments, _sections: [track],
    )

    assert nhan["tracks"] == [track]


def test_retry_uses_saved_transcript_without_provider_call(monkeypatch, tmp_path):
    _stub_steps(monkeypatch)
    saved = Transcript(segments=[TranscriptSegment(0, 60, 'saved caption')])
    monkeypatch.setattr(pipeline.download, 'fetch_subtitles', lambda *_: pytest.fail('retry downloaded captions again'))
    pipeline.run_pipeline(
        'https://youtu.be/x', Config(out_dir=tmp_path), moments=[Moment(10, 40, 'hook')],
        cached_transcript=saved,
    )
