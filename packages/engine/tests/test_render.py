"""Kiểm tra phần tính khung cắt — toán thuần, không cần ffmpeg."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from opencmo.config import Config
from opencmo.editing.models import default_settings
from opencmo.media.encoder import Encoder
from opencmo.media.frame import CAPTION_STYLE, crop_rect, resolve_layout
from opencmo.media.frame import even as _even
from opencmo.models import Moment, Transcript
from opencmo.steps import render
from opencmo.steps.reframe import CropPlan
from opencmo.steps.render import (
    _escape_filter_path,
    _safe_name,
    _watermark_filter,
)


def _crop_rect(width: int, height: int, x_center: float):
    """Khung cắt 9:16 — tỉ lệ mặc định của đường pipeline.

    Các tỉ lệ khác kiểm ở `test_editing_render.py`.
    """
    return crop_rect(width, height, 9 / 16, x_center)


def test_crop_landscape_source_is_full_height():
    # Nguồn 16:9 thường gặp: cắt theo chiều ngang, giữ nguyên chiều cao.
    w, h, x, y = _crop_rect(1920, 1080, 0.5)
    assert h == 1080
    assert w == 606  # 1080 * 9/16 = 607.5 -> chẵn hoá xuống 606
    assert y == 0
    assert x == (1920 - 606) // 2


def test_crop_respects_face_position():
    _, _, left, _ = _crop_rect(1920, 1080, 0.2)
    _, _, right, _ = _crop_rect(1920, 1080, 0.8)
    assert left < right


def test_crop_never_exceeds_frame():
    crop_w, _, x, _ = _crop_rect(1920, 1080, 0.0)
    assert x == 0
    crop_w, _, x, _ = _crop_rect(1920, 1080, 1.0)
    assert x + crop_w <= 1920


def test_crop_vertical_source_trims_height():
    # Nguồn đã dọc hơn 9:16 (ví dụ 1:2): cắt bớt chiều cao thay vì chiều ngang.
    w, h, x, y = _crop_rect(1000, 2000, 0.5)
    assert w == 1000
    assert x == 0
    assert h == 1776  # 1000 * 16/9 = 1777.8 -> chẵn hoá xuống
    assert y > 0


def test_dimensions_are_even():
    # H.264 từ chối kích thước lẻ.
    for width, height in ((1920, 1081), (1279, 719), (641, 361)):
        w, h, _, _ = _crop_rect(width, height, 0.5)
        assert w % 2 == 0 and h % 2 == 0


def test_even_has_floor_of_two():
    assert _even(1) == 2
    assert _even(0) == 2
    assert _even(7) == 6


def test_filter_path_escaping():
    # ffmpeg coi ':' là dấu phân tách tham số filter.
    escaped = _escape_filter_path(Path("/tmp/a b/subs.ass"))
    assert ":" not in escaped or "\\:" in escaped
    assert _escape_filter_path(Path("/x/y:z.ass")) == "/x/y\\:z.ass"


def test_safe_name_strips_unsafe_characters():
    assert _safe_name(3, 'Anh ta nói: "quá sốc"!') == "03-anh-ta-noi-qua-soc"
    assert _safe_name(0, "!!!") == "00-clip"


def test_safe_name_keeps_vietnamese_readable():
    # Lọc thẳng ký tự sẽ biến mỗi chữ có dấu thành một gạch ngang và tên file
    # thành rác. Phải bỏ dấu trước, kể cả 'đ' (NFKD không tách được chữ này).
    assert _safe_name(1, "Bí quyết vượt qua sự trì trệ") == "01-bi-quyet-vuot-qua-su-tri-tre"
    assert _safe_name(2, "Đừng đợi hoàn hảo") == "02-dung-doi-hoan-hao"


def test_watermark_filter_sits_below_captions():
    # Phụ đề đặt ở 18% chiều cao tính từ đáy (captions.py). Watermark phải nằm
    # THẤP hơn thế, nếu không nó đè lên chữ ở mọi clip.
    f = _watermark_filter("opencmo.io", 1920)
    offset = int(f.split("y=h-")[1])
    assert offset < int(1920 * 0.18)


def test_watermark_text_is_sanitised_not_escaped():
    # Dấu nháy đơn không escape được khi nằm trong cặp nháy đơn của filtergraph,
    # và ':' thì tách tham số của drawtext. Cả hai phải biến mất khỏi chuỗi.
    f = _watermark_filter("a'b:c%d,e", 1920)
    label = f.split(":text='")[1].split("'")[0]
    assert label == "abcde"


def test_watermark_empty_after_cleaning_yields_no_filter():
    # Chuỗi toàn ký tự lạ mà vẫn dựng filter thì drawtext lỗi "no text".
    assert _watermark_filter(":::", 1920) == ""


def test_auto_layout_fills_when_a_face_was_tracked():
    assert resolve_layout("auto", tracked=True) == "fill"


def test_auto_layout_fits_when_no_face_was_found():
    """Screencast: không có mặt thì cắt 9:16 rơi vào vùng editor trống.

    Đây là ca thật đã ghi ở `note.md` mục "Còn lại" #2 — clip ra file bình
    thường, mở lên vẫn chạy, mà nội dung không dùng được.
    """
    assert resolve_layout("auto", tracked=False) == "fit"


def test_explicit_layout_is_never_overridden():
    # Người dùng đã trả lời câu hỏi "cắt hay đệm" thì bám mặt không được cãi.
    for tracked in (True, False):
        assert resolve_layout("fill", tracked=tracked) == "fill"
        assert resolve_layout("fit", tracked=tracked) == "fit"
        assert resolve_layout("manual", tracked=tracked) == "manual"


def test_config_derives_clip_size_from_aspect():
    assert (Config(aspect="9:16").clip_width, Config(aspect="9:16").clip_height) == (1080, 1920)
    assert (Config(aspect="1:1").clip_width, Config(aspect="1:1").clip_height) == (1080, 1080)
    assert (Config(aspect="16:9").clip_width, Config(aspect="16:9").clip_height) == (1920, 1080)


def test_config_keeps_an_explicit_clip_size():
    # Đường CLI và test cũ đặt kích thước tường minh; aspect không được cướp nó.
    cfg = Config(clip_width=720, clip_height=1280)
    assert (cfg.clip_width, cfg.clip_height) == (720, 1280)


def test_config_rejects_unknown_output_options():
    for bad in ({"aspect": "4:3"}, {"layout": "stretch"}):
        with pytest.raises(ValueError):
            Config(**bad)


def _filters_for(cfg, *, tracked, monkeypatch, tmp_path):
    """Chạy `render_clip` với ffmpeg giả, trả về chuỗi filter nó dựng.

    Dựng filter là chỗ quyết định clip trông ra sao, và nó kiểm được mà không
    cần encode gì — nhưng nó KHÔNG thay cho việc mở clip thật ra xem
    (`CLAUDE.md` mục "Kiểm chứng").
    """
    calls = []
    monkeypatch.setattr(render, "run", lambda args, **kw: calls.append(args))
    monkeypatch.setattr(render, "probe_file", lambda path: SimpleNamespace(width=1920, height=1080, duration=30.0))
    monkeypatch.setattr(render, "plan_crop", lambda *a, **kw: CropPlan(x_center=0.5, tracked=tracked))
    monkeypatch.setattr(render, "build_ass", lambda *a, **kw: tmp_path / "subs.ass")

    cfg.make_preview = False
    render.render_clip(
        section_path=tmp_path / "section.mp4",
        lead_in=0.0,
        moment=Moment(0.0, 10.0, "hook"),
        index=0,
        transcript=Transcript([]),
        cfg=cfg,
        encoder=Encoder("libx264", False),
        out_dir=tmp_path,
        work_dir=tmp_path,
    )
    return calls[0][calls[0].index("-vf") + 1].split(",")


def test_screencast_without_faces_is_padded_not_cropped(monkeypatch, tmp_path):
    filters = _filters_for(Config(out_dir=tmp_path), tracked=False, monkeypatch=monkeypatch, tmp_path=tmp_path)
    assert any(f.startswith("pad=1080:1920") for f in filters)
    assert not any(f.startswith("crop=") for f in filters)


def test_talking_head_is_cropped_around_the_speaker(monkeypatch, tmp_path):
    filters = _filters_for(Config(out_dir=tmp_path), tracked=True, monkeypatch=monkeypatch, tmp_path=tmp_path)
    assert any(f.startswith("crop=") for f in filters)
    assert not any(f.startswith("pad=") for f in filters)


def test_square_output_scales_to_the_chosen_size(monkeypatch, tmp_path):
    cfg = Config(out_dir=tmp_path, aspect="1:1")
    filters = _filters_for(cfg, tracked=True, monkeypatch=monkeypatch, tmp_path=tmp_path)
    assert "scale=1080:1080" in filters


def test_captions_off_leaves_no_subtitle_filter(monkeypatch, tmp_path):
    # Tiêu đề đi CHUNG file .ass với phụ đề, nên "không phụ đề" chỉ còn nghĩa là
    # không có filter `subtitles=` khi tắt cả hai.
    cfg = Config(out_dir=tmp_path, captions=False, headline=False)
    filters = _filters_for(cfg, tracked=True, monkeypatch=monkeypatch, tmp_path=tmp_path)
    assert not any(f.startswith("subtitles=") for f in filters)


def test_headline_alone_still_needs_the_subtitle_filter(monkeypatch, tmp_path):
    """Tắt phụ đề nhưng vẫn muốn tiêu đề: file .ass vẫn phải được burn.

    Trước đây khối .ass chỉ chạy `if cfg.captions`, nên bật tiêu đề mà tắt phụ
    đề sẽ ra clip KHÔNG có chữ nào — im lặng, đúng kiểu lỗi đắt nhất.
    """
    cfg = Config(out_dir=tmp_path, captions=False, headline=True)
    filters = _filters_for(cfg, tracked=True, monkeypatch=monkeypatch, tmp_path=tmp_path)
    assert any(f.startswith("subtitles=") for f in filters)


def test_captions_on_burns_subtitles(monkeypatch, tmp_path):
    filters = _filters_for(Config(out_dir=tmp_path), tracked=True, monkeypatch=monkeypatch, tmp_path=tmp_path)
    assert any(f.startswith("subtitles=") for f in filters)


def test_caption_style_reaches_build_ass(monkeypatch, tmp_path):
    """Kiểu phụ đề đốt duy nhất phải đi tới `build_ass`."""
    seen = {}
    monkeypatch.setattr(render, "run", lambda args, **kw: None)
    monkeypatch.setattr(render, "probe_file", lambda path: SimpleNamespace(width=1920, height=1080, duration=30.0))
    monkeypatch.setattr(render, "plan_crop", lambda *a, **kw: CropPlan(x_center=0.5, tracked=True))

    def fake_build_ass(segments, out_path, **kwargs):
        seen.update(kwargs)
        return out_path

    monkeypatch.setattr(render, "build_ass", fake_build_ass)
    cfg = Config(out_dir=tmp_path, make_preview=False)
    render.render_clip(
        section_path=tmp_path / "section.mp4", lead_in=0.0, moment=Moment(0.0, 10.0, "hook"),
        index=0, transcript=Transcript([]), cfg=cfg, encoder=Encoder("libx264", False),
        out_dir=tmp_path, work_dir=tmp_path,
    )
    preset = CAPTION_STYLE
    assert seen["font_ratio"] == preset.font_ratio
    assert seen["boxed"] is preset.boxed
    assert seen["highlight"] == preset.highlight


def _headline_layers(cfg, *, hook, monkeypatch, tmp_path):
    """Lớp chữ mà `render_clip` thật sự burn vào file, đọc từ `build_ass`."""
    seen = {}
    monkeypatch.setattr(render, "run", lambda args, **kw: None)
    monkeypatch.setattr(render, "probe_file", lambda path: SimpleNamespace(width=1920, height=1080, duration=30.0))
    monkeypatch.setattr(render, "plan_crop", lambda *a, **kw: CropPlan(x_center=0.5, tracked=True))

    def fake_build_ass(segments, out_path, **kwargs):
        seen.update(kwargs)
        return out_path

    monkeypatch.setattr(render, "build_ass", fake_build_ass)
    cfg.make_preview = False
    render.render_clip(
        section_path=tmp_path / "section.mp4", lead_in=0.0, moment=Moment(12.0, 34.0, hook),
        index=0, transcript=Transcript([]), cfg=cfg, encoder=Encoder("libx264", False),
        out_dir=tmp_path, work_dir=tmp_path,
    )
    # Không gọi `build_ass` thì không có chữ nào — trả về đúng "rỗng" cho ca đó.
    return list(seen.get("texts", []))


def test_burned_headline_matches_the_first_revision(monkeypatch, tmp_path):
    """Chữ trong file giao khách phải TRÙNG chữ trong revision đầu tiên.

    Đây là ca duy nhất bắt được lệch giữa hai đường đi qua `clip_headline`:
    `steps/render.py` burn vào mp4, `default_settings` ghi vào `clips.settings`.
    Lệch nhau thì mở editor ra thấy khung khác clip vừa tải về, và người dùng
    không có cách nào biết bên nào đúng.
    """
    hook = "Ba câu hỏi khiến nhà đầu tư gật đầu"
    cfg = Config(out_dir=tmp_path)
    burned = _headline_layers(cfg, hook=hook, monkeypatch=monkeypatch, tmp_path=tmp_path)

    saved = default_settings(12.0, 34.0, hook=hook).texts
    assert [t._asdict() for t in burned] == [dict(t) for t in saved]
    assert burned, "hook có chữ thì phải ra được một lớp chữ"


def test_no_headline_silences_both_paths(monkeypatch, tmp_path):
    """`--no-headline`: file không có chữ tiêu đề, và revision cũng không.

    Bên render tắt bằng `cfg.headline`; bên revision tắt bằng cách KHÔNG truyền
    `hook`. Hai cần gạt khác nhau cho cùng một quyết định, nên phải có ca kiểm
    chúng cùng im lặng.
    """
    cfg = Config(out_dir=tmp_path, captions=False, headline=False)
    burned = _headline_layers(cfg, hook="Một tiêu đề", monkeypatch=monkeypatch, tmp_path=tmp_path)
    assert burned == []
    assert default_settings(12.0, 34.0, hook="").texts == ()


def test_empty_hook_leaves_no_text_layer(monkeypatch, tmp_path):
    """Hook rỗng không được đẻ ra một lớp chữ trắng che mặt người nói."""
    cfg = Config(out_dir=tmp_path)
    burned = _headline_layers(cfg, hook="   ", monkeypatch=monkeypatch, tmp_path=tmp_path)
    assert burned == []
    assert default_settings(12.0, 34.0, hook="   ").texts == ()
