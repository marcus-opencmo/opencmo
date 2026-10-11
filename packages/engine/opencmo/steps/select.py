"""Picks the moments worth cutting from a transcript, with Claude.

A 45-minute transcript is ~12k input tokens: Claude Haiku costs ~$0.02 per video. Structured
output binds the model to the Pydantic schema, so no code has to defend against a wrong format.
"""

from __future__ import annotations

import logging

from pydantic import BaseModel, Field

from ..config import Config
from ..models import Moment, Transcript

log = logging.getLogger(__name__)


class _MomentOut(BaseModel):
    start_seconds: float = Field(description="Giây bắt đầu trong video gốc")
    end_seconds: float = Field(description="Giây kết thúc trong video gốc")
    # "in English" nằm ngay trong mô tả trường chứ không chỉ ở _SYSTEM: model đọc
    # mô tả này đúng lúc sinh ra giá trị, và prompt tiếng Việt kéo nó về tiếng
    # Việt. Hai trường này hiện thẳng lên trang kết quả (ClipCard.tsx).
    hook: str = Field(description="Short, punchy title in English, under 60 characters")
    score: float = Field(description="Điểm tiềm năng lan truyền, 0 tới 99")
    reason: str = Field(description="One sentence in English on why this segment works")


class _Selection(BaseModel):
    moments: list[_MomentOut]


_SYSTEM = """Bạn là biên tập viên video dạng ngắn. Nhiệm vụ: đọc transcript có mốc \
thời gian của một video dài và chọn ra những đoạn đứng độc lập tốt nhất khi cắt \
thành clip dọc cho TikTok, Reels và YouTube Shorts.

Chấm mỗi đoạn trên bốn trục, rồi gộp thành một điểm duy nhất thang 0 tới 99:
- Hook — mở đầu có giữ được người xem và có dính thẳng vào chủ đề chính không?
- Flow — có mạch từ phần này sang phần kia, và có câu chốt thoả đáng không?
- Value — có giá trị, có chạm cảm xúc, có tạo kết nối cá nhân với người xem không?
- Trend — có ăn nhập với xu hướng và mối quan tâm hiện tại của khán giả không?

Thang 0–99 là để **so sánh tương đối giữa các đoạn trong cùng một video**, \
nên hãy trải điểm ra. Dồn hết lên 90+ thì điểm mất tác dụng xếp hạng.

Ngoài bốn trục, một đoạn tốt còn phải chứa trọn một ý — hiểu được mà không cần \
xem phần trước — và kết thúc gọn, không cụt giữa câu.

Tránh: đoạn giới thiệu, lời chào, quảng cáo tài trợ, đoạn lan man, \
đoạn phải xem trước đó mới hiểu.

Mốc thời gian phải nằm trong độ dài video và không đè lên nhau.

`hook` và `reason` LUÔN viết bằng tiếng Anh, bất kể video nói tiếng gì — người \
dùng đọc chúng trong một giao diện tiếng Anh."""


_LLM_TIMEOUT_S = 120


def _select_with_anthropic(prompt: str, cfg: Config) -> _Selection:
    import anthropic

    client = anthropic.Anthropic(
        api_key=cfg.anthropic_api_key, timeout=_LLM_TIMEOUT_S, max_retries=2,
    )
    response = client.messages.parse(
        model=cfg.resolved_select_model,
        max_tokens=4096,
        system=_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
        output_format=_Selection,
    )
    return response.parsed_output


def select_moments(
    transcript: Transcript,
    cfg: Config,
    *,
    count: int = 5,
    source_duration: float = 0.0,
) -> list[Moment]:
    cfg.validate_for_select()

    lines = [f"[{s.start:.1f}-{s.end:.1f}] {s.text}" for s in transcript.segments]
    body = "\n".join(lines)

    prompt = (
        f"Transcript (độ dài video: {source_duration:.0f} giây):\n\n{body}\n\n"
        f"Chọn ra {count} đoạn hay nhất. Mỗi đoạn dài "
        f"{cfg.clip_min_seconds:.0f}–{cfg.clip_max_seconds:.0f} giây."
    )

    log.info("Selecting moments with %s", cfg.resolved_select_model)
    selection = _select_with_anthropic(prompt, cfg)

    moments: list[Moment] = []
    for item in selection.moments:
        start = max(0.0, item.start_seconds)
        end = item.end_seconds
        if source_duration:
            end = min(end, source_duration)

        duration = end - start
        if duration < cfg.clip_min_seconds:
            log.debug("Bỏ đoạn quá ngắn: %.1fs", duration)
            continue
        if duration > cfg.clip_max_seconds:
            end = start + cfg.clip_max_seconds

        moments.append(
            Moment(start=start, end=end, hook=item.hook.strip(), score=item.score, reason=item.reason)
        )

    moments.sort(key=lambda m: m.score, reverse=True)
    selected = moments[:count]
    selected.sort(key=lambda m: m.start)

    log.info("Đã chọn %d khoảnh khắc", len(selected))
    return selected
