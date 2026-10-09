"""File .srt và .txt đi kèm một bản export.

Cùng nguồn với phụ đề burn vào video: cùng transcript, cùng phần sửa chữ, cùng
đoạn trim, cùng cách chia cụm (`steps.captions.caption_cues`). Người dùng tắt
phụ đề trên video vẫn nhận được .srt để nền tảng tự hiển thị — nên hai file này
được ghi theo revision, không theo việc `captions` bật hay tắt.

Mốc thời gian tính từ giây 0 của CLIP, vì đó là thứ khớp với file mp4 tải về.
"""

from __future__ import annotations

import json

from ..models import TranscriptSegment
from ..steps.captions import caption_cues


def _timestamp(seconds: float) -> str:
    """SRT dùng HH:MM:SS,mmm — dấu phẩy, ba chữ số mili giây."""
    seconds = max(0.0, seconds)
    hours, rem = divmod(int(seconds), 3600)
    minutes, secs = divmod(rem, 60)
    millis = round((seconds - int(seconds)) * 1000)
    if millis == 1000:  # làm tròn lên tràn sang giây
        millis = 0
        secs += 1
        if secs == 60:
            secs = 0
            minutes += 1
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def to_srt(segments: list[TranscriptSegment]) -> str:
    """Phụ đề .srt của clip. Cue rỗng hoặc dài 0 giây bị bỏ — trình phát khác
    nhau xử lý chúng mỗi kiểu, và chúng không hiện trên video."""
    blocks = []
    for start, end, text in caption_cues(segments):
        begin, stop = _timestamp(start), _timestamp(end)
        if begin == stop:
            continue
        blocks.append(f"{len(blocks) + 1}\n{begin} --> {stop}\n{text}\n")
    return "\n".join(blocks)


def to_txt(segments: list[TranscriptSegment]) -> str:
    """Bản chữ của clip, mỗi câu một dòng — để dán vào caption bài đăng.

    Theo segment chứ không theo cụm 5 từ: đây là văn bản để đọc, không phải
    thứ chạy theo video.
    """
    # slice giữ nguyên segment.text nhưng đã cắt danh sách từ theo đoạn trim.
    lines = [
        " ".join(word.text for word in segment.words).strip()
        if segment.words is not None else segment.text.strip()
        for segment in segments
    ]
    lines = [line for line in lines if line]
    return "\n".join(lines) + ("\n" if lines else "")


def to_ds_transcript(segments: list[TranscriptSegment]) -> str:
    """Transcript ở hình dạng NATIVE của Diffusion Studio, cho `<captions src>`.

    `[{text, words: [{text, start, end}]}]`, mốc tính bằng GIÂY và gốc 0 là giây
    0 của FILE mà editor mở (`master.mp4`) — cùng thang với `sourceIn` trong TSX.

    Vì sao không dùng `.srt`: parser SRT của DS bịa mốc từng từ theo độ dài ký
    tự, vì cue SRT không mang word timing. Preset cho video dọc hiện TỪNG TỪ,
    nên chỗ bịa đó lệch nhìn thấy được. Ta có word timing thật, và
    `resolveTranscript` nhận `.json` thẳng, không qua parser.

    KHÔNG đi qua `caption_cues`: gộp cụm là việc của DS, nó có bố cục riêng.
    """
    out = []
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        words = [
            {"text": word.text, "start": round(max(0.0, word.start), 3),
             "end": round(max(0.0, word.end), 3)}
            for word in (segment.words or [])
            if word.text.strip()
        ]
        # Không có word timing thì dựng MỘT "từ" trải hết câu. Rải đều theo ký
        # tự là chính cái bẫy của parser SRT mà ta đang tránh — một khối chữ
        # hiện trọn câu thì thà thế còn hơn nhấn sai từ.
        out.append({
            "text": text,
            "words": words or [
                {"text": text,
                 "start": round(max(0.0, segment.start), 3),
                 "end": round(max(0.0, segment.end), 3)}
            ],
        })
    return json.dumps(out, ensure_ascii=False)
