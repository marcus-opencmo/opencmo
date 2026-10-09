"""Kiểm tra độ phủ lời nói; heuristic, không thay thế nhận diện nhạc."""

from __future__ import annotations

from .models import Moment, Transcript


def _overlap(a: tuple[float, float], b: tuple[float, float]) -> float:
    return max(0.0, min(a[1], b[1]) - max(a[0], b[0]))


def speech_coverage(
    transcript: Transcript, duration: float, windows: list[tuple[float, float]] | None = None
) -> tuple[float, float, int]:
    """Trả về (số giây có lời nói, số giây được xét, số ký tự chữ-số).

    `windows` khoanh phần video ĐANG được xét. Nhánh manual chỉ cắt vài đoạn đã
    chọn, nên chia độ phủ cho cả thời lượng video là sai hiển nhiên: 40 giây lời
    nói trong một video 54 phút ra tỉ lệ 0,012 và trượt mọi ngưỡng bên dưới, dù
    đoạn được chọn kín tiếng nói từ đầu tới cuối.
    """
    scope = [(max(0.0, s), min(duration, e)) for s, e in (windows or [(0.0, duration)])]
    scope = [w for w in scope if w[1] > w[0]]
    considered = sum(e - s for s, e in scope)

    intervals = sorted(
        (max(0.0, s.start), min(duration, s.end))
        for s in transcript.segments
        if s.text.strip() and s.end > s.start
    )
    coverage, last_end = 0.0, 0.0
    for start, end in intervals:
        # Cắt phần đã tính của segment trước để không cộng trùng khi các segment
        # chồng lấn nhau (phụ đề cuộn của YouTube hay như vậy).
        span = (max(start, last_end), end)
        if span[1] <= span[0]:
            continue
        last_end = end
        coverage += sum(_overlap(span, w) for w in scope)

    characters = sum(
        c.isalnum()
        for s in transcript.segments
        if any(_overlap((s.start, s.end), w) > 0 for w in scope)
        for c in s.text
    )
    return coverage, considered, characters


def transcript_has_enough_speech(
    transcript: Transcript, duration: float, windows: list[tuple[float, float]] | None = None
) -> bool:
    coverage, considered, characters = speech_coverage(transcript, duration, windows)
    return not (
        considered <= 0
        or coverage < min(5, considered * 0.2)
        or (coverage / considered < 0.08 or characters / considered < 0.3)
    )


def fallback_moments(
    duration: float,
    count: int,
    min_seconds: float,
    max_seconds: float,
) -> list[Moment]:
    """Chọn các cửa sổ phân bố đều khi video không có đủ lời nói.

    Music video, montage, gameplay hay silent footage không có transcript để LLM
    xếp hạng. Từ chối chúng là sai; fallback này tạo output chắc chắn,
    không chồng lấn, để người dùng tinh chỉnh tiếp trong editor.
    """
    if duration < 1:
        raise ValueError("This video is too short to create a clip.")
    safe_min = max(1.0, min_seconds)
    total = max(1, min(count, int(duration // safe_min) or 1))
    slot = duration / total
    length = min(max_seconds, max(min(safe_min, duration), min(30.0, slot)))
    moments: list[Moment] = []
    for index in range(total):
        start = index * slot + max(0.0, (slot - length) / 2)
        end = min(duration, start + length)
        moments.append(
            Moment(
                start=start,
                end=end,
                hook=f"Video highlight {index + 1}",
                score=max(1.0, 50.0 - index),
                reason="Selected across the video because it has little or no spoken dialogue.",
            )
        )
    return moments
