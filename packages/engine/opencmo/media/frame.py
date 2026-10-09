"""Hình học khung đầu ra: kích thước, khung cắt, chuỗi filter, preset phụ đề.

Tách ra khỏi cả hai đường render vì cả hai cần đúng những con số này:

  * `steps/render.py`   — clip do pipeline tạo lần đầu
  * `editing/render.py` — preview và export của một revision

Trước đây mỗi bên có bản riêng, và bản trong `steps/` thiếu một phép kẹp mà bản
trong `editing/` có. Hai công thức cắt khác nhau nghĩa là bản người dùng xem
trong editor lệch bản họ vừa tải về — đúng loại lỗi im lặng mà `CLAUDE.md` mục
"Kiểm chứng" nói tới. Một nguồn sự thật thì không lệch được.

Đặt ở `media/` chứ không ở `steps/`: `editing/` đã import `steps/render`, nên
để ở đó là vòng import.
"""

from __future__ import annotations

from dataclasses import dataclass

ASPECT_SIZES = {"9:16": (1080, 1920), "1:1": (1080, 1080), "16:9": (1920, 1080)}


def even(value: float) -> int:
    """H.264 yêu cầu kích thước chẵn."""
    return max(2, int(value) // 2 * 2)


@dataclass(frozen=True)
class CaptionPreset:
    font_ratio: float
    bold: bool
    outline_ratio: float
    boxed: bool
    highlight: str | None
    margin_v_ratio: float


# Kiểu phụ đề DUY NHẤT mà pipeline đốt vào clip giao khách (R4: form clipping chỉ
# còn bật/tắt). Đổi kiểu làm trong editor, bằng bộ preset của editor; bộ sinh
# project chọn preset editor khớp kiểu này (`spotlight` + coral).
CAPTION_STYLE = CaptionPreset(0.045, True, 1 / 12, False, "&H3AFFE1&", 0.18)


def crop_rect(
    src_w: int, src_h: int, target_aspect: float, x_center: float
) -> tuple[int, int, int, int]:
    """Khung cắt lớn nhất theo tỉ lệ đích, đặt quanh `x_center` (0–1)."""
    if src_w / src_h > target_aspect:
        # Nguồn rộng hơn khung đích (thường gặp: video ngang 16:9 ra 9:16).
        crop_w = even(src_h * target_aspect)
        crop_h = even(src_h)
        x = round(x_center * src_w - crop_w / 2)
        x = max(0, min(src_w - crop_w, x))
        y = 0
    else:
        # Nguồn đã hẹp hơn khung đích — cắt bớt chiều cao, giữ nguyên bề ngang.
        # `min` là bắt buộc: nguồn dọc hơn đích cho ra chiều cao lớn hơn chính
        # nó, và ffmpeg từ chối khung cắt tràn ra ngoài ảnh.
        crop_w = even(src_w)
        crop_h = min(even(src_w / target_aspect), even(src_h))
        x = 0
        y = max(0, (src_h - crop_h) // 2)
    return crop_w, crop_h, x, y


def frame_filters(
    *,
    src_w: int,
    src_h: int,
    layout: str,
    out_w: int,
    out_h: int,
    x_center: float,
) -> list[str]:
    """Chuỗi filter đưa khung nguồn về đúng khung đầu ra.

    `fit` giữ trọn khung nguồn (screencast, slide, bảng trình chiếu): thu nhỏ vừa
    khung rồi đệm đen. `fill`/`manual` cắt quanh `x_center`.
    """
    if layout == "fit":
        return [
            f"scale={out_w}:{out_h}:force_original_aspect_ratio=decrease:force_divisible_by=2",
            f"pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:black",
            "setsar=1",
        ]
    w, h, x, y = crop_rect(src_w, src_h, out_w / out_h, x_center)
    return [f"crop={w}:{h}:{x}:{y}", f"scale={out_w}:{out_h}", "setsar=1"]


def resolve_layout(layout: str, *, tracked: bool) -> str:
    """Giải `layout="auto"` thành `fill` hay `fit` sau khi bám mặt đã chạy.

    Không dò được mặt nào thì cắt là sai: nguồn screencast bị crop 9:16 sẽ ra
    khung toàn vùng editor trống, và clip đó không đăng được. Thu nhỏ trọn khung
    rồi đệm đen giữ được toàn bộ nội dung — xấu hơn một chút, nhưng dùng được.

    `fill`/`fit`/`manual` do người dùng chọn tường minh thì giữ nguyên: họ đã
    trả lời câu hỏi này rồi.
    """
    if layout != "auto":
        return layout
    return "fill" if tracked else "fit"
