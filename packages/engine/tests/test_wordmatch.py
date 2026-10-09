from opencmo.wordmatch import find_whole_word, keep_alignable, spans_in


def test_khong_khop_chuoi_con():
    # "I" nằm trong "This" nhưng không phải một từ
    assert find_whole_word("and this all failed.", "i", 0) == -1


def test_khop_tu_tron_ven():
    assert find_whole_word("and then i lose", "i", 0) == 9


def test_dau_nhay_thuoc_ve_tu():
    """Whisper trả "it's" là MỘT từ. Nếu dấu nháy không tính là ký tự của từ thì
    "it" khớp vào giữa "it's" và mọi từ sau đó lệch theo."""
    assert find_whole_word("it's fine", "it", 0) == -1
    assert find_whole_word("it's fine", "it's", 0) == 0


def test_spans_tra_none_khi_co_tu_khong_khop():
    assert spans_in("hello world", ["hello", "zzz"]) is None


def test_spans_dung_thu_tu():
    assert spans_in("a b a", ["a", "b", "a"]) == [(0, 1), (2, 3), (4, 5)]


def test_keep_alignable_bo_qua_tu_lech_chu_khong_dung():
    """Đây là hành vi quan trọng nhất của module.

    Whisper trả chữ mức câu và chữ mức từ từ hai lượt giải mã khác nhau nên chúng
    lệch: câu ghi "he sad", từ ghi "he's sad". Dừng ở token lệch đầu tiên sẽ làm
    lệch pha rồi kẹt vĩnh viễn — đo thật trên video 8.7 phút khi còn dừng: chỉ
    18/67 segment giữ được từ.
    """
    kept = keep_alignable(
        "I think he sad about that day",
        ["I", "think", "he's", "sad", "about", "that", "day"],
    )
    assert kept == [0, 1, 3, 4, 5, 6]  # bỏ "he's" (index 2), giữ phần còn lại


def test_keep_alignable_giu_nguyen_khi_khop_het():
    kept = keep_alignable("one two three", ["one", "two", "three"])
    assert kept == [0, 1, 2]


def test_keep_alignable_rong_khi_khong_gi_khop():
    assert keep_alignable("one two", ["xxx", "yyy"]) == []
