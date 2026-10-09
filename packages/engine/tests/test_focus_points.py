"""Tâm khung động của editor (R4): Python là bản duy nhất.

Fixture sinh từ bản TypeScript cũ trước khi gỡ; mọi project sinh ra sau R4 phải
có đúng dãy mốc như trước, nếu không người nói nhảy chỗ trong project mới.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from opencmo.steps.reframe import MAX_KEYFRAMES, crop_window, focus_at, focus_points

FIXTURE = Path(__file__).resolve().parents[3] / "tests" / "contracts" / "reframe" / "focus-points.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_focus_points_khop_ban_typescript_cu(case):
    got = focus_points(
        [tuple(sample) for sample in case["track"]],
        case["window"],
        case["offset"],
        case["source_in"],
        case["source_out"],
    )
    assert len(got) == len(case["expected"])
    for (time, focus), (want_time, want_focus) in zip(got, case["expected"], strict=True):
        assert time == pytest.approx(want_time, abs=1e-9)
        assert focus == pytest.approx(want_focus, abs=1e-6)


def test_doi_canh_cat_dung_luoi_frame():
    """Người nói đổi chỗ ở giây 22 gốc (14 của master): hai mốc sát nhau, giữ tâm
    cũ tới frame ngay trước — không lia qua nền trống."""
    walking = [(8 + i * 0.25, 0.3 if 8 + i * 0.25 < 22 else 0.75, 0.05) for i in range(137)]
    points = focus_points(walking, 9 / 16 / (16 / 9), 8, 2, 32)
    times = [time for time, _ in points]
    assert times[0] == 2
    at = times.index(14)
    assert times[at - 1] == pytest.approx(13.967)
    assert points[at - 1][1] == points[0][1]


def test_khong_track_hoac_tinh_thi_rong():
    assert focus_points([], 0.3, 0, 0, 30) == []
    still = [(t / 4, 0.6, 0.05) for t in range(160)]
    assert focus_points(still, 0.316, 0, 0, 30) == []


def test_san_khau_rong_giu_nguoi_noi_khong_dem_mau():
    """Steve Jobs @ Stanford (job thật 30/09): người nói 0.45 mặt nhỏ, hàng đầu
    0.31 mặt to, đám đông xa 0.81 mặt tí hon nhưng detect nhiều lần hơn. Cộng
    DIỆN TÍCH thì tâm nằm giữa hai người và CẢ HỘP mặt người nói trong khung."""
    stage = []
    for i in range(137):
        t = 8 + i * 0.25
        k = round(t * 4) % 5
        stage.append((t, 0.45, 0.03) if k == 0 else (t, 0.31, 0.1) if k == 1 else (t, 0.81, 0.019))
    window = crop_window(1440 / 1080)
    center = focus_at(stage, 8, 42, window)
    assert 0.3 < center < 0.5, center
    assert 0.45 + 0.03**0.5 / 2 <= center + window / 2


def test_tran_40_moc_ca_khi_doi_cho_lien_tuc():
    busy = [(i * 0.25, 0.25 if (i * 0.25) % 2 < 1 else 0.8, 0.05) for i in range(801)]
    assert len(focus_points(busy, crop_window(16 / 9), 0, 0, 180)) <= MAX_KEYFRAMES
