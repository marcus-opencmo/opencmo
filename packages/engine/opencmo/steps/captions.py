"""Sinh file phụ đề .ass để ffmpeg burn vào video.

Vì sao .ass thay vì vẽ chữ bằng code:
    ffmpeg render phụ đề bằng C, tốc độ gấp hàng chục lần so với việc vẽ text
    lên từng frame trong Python. Đây chính là thứ khiến các repo dùng MoviePy
    chậm tới 30 phút cho một video. Xem ARCHITECTURE.md §2, luật 2.
"""

from __future__ import annotations

import textwrap
from collections.abc import Sequence
from pathlib import Path
from typing import NamedTuple

from ..models import TranscriptSegment, Word
from ..wordmatch import spans_in

_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font},{fontsize},&H00FFFFFF,{outline_colour},&H80000000,{bold},0,0,0,100,100,0,0,{border_style},{outline},{shadow},2,{margin},{margin},{margin_v},1
{extra_styles}
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def _timestamp(seconds: float) -> str:
    """ASS dùng định dạng H:MM:SS.cc (centisecond)."""
    seconds = max(0.0, seconds)
    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)
    centis = round((secs - int(secs)) * 100)
    if centis == 100:  # làm tròn lên tràn sang giây
        centis = 0
        secs += 1
    return f"{int(hours)}:{int(minutes):02d}:{int(secs):02d}.{centis:02d}"


def _escape_piece(text: str) -> str:
    """Thoát ký tự nhưng GIỮ khoảng trắng hai đầu.

    Cắt một câu thành head/word/tail thì khoảng trắng chính là thứ nối chúng lại;
    `.strip()` ở đây sẽ dính các từ vào nhau.
    """
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def _escape(text: str) -> str:
    return _escape_piece(text).strip()


# Màu nhấn cho từ đang được nói. ASS dùng &HBBGGRR — đây là vàng chanh
# (R=0xE1, G=0xFF, B=0x3A), đọc rõ trên cả nền sáng lẫn tối vì đã có viền đen.
_HIGHLIGHT = r"&H3AFFE1&"

# Số từ tối đa hiện cùng lúc. Một segment của Whisper dài tới 12 giây và 25 từ —
# render nguyên khối cho ra bức tường 6 dòng che gần nửa khung dọc, và phần nhấn
# thành vô dụng vì mắt không tìm nổi từ đang chạy trong đó. Năm từ vừa đúng
# một-hai dòng ở cỡ chữ 86px trên khung 1080.
_MAX_WORDS = 5


def _chunks(total: int) -> list[tuple[int, int]]:
    """Chia `total` từ thành các cụm [đầu, cuối] không quá `_MAX_WORDS`.

    Chia đều thay vì cắt cứng mỗi 5 từ, để không còn cụm cuối lẻ loi một từ:
    13 từ ra 5+4+4 chứ không phải 5+5+3.
    """
    if total <= _MAX_WORDS:
        return [(0, total - 1)]
    parts = -(-total // _MAX_WORDS)  # làm tròn lên
    base, extra = divmod(total, parts)
    out = []
    at = 0
    for k in range(parts):
        size = base + (1 if k < extra else 0)
        out.append((at, at + size - 1))
        at += size
    return out


def _word_spans(text: str, words: list[Word]) -> list[tuple[int, int]] | None:
    """Định vị từng từ thành khoảng ký tự trong `text` GỐC.

    Cố ý ánh xạ vào `seg.text` thay vì ghép `w.text` lại: Whisper trả từ thường
    không kèm dấu câu, nên ghép lại sẽ ra một câu KHÁC câu đang hiển thị hôm nay.
    Chữ trên màn hình phải y nguyên dù bật hay tắt nhấn từ.

    Trả None ngay khi có một từ không định vị được — bên gọi rơi về cách cũ cho
    riêng segment đó.
    """
    return spans_in(text, [w.text for w in words])


def _karaoke_lines(seg: TranscriptSegment, highlight: str = _HIGHLIGHT) -> list[str]:
    """Sinh các dòng Dialogue nhấn từng từ cho MỘT segment.

    Cách làm: mỗi từ một dòng Dialogue, nhưng **mỗi dòng chứa nguyên câu**, chỉ
    khác ở chỗ từ đang nói được bọc tag đổi màu.

    Vì sao không tách mỗi từ thành một dòng riêng: libass ngắt dòng theo bề rộng
    chữ thật (`WrapStyle: 0`). Nếu nội dung mỗi dòng Dialogue khác nhau thì chỗ
    xuống dòng nhảy loạn theo từng từ. Giữ nguyên câu ở mọi dòng thì libass ngắt
    y hệt nhau, chỗ xuống dòng đứng im và chỉ có màu chạy.

    Vì sao không dùng tag `\\k`: `\\k` cho hiệu ứng đổ màu dần kiểu karaoke quán,
    không phải kiểu cả câu hiện sẵn rồi nhấn đúng một từ.
    """
    words = seg.words or []
    spans = _word_spans(seg.text, words)
    if not spans:
        return []

    lines = []
    for lo, hi in _chunks(len(spans)):
        # Cụm chạy từ đầu từ đầu tiên tới ngay trước từ mở đầu cụm sau, nên dấu
        # câu và khoảng trắng ở đuôi cụm được giữ lại thay vì rơi mất.
        text_from = spans[lo][0]
        text_to = spans[hi + 1][0] if hi + 1 < len(spans) else len(seg.text)
        chunk_text = seg.text[text_from:text_to]

        # Cụm đầu bám đầu segment, cụm cuối bám đuôi segment — không để hở khoảng
        # nào không có chữ.
        chunk_start = seg.start if lo == 0 else words[lo].start
        chunk_end = seg.end if hi + 1 >= len(spans) else words[hi + 1].start

        for i in range(lo, hi + 1):
            w_start = _timestamp(chunk_start if i == lo else words[i].start)
            w_end = _timestamp(chunk_end if i == hi else words[i + 1].start)
            if w_start == w_end:
                continue
            begin, stop = spans[i]
            # Thoát ký tự TRƯỚC rồi mới bọc tag, để dấu { } trong transcript
            # không giả mạo được một khối override của ASS.
            head = _escape_piece(chunk_text[: begin - text_from])
            word = _escape_piece(chunk_text[begin - text_from : stop - text_from])
            tail = _escape_piece(chunk_text[stop - text_from :])
            body = f"{head}{{\\c{highlight}}}{word}{{\\r}}{tail}".strip()
            lines.append(f"Dialogue: 0,{w_start},{w_end},Default,,0,0,0,,{body}")

    # Không dựng được dòng nào (mốc thời gian hỏng) thì trả rỗng để bên gọi rơi
    # về cách cũ, chứ không để clip mất phụ đề.
    return lines


def _chunk_spans(seg: TranscriptSegment) -> list[tuple[float, float, str]]:
    """Các cụm chữ hiện cùng lúc trên màn hình cho MỘT segment: (đầu, cuối, chữ).

    Ranh giới cụm trùng với `_karaoke_lines` để đổi preset không làm chữ nhảy
    chỗ xuống dòng, và để file .srt xuất kèm khớp đúng thứ đang hiện trên video.
    """
    words = seg.words or []
    spans = _word_spans(seg.text, words)
    if not spans:
        return []

    out = []
    for lo, hi in _chunks(len(spans)):
        text_from = spans[lo][0]
        text_to = spans[hi + 1][0] if hi + 1 < len(spans) else len(seg.text)
        out.append(
            (
                seg.start if lo == 0 else words[lo].start,
                seg.end if hi + 1 >= len(spans) else words[hi + 1].start,
                seg.text[text_from:text_to],
            )
        )
    return out


def caption_cues(segments: list[TranscriptSegment]) -> list[tuple[float, float, str]]:
    """Phụ đề của một clip dưới dạng cụm chữ — nguồn chung của .ass và .srt.

    Segment không có mốc từng từ thì giữ nguyên cả câu, y như khi burn vào video.
    """
    cues: list[tuple[float, float, str]] = []
    for seg in segments:
        if not seg.text.strip():
            continue
        chunks = _chunk_spans(seg) if seg.words else []
        if not chunks:
            chunks = [(seg.start, seg.end, seg.text)]
        cues.extend((start, end, text.strip()) for start, end, text in chunks if text.strip())
    return cues


def _plain_chunk_lines(seg: TranscriptSegment) -> list[str]:
    """Chia câu thành cụm ≤ `_MAX_WORDS` mà KHÔNG nhấn từ — cho preset tắt nhấn.

    Tắt nhấn không có nghĩa là quay về một dòng cho cả segment: segment 12 giây
    thành bức tường ba, bốn dòng che nửa khung dọc (đã thấy khi render preset
    minimal).
    """
    lines = []
    for chunk_start, chunk_end, chunk_text in _chunk_spans(seg):
        start = _timestamp(chunk_start)
        end = _timestamp(chunk_end)
        text = _escape(chunk_text)
        if text and start != end:
            lines.append(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{text}")
    return lines


class TextLayer(NamedTuple):
    """Một lớp chữ tự do trên khung: nội dung, khoảng hiện, và style bắt buộc.

    Style KHÔNG được phép thiếu. `headline` cũ có một nhánh "chưa chỉnh style"
    dùng Alignment 8 (neo ĐỈNH chữ) còn canvas neo TÂM, nên preview và file lệch
    nhau nửa dòng chữ mà không ai sửa được. Bắt buộc có style thì mọi lớp đều đi
    qua `\an5\\pos` — một hệ neo duy nhất, hai bên không thể lệch.
    """

    text: str
    start: float
    end: float
    style: dict


def _ass_colour(hex_colour: str) -> str:
    """`#RRGGBB` -> `&H00BBGGRR`. ASS đảo thứ tự kênh và thêm alpha ở đầu."""
    c = hex_colour.lstrip("#").upper()
    return f"&H00{c[4:6]}{c[2:4]}{c[:2]}"


def _text_layer_style(name: str, layer: TextLayer, width: int, height: int) -> tuple[str, int]:
    """Dòng `Style:` cho một lớp chữ, và lề ngang của nó.

    Lớp chữ và style tuỳ chỉnh của phụ đề dùng chung công thức cỡ chữ/viền này,
    để cùng một bộ số không ra hai kết quả khác nhau.
    """
    size = round(layer.style["size"] * max(width, height) / 1920)
    outline = max(1, round(size / 16))
    margin = round(width * max(0.08, 0.52 - min(layer.style["x"], 1 - layer.style["x"])))
    style = (
        f"Style: {name},{layer.style['font']},{size},{_ass_colour(layer.style['color'])},"
        f"&H00000000,&H99000000,{-1 if layer.style['bold'] else 0},0,0,0,100,100,0,0,"
        f"1,{outline},1,5,{margin},{margin},0,1"
    )
    return style, margin


def build_ass(
    segments: list[TranscriptSegment],
    out_path: Path,
    *,
    width: int = 1080,
    height: int = 1920,
    max_chars_per_line: int | None = None,
    highlight: str | None = _HIGHLIGHT,
    font_ratio: float = 0.045,
    bold: bool = True,
    outline_ratio: float = 1 / 12,
    boxed: bool = False,
    margin_v_ratio: float = 0.18,
    headline: str = "",
    headline_seconds: float = 3.0,
    texts: Sequence[TextLayer] = (),
) -> Path:
    """Ghi file .ass cho một clip. Mốc thời gian tính từ gốc 0 của clip.

    `max_chars_per_line` mặc định là None: để libass tự ngắt dòng theo bề rộng
    chữ THẬT. Ngắt bằng cách đếm ký tự (bản trước dùng 22) là sai — đo trên
    DejaVu Sans Bold 86px, dòng 19 ký tự "and nothing more to" đã rộng 995px
    trong khi vùng chữ chỉ có 908px, nên phụ đề tràn ra sát mép khung. Chỉ đặt
    số này khi cần ép ngắt dòng cho mục đích khác.

    Các tham số kiểu chữ phục vụ preset của editor (`editing/render.py`). Giá
    trị mặc định cho ra đúng file mà pipeline tạo từ trước tới nay. Cỡ chữ tính
    theo CẠNH DÀI của khung: 9:16 giữ nguyên 86px, còn 1:1 và 16:9 không bị chữ
    bé tí vì chiều cao ngắn.
    """
    fontsize = int(max(width, height) * font_ratio)
    outline = max(2, int(fontsize * outline_ratio))

    extra_styles = ""
    # Lớp chữ tự do (`settings.texts`). Mỗi lớp một style riêng vì font, cỡ và
    # màu là của riêng nó. `headline` bên dưới là đường CŨ, giữ lại để revision
    # đã lưu render y như trước — revision bất biến, không backfill được.
    text_margins: list[int] = []
    for i, layer in enumerate(texts):
        style, margin = _text_layer_style(f"Text{i}", layer, width, height)
        extra_styles += style + "\n"
        text_margins.append(margin)
    if headline.strip():
        # Headline nằm trên đầu khung (Alignment 8), hộp nền để đọc được trên mọi
        # cảnh. Đi qua ASS chứ không qua drawtext vì chữ do người dùng nhập — xem
        # `_clean_watermark` ở render.py về chuyện escape hai lớp của drawtext.
        extra_styles = (
            f"Style: Headline,DejaVu Sans,{int(fontsize * 1.1)},&H00FFFFFF,&H99000000,"
            f"&H99000000,-1,0,0,0,100,100,0,0,3,{outline},0,8,"
            f"{int(width * 0.08)},{int(width * 0.08)},{int(height * 0.08)},1\n"
        )

    body = _HEADER.format(
        width=width,
        height=height,
        font="DejaVu Sans",
        fontsize=fontsize,
        # Hộp nền (BorderStyle 3) lấy màu viền làm màu hộp — trong suốt một nửa.
        outline_colour="&H80000000" if boxed else "&H00000000",
        bold=-1 if bold else 0,
        border_style=3 if boxed else 1,
        outline=outline,
        shadow=0 if boxed else 2,
        margin=int(width * 0.08),
        # Đặt chữ ở khoảng 1/4 dưới màn hình — tránh vùng UI của TikTok/Reels
        # (nút tương tác bên phải, caption của nền tảng ở dưới).
        margin_v=int(height * margin_v_ratio),
        extra_styles=extra_styles,
    )

    lines = []
    for i, layer in enumerate(texts):
        body_text = _escape(layer.text)
        if not body_text:
            continue
        margin = text_margins[i]
        tag = (
            f"{{\\an5\\pos({round(layer.style['x'] * width)},"
            f"{round(layer.style['y'] * height)})}}"
        )
        lines.append(
            f"Dialogue: 1,{_timestamp(layer.start)},{_timestamp(layer.end)},"
            f"Text{i},,{margin},{margin},0,,{tag}{body_text}"
        )
    if headline.strip():
        lines.append(
            f"Dialogue: 1,{_timestamp(0)},{_timestamp(headline_seconds)},"
            f"Headline,,0,0,0,,{_escape(headline)}"
        )
    for seg in segments:
        text = _escape(seg.text)
        if not text:
            continue
        # Có mốc từng từ thì nhấn từng từ. Không có — phụ đề cũ, nguồn không cho
        # biết, Whisper trả thiếu — thì rơi về một dòng cho cả câu như trước.
        # `max_chars_per_line` ép ngắt dòng nên không đi chung với nhấn từ.
        if seg.words and not max_chars_per_line:
            chunked = _karaoke_lines(seg, highlight) if highlight else _plain_chunk_lines(seg)
            if chunked:
                lines.extend(chunked)
                continue
        if max_chars_per_line:
            text = "\\N".join(textwrap.wrap(text, width=max_chars_per_line) or [text])
        lines.append(
            f"Dialogue: 0,{_timestamp(seg.start)},{_timestamp(seg.end)},"
            f"Default,,0,0,0,,{text}"
        )

    out_path.write_text(body + "\n".join(lines) + "\n", encoding="utf-8")
    return out_path
