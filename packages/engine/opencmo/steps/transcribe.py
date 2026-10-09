"""Transcript qua Groq Whisper.

Vì sao gọi API thay vì chạy Whisper local ở giai đoạn này:
    Groq `whisper-large-v3-turbo` xử lý 45 phút audio trong ~20 giây với chi phí
    ~$0.03. Whisper local trên CPU mất 2–5 phút, ăn 1–10GB RAM tùy model, và
    tranh CPU với ffmpeg. Với một người code ban đêm sau giờ làm, việc không
    phải debug CUDA/Vulkan đáng giá hơn 3 cent.

Whisper local là tính năng của giai đoạn sau, bán dưới tên "Privacy mode".
"""

from __future__ import annotations

import logging
from pathlib import Path

import httpx

from ..config import Config
from ..models import Transcript, TranscriptSegment, Word
from ..wordmatch import keep_alignable

log = logging.getLogger(__name__)

_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions"
_TIMEOUT = httpx.Timeout(300.0, connect=15.0)
# Groq trả 413 từ 25MB; chặn sớm hơn một chút để không tốn một lượt upload vô ích.
GROQ_MAX_BYTES = 24 * 1024 * 1024


def _attach_words(segments: list[TranscriptSegment], payload: dict) -> None:
    """Gắn mốc từng từ vào đúng segment chứa nó.

    Nhận CẢ HAI hình dạng payload: `words` ở cấp cao nhất (Groq trả kiểu này —
    đã kiểm bằng lệnh gọi thật) hoặc lồng trong từng segment. Đỡ cả hai vì đoán
    sai thì phụ đề âm thầm mất phần nhấn chứ không báo lỗi.

    Ghép hai bước, cố ý KHÔNG dùng con trỏ chạy chung:

    1. Lọc thô theo thời gian — từ nào chồng lấn khoảng của segment thì là ứng viên.
    2. Lọc tinh theo chữ — bỏ những ứng viên không định vị được trong câu.

    Vì sao không dùng một con trỏ duy nhất chạy suốt danh sách từ: chữ mức câu và
    chữ mức từ của Whisper đến từ hai lượt giải mã khác nhau nên không trùng
    (`he` vs `he's`). Một con trỏ chung sẽ lệch pha ở chỗ sai lệch đầu tiên rồi
    kẹt luôn — đo thật: 18/67 segment còn từ. Làm độc lập từng segment thì một
    chỗ lệch chỉ hỏng đúng chỗ đó.
    """
    if not segments:
        return

    flat: list[Word] = []
    raws = list(payload.get("words") or [])
    if not raws:
        for seg_raw in payload.get("segments") or []:
            raws.extend(seg_raw.get("words") or [])
    for raw in raws:
        text = str(raw.get("word", raw.get("text", ""))).strip()
        if not text:
            continue
        start = float(raw.get("start", 0.0))
        flat.append(Word(start=start, end=float(raw.get("end", start)), text=text))

    for seg in segments:
        cands = [w for w in flat if w.end > seg.start and w.start < seg.end]
        kept = keep_alignable(seg.text, [w.text for w in cands])
        # None chứ không phải [] — phân biệt "không có dữ liệu" với "có mà rỗng",
        # và đó là điều kiện để captions.py rơi về cách cũ.
        seg.words = [cands[i] for i in kept] or None


def transcribe_audio(audio_path: Path, cfg: Config) -> Transcript:
    cfg.validate_for_transcribe()

    size = audio_path.stat().st_size
    if size > GROQ_MAX_BYTES:
        # Tiền tố cố định: `worker/errors.py` ánh xạ nó ra câu cho người dùng.
        raise RuntimeError(f"Audio is too large to transcribe: {size} bytes.")

    with audio_path.open("rb") as fh:
        response = httpx.post(
            _ENDPOINT,
            headers={"Authorization": f"Bearer {cfg.groq_api_key}"},
            files={"file": (audio_path.name, fh, "audio/m4a")},
            data={
                "model": cfg.whisper_model,
                "response_format": "verbose_json",
                # Xin CẢ hai mức: mốc câu để định vị khoảnh khắc, mốc từ để nhấn
                # từng từ trên phụ đề. Groq không tính thêm tiền cho mức `word`,
                # nó cùng một lượt giải mã.
                "timestamp_granularities[]": ["segment", "word"],
            },
            timeout=_TIMEOUT,
        )

    if response.status_code != 200:
        raise RuntimeError(f"Groq returned {response.status_code}: {response.text[:300]}")

    payload = response.json()
    segments = [
        TranscriptSegment(
            start=float(s.get("start", 0.0)),
            end=float(s.get("end", 0.0)),
            text=str(s.get("text", "")).strip(),
        )
        for s in payload.get("segments", [])
        if str(s.get("text", "")).strip()
    ]
    _attach_words(segments, payload)

    # Nhạc không lời, montage và footage im lặng có thể trả về 0 đoạn.
    # Đó là kết quả hợp lệ: pipeline sẽ chọn cửa sổ fallback và render
    # không phụ đề, thay vì biến "không có lời" thành lỗi hệ thống.
    log.info("Đã transcribe: %d đoạn", len(segments))
    return Transcript(
        segments=segments,
        language=payload.get("language", "en"),
        source="whisper",
    )
