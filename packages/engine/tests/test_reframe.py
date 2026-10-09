"""Bám mặt: chọn tâm cắt sao cho người nói THẬT SỰ nằm trong khung.

Các ca ở đây đều dựng lại từ triệu chứng thật: clip ra file bình thường, mở lên
xem được, nhưng chỉ thấy vai hoặc thấy phông nền. Không test nào ở đây chạm vào
MediaPipe — chúng kiểm phần tính toán sau khi đã có toạ độ mặt, vì đó là chỗ
bản cũ hỏng.
"""

from __future__ import annotations

import statistics
from pathlib import Path

import pytest

from opencmo.steps import reframe
from opencmo.steps.reframe import (
    Face,
    _choose_center,
    _count_covered,
    crop_window,
    face_track,
    focus_for_range,
    plan_crop,
)

W169 = crop_window(16 / 9)


# Bề rộng hộp mặt điển hình của một cận cảnh, đo trên các lần chạy thật:
# khoảng 10% bề ngang nguồn.
W_MAT = 0.10


def _day(mau: list[float], w: float = W_MAT) -> list[Face]:
    """Mỗi frame một mặt, cùng cỡ — dựng lại đúng dữ liệu bản cũ đã có."""
    return [Face(frame=i, x=x, w=w, area=w * w) for i, x in enumerate(mau)]


def _giu_duoc(faces: list[Face], center: float) -> int:
    return _count_covered(faces, center, W169)


def test_cua_so_916_chiem_mot_phan_ba_be_ngang_nguon_16_9():
    # Con số neo mọi thứ khác: lệch quá một nửa cửa sổ là ra ngoài khung.
    assert round(W169, 3) == 0.316
    # Nguồn 4:3 rộng tay hơn; nguồn đã dọc hơn 9:16 thì giữ nguyên bề ngang.
    assert round(crop_window(4 / 3), 3) == 0.422
    assert crop_window(9 / 16) == 1.0
    assert crop_window(0.5) == 1.0


def test_talking_head_van_ra_trung_vi():
    # Đường thường gặp nhất không được đổi hành vi: mọi mặt trong một cửa sổ
    # thì trung vị là vị trí cân đối nhất.
    mau = [0.70, 0.72, 0.71, 0.73, 0.72]
    assert _choose_center(_day(mau), W169) == statistics.median(mau)


def test_hai_nguoi_phong_van_khong_roi_vao_khoang_trong():
    """Ca hỏng nặng nhất — đúng triệu chứng "chỉ thấy cái vai".

    Hai người ngồi ở x=0.30 và x=0.70, cắt qua lại đều nhau. Trung vị ra 0.500,
    nằm giữa hai người và giữ được 0/100 frame: cả clip không có ai trong khung.
    """
    faces = _day([0.30 if i % 2 else 0.70 for i in range(100)])

    assert _giu_duoc(faces, statistics.median([f.x for f in faces])) == 0

    center = _choose_center(faces, W169)
    assert _giu_duoc(faces, center) == 50
    assert abs(center - 0.30) < 0.01 or abs(center - 0.70) < 0.01


def test_can_canh_thang_canh_rong_day_mat_nho():
    """Người nói cận cảnh ở 0.80, xen cảnh rộng có khán giả rải rác.

    Bản cũ giữ mặt lớn nhất mỗi frame rồi lấy trung vị → 0.550, giữ được 30%.
    Tính điểm theo diện tích mặt cộng dồn thì cận cảnh thắng: một đám mặt nhỏ
    không kéo nổi khung ra khỏi người đang nói.
    """
    faces = [Face(frame=i, x=0.80, w=0.12, area=0.05) for i in range(40)]
    for i in range(40, 100):
        for x in [0.1, 0.3, 0.5]:
            faces.append(Face(frame=i, x=x, w=0.03, area=0.002))

    center = _choose_center(faces, W169)
    assert abs(center - 0.80) < 0.01


def test_nhieu_mat_trong_mot_frame_chi_duoc_tinh_mot_lan():
    """Một frame đông người không được nặng cân hơn một frame một người.

    Không chặn thì một cảnh khán giả 20 mặt lấn át 20 frame có người nói.
    """
    dong = [Face(frame=0, x=0.2 + 0.01 * i, w=0.03, area=0.004) for i in range(20)]
    nguoi_noi = [Face(frame=i, x=0.85, w=0.10, area=0.02) for i in range(1, 6)]

    center = _choose_center(dong + nguoi_noi, W169)
    assert abs(center - 0.85) < 0.02


def test_khong_bao_gio_te_hon_trung_vi():
    """Bất biến của cả thay đổi này, đo trên mọi ca đã dựng."""
    cac_ca = [
        [0.72] * 60 + [0.34] * 40,
        [0.72] * 50 + [0.34] * 50,
        [0.72] * 45 + [0.34] * 55,
        [0.20] * 33 + [0.50] * 33 + [0.85] * 34,
        [0.25 + 0.60 * i / 99 for i in range(100)],
        [0.30 if i % 2 else 0.70 for i in range(100)],
        [0.80] * 40 + [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] * 10,
    ]
    for mau in cac_ca:
        faces = _day(mau)
        cu = _giu_duoc(faces, statistics.median(mau))
        moi = _giu_duoc(faces, _choose_center(faces, W169))
        assert moi >= cu, f"{mau[:3]}…: mới giữ {moi}, cũ giữ {cu}"


def test_dem_phu_kep_tam_ve_trong_le():
    """Mặt sát mép phải không bao giờ được đưa vào giữa khung.

    `_crop_rect` của render kẹp khung lại trong lề, nên không kẹp ở đây thì con
    số báo cáo đẹp hơn clip thật.
    """
    faces = _day([0.98] * 10)
    # Tâm bị kẹp về 1 - W/2 = 0.842. Hộp mặt rộng 0.10 nên mép phải của nó ở
    # 1.03 — nằm ngoài cả khung hình, không khung cắt nào giữ trọn được.
    assert _count_covered(faces, 0.98, W169) == 0
    # Lùi vào một chút thì giữ được.
    assert _count_covered(_day([0.88] * 10), 0.88, W169) == 10


def test_face_track_tang_dan_va_dung_lai_ket_qua_plan_crop(monkeypatch, tmp_path):
    frames = [tmp_path / f"f_{i:04d}.jpg" for i in range(5)]
    faces = [
        Face(frame=i, x=0.20 + i * 0.12, w=0.08, area=0.02)
        for i in range(len(frames))
    ]
    monkeypatch.setattr(reframe, "_extract_frames", lambda *args, **kwargs: frames)
    monkeypatch.setattr(reframe, "_detect_faces", lambda _frames: faces)

    track = face_track(Path("moving-face.mp4"), sample_fps=2, start=10, duration=2.5)

    assert [sample[0] for sample in track] == [10, 10.5, 11, 11.5, 12]
    assert [sample[1] for sample in track] == pytest.approx([0.20, 0.32, 0.44, 0.56, 0.68])
    plan = plan_crop(
        Path("moving-face.mp4"), sample_fps=2, start=10, duration=2.5
    )
    assert abs(focus_for_range(track, 10, 12.5) - plan.x_center) <= 0.01


def test_focus_for_range_loc_bang_bisect_va_fallback_giua():
    track = [
        (1.0, 0.2, 0.04),
        (2.0, 0.3, 0.04),
        (3.0, 0.8, 0.04),
        (4.0, 0.9, 0.04),
    ]

    assert focus_for_range(track, 2.5, 4.1) > 0.75
    assert focus_for_range(track, 5.0, 6.0) == 0.5


def test_focus_for_ranges_bo_qua_doan_da_cat(monkeypatch):
    """Cuts phải được tôn trọng: đoạn đã xoá không góp vào tâm cắt.

    Bẫy ở quyết định số 4, lần này do người dùng tạo ra: người A nói ở nửa đầu,
    người B ở nửa sau, người dùng cắt bỏ hẳn phần của B. Tính trên cả khoảng
    nguồn thì tâm rơi vào giữa hai người — chỗ không còn ai trong bản ghép.
    """
    track = [
        *[(1.0 + i * 0.25, 0.22, 0.01) for i in range(8)],
        *[(9.0 + i * 0.25, 0.86, 0.01) for i in range(8)],
    ]

    ca_khoang = reframe.focus_for_ranges(track, [(0.0, 12.0)])
    chi_cut_dau = reframe.focus_for_ranges(track, [(0.0, 4.0)])

    # Cả khoảng: hai cụm cách nhau hơn một cửa sổ crop nên tâm bị kéo về một
    # cụm — nhưng cut thật chỉ giữ cụm đầu, và kết quả phải bám đúng cụm đó.
    assert abs(chi_cut_dau - 0.22) <= 0.01
    assert reframe.focus_for_ranges(track, [(0.0, 4.0), (8.5, 12.0)]) == ca_khoang
    # Không mẫu nào trong cut → căn giữa, không đoán.
    assert reframe.focus_for_ranges(track, [(20.0, 30.0)]) == 0.5


def test_plan_crop_dung_lai_track_khong_lay_mau_lai(monkeypatch, tmp_path):
    """Truyền track vào thì không chạm tới MediaPipe lần nữa."""
    frames = [tmp_path / f"f_{i:04d}.jpg" for i in range(12)]
    faces = [Face(frame=i, x=0.70, w=W_MAT, area=W_MAT * W_MAT) for i in range(12)]
    monkeypatch.setattr(reframe, "_extract_frames", lambda *a, **k: frames)
    monkeypatch.setattr(reframe, "_detect_faces", lambda _frames: faces)

    # Lấy mẫu một lần trên cửa sổ RỘNG (có đệm), như worker web vẫn làm.
    track = face_track(Path("s.mp4"), sample_fps=2, start=0.0, duration=6.0)

    goi = []
    monkeypatch.setattr(
        reframe, "_extract_frames",
        lambda *a, **k: goi.append(a) or [],
    )
    plan = plan_crop(Path("s.mp4"), sample_fps=2, start=1.0, duration=3.0, track=track)

    assert goi == []                      # không trích frame lần hai
    assert plan.tracked is True
    assert abs(plan.x_center - 0.70) <= 0.01
    # Chỉ đếm frame nằm trong cửa sổ hẹp: 1.0→4.0 ở 2 fps là 7 frame.
    assert plan.frames == 7
    assert plan.samples == 7
