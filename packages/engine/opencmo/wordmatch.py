"""Khớp từ vào chữ theo ranh giới từ.

Tách riêng vì hai nơi cần dùng và chúng BẮT BUỘC phải đồng ý với nhau:

  - `steps/transcribe.py` chia danh sách từ của Whisper về từng segment
  - `steps/captions.py` định vị từng từ để tô màu

Hai bản logic riêng mà lệch nhau một chút thì phần nhấn lệch chỗ trên clip —
file vẫn ra, vẫn mở được, chỉ là nhìn thì sai.
"""

from __future__ import annotations


def is_word_char(ch: str) -> bool:
    """Ký tự tạo nên một từ.

    Có `'` vì Whisper trả `"it's"` là MỘT từ — thiếu nó thì `"it"` khớp được vào
    giữa `"it's"` và mọi từ sau đó lệch theo.
    """
    return ch.isalnum() or ch == "'"


def find_whole_word(haystack: str, token: str, start: int = 0) -> int:
    """Vị trí của `token` như một TỪ TRỌN VẸN, hoặc -1.

    Đo trên dữ liệu Whisper thật: `str.find()` làm từ `"I"` khớp vào chữ `i` giữa
    `"This"`, cho ra `And th[I]s all failed.`
    """
    at = haystack.find(token, start)
    while at >= 0:
        before_ok = at == 0 or not is_word_char(haystack[at - 1])
        after = at + len(token)
        after_ok = after >= len(haystack) or not is_word_char(haystack[after])
        if before_ok and after_ok:
            return at
        at = haystack.find(token, at + 1)
    return -1


def spans_in(text: str, tokens: list[str]) -> list[tuple[int, int]] | None:
    """Khoảng ký tự của từng token trong `text`, theo đúng thứ tự.

    Trả None nếu có bất kỳ token nào không định vị được — bên gọi rơi về cách cũ
    thay vì tô nhầm chỗ.
    """
    spans: list[tuple[int, int]] = []
    low = text.lower()
    pos = 0
    for token in tokens:
        needle = token.strip().lower()
        if not needle:
            return None
        found = find_whole_word(low, needle, pos)
        if found < 0:
            return None
        spans.append((found, found + len(needle)))
        pos = found + len(needle)
    return spans or None


def keep_alignable(text: str, tokens: list[str]) -> list[int]:
    """Chỉ số các token khớp được vào `text` theo thứ tự; token không khớp bị BỎ QUA.

    Bỏ qua chứ không dừng, và đó là điểm mấu chốt. Whisper trả chữ ở mức câu và
    chữ ở mức từ từ HAI lượt giải mã khác nhau, và chúng không trùng nhau:

        seg  : 'I think he   sad about that day because that   my fault'
        words: 'I think he's sad about that day because that's my ...'

    Nên "danh sách từ là token của câu" là một giả định sai. Bất kỳ cách chia nào
    dừng ở token đầu tiên không khớp sẽ lệch pha rồi kẹt vĩnh viễn — đo thật trên
    video 8.7 phút: chỉ 18/67 segment giữ được từ, 211/972 từ được gắn.

    Bỏ qua token lệch thì từ đó không được nhấn, còn cả câu vẫn chạy bình thường.
    Xuống cấp từng từ, không phải từng segment.
    """
    low = text.lower()
    pos = 0
    kept: list[int] = []
    for i, token in enumerate(tokens):
        needle = token.strip().lower()
        if not needle:
            continue
        found = find_whole_word(low, needle, pos)
        if found < 0:
            continue
        kept.append(i)
        pos = found + len(needle)
    return kept
