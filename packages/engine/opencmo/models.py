"""Kiểu dữ liệu dùng chung trong pipeline.

Cố ý dùng dataclass thuần thay vì pydantic ở tầng lõi: nhẹ, dễ serialize,
và không ràng buộc engine vào một framework nào.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal


@dataclass
class Word:
    """Một từ kèm mốc thời gian, dùng để nhấn từng từ trên phụ đề."""

    start: float
    end: float
    text: str


@dataclass
class TranscriptSegment:
    start: float
    end: float
    text: str
    # Mốc từng từ. None nghĩa là nguồn không cho biết — phụ đề khi đó rơi về
    # cách cũ (một dòng cho cả câu). Để tuỳ chọn chứ không bắt buộc là điều kiện
    # để mọi nguồn transcript cũ vẫn chạy nguyên như trước.
    words: list[Word] | None = None


@dataclass
class Transcript:
    segments: list[TranscriptSegment]
    language: str = "en"
    # The source decides the cost: 'subs' is free, speech-to-text is paid. 'whisper' marks
    # transcripts saved before the switch to ElevenLabs Scribe.
    source: Literal["subs", "scribe", "whisper"] = "scribe"

    @property
    def full_text(self) -> str:
        return " ".join(s.text for s in self.segments)

    def slice(self, start: float, end: float) -> list[TranscriptSegment]:
        """Các segment giao với khoảng [start, end], thời gian đã dời về gốc 0."""
        out = []
        for s in self.segments:
            if s.end <= start or s.start >= end:
                continue
            # Mốc từng từ phải dời gốc GIỐNG segment, nếu không phần nhấn sẽ lệch
            # đúng bằng `start`. Từ nằm ngoài cửa sổ bị loại luôn.
            words: list[Word] | None = None
            if s.words:
                words = [
                    Word(
                        start=max(0.0, w.start - start),
                        end=min(end - start, w.end - start),
                        text=w.text,
                    )
                    for w in s.words
                    if w.end > start and w.start < end
                ] or None
            out.append(
                TranscriptSegment(
                    start=max(0.0, s.start - start),
                    end=min(end - start, s.end - start),
                    text=s.text,
                    words=words,
                )
            )
        return out


@dataclass
class Moment:
    """Một khoảnh khắc do LLM chọn ra từ transcript."""

    start: float
    end: float
    hook: str
    score: float = 0.0
    reason: str = ""

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass
class Clip:
    index: int
    moment: Moment
    path: str
    preview_path: str | None = None
    width: int = 1080
    height: int = 1920
    # Khung ĐÃ DÙNG để render clip này, không phải khung người dùng yêu cầu:
    # `layout="auto"` chỉ giải được sau khi bám mặt chạy, và revision đầu tiên
    # của editor phải mở ra đúng thứ người dùng vừa tải về.
    layout: str = "fill"
    focus_x: float = 0.5


@dataclass
class SourceInfo:
    """Metadata lấy từ bước probe, trước khi tải bất cứ thứ gì."""

    url: str
    title: str
    duration: float
    uploader: str = ""
    has_subtitles: bool = False
    extractor: str = ""


@dataclass
class Timings:
    """Đo từng bước. Dùng để kiểm chứng ngân sách < 3 phút ở ARCHITECTURE.md §2."""

    probe: float = 0.0
    transcript: float = 0.0
    select: float = 0.0
    download: float = 0.0
    render: float = 0.0

    @property
    def total(self) -> float:
        return self.probe + self.transcript + self.select + self.download + self.render


@dataclass
class JobResult:
    source: SourceInfo
    clips: list[Clip] = field(default_factory=list)
    timings: Timings = field(default_factory=Timings)
    transcript_source: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
