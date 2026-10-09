from itertools import pairwise
from pathlib import Path

from opencmo.models import TranscriptSegment, Word
from opencmo.steps.captions import _timestamp, build_ass


def test_timestamp_format():
    assert _timestamp(0) == "0:00:00.00"
    assert _timestamp(61.5) == "0:01:01.50"
    assert _timestamp(3661.25) == "1:01:01.25"


def test_timestamp_never_negative():
    assert _timestamp(-5) == "0:00:00.00"


def test_timestamp_rounding_carries_into_seconds():
    # 1.999 làm tròn centisecond lên 100 — phải tràn sang giây, không in ".100"
    assert _timestamp(1.999) == "0:00:02.00"


def test_build_ass_writes_dialogue_lines(tmp_path: Path):
    segments = [
        TranscriptSegment(0.0, 2.0, "Câu đầu tiên"),
        TranscriptSegment(2.0, 4.0, "Câu thứ hai"),
    ]
    out = build_ass(segments, tmp_path / "s.ass")
    text = out.read_text(encoding="utf-8")

    assert "[V4+ Styles]" in text
    assert text.count("Dialogue:") == 2
    assert "Câu đầu tiên" in text


def test_build_ass_skips_empty_segments(tmp_path: Path):
    segments = [TranscriptSegment(0.0, 1.0, "  "), TranscriptSegment(1.0, 2.0, "thật")]
    out = build_ass(segments, tmp_path / "s.ass")
    assert out.read_text(encoding="utf-8").count("Dialogue:") == 1


# --- nhấn từng từ (karaoke) -------------------------------------------------

_WORDS = [
    Word(0.0, 0.4, "What"),
    Word(0.4, 0.7, "is"),
    Word(0.7, 1.0, "up"),
    Word(1.0, 2.0, "guys"),
]


def _dialogues(path: Path) -> list[str]:
    return [
        ln for ln in path.read_text(encoding="utf-8").splitlines()
        if ln.startswith("Dialogue:")
    ]


def _body(line: str) -> str:
    # 10 field đầu của Dialogue cố định, phần chữ là tất cả những gì còn lại
    return line.split(",", 9)[9]


def test_karaoke_sinh_mot_su_kien_moi_tu(tmp_path: Path):
    seg = TranscriptSegment(0.0, 2.0, "What is up, guys?", words=_WORDS)
    assert len(_dialogues(build_ass([seg], tmp_path / "s.ass"))) == len(_WORDS)


def test_karaoke_moi_su_kien_chua_NGUYEN_cau(tmp_path: Path):
    """Đây là test giữ ngắt dòng đứng im.

    libass ngắt dòng theo bề rộng chữ thật (WrapStyle 0). Nếu mỗi sự kiện chứa
    chữ khác nhau thì chỗ xuống dòng nhảy loạn theo từng từ. Ai đó "tối ưu" hàm
    này thành mỗi sự kiện chỉ chứa một từ thì test này phải đỏ.
    """
    seg = TranscriptSegment(0.0, 2.0, "What is up, guys?", words=_WORDS)
    for line in _dialogues(build_ass([seg], tmp_path / "s.ass")):
        plain = _body(line).replace("{\\c&H3AFFE1&}", "").replace("{\\r}", "")
        assert plain == "What is up, guys?"


def test_karaoke_nhan_dung_mot_tu_moi_su_kien(tmp_path: Path):
    seg = TranscriptSegment(0.0, 2.0, "What is up, guys?", words=_WORDS)
    for line in _dialogues(build_ass([seg], tmp_path / "s.ass")):
        assert _body(line).count("{\\c&H3AFFE1&}") == 1


def test_karaoke_giu_nguyen_dau_cau_cua_text_goc(tmp_path: Path):
    """Whisper trả từ KHÔNG kèm dấu câu. Chữ hiển thị phải là text gốc, không
    phải danh sách từ ghép lại — nếu không, bật nhấn từ là đổi luôn nội dung."""
    seg = TranscriptSegment(0.0, 2.0, "What is up, guys?", words=_WORDS)
    text = build_ass([seg], tmp_path / "s.ass").read_text(encoding="utf-8")
    assert "up, guys?" in text
    assert "up guys" not in text


def test_karaoke_cac_su_kien_noi_lien_khong_ho(tmp_path: Path):
    seg = TranscriptSegment(0.0, 2.0, "What is up, guys?", words=_WORDS)
    lines = _dialogues(build_ass([seg], tmp_path / "s.ass"))
    times = [(ln.split(",")[1], ln.split(",")[2]) for ln in lines]
    assert times[0][0] == "0:00:00.00"       # bám đầu segment
    assert times[-1][1] == "0:00:02.00"      # bám đuôi segment
    for (_, end), (nxt, _) in pairwise(times):
        assert end == nxt                     # không hở, không chồng


def test_karaoke_khong_co_words_thi_ra_y_het_nhu_cu(tmp_path: Path):
    """Đường rơi về cũ phải giống HỆT bản hiện tại, không chỉ 'gần giống'."""
    plain = TranscriptSegment(0.0, 2.0, "What is up, guys?")
    withw = TranscriptSegment(0.0, 2.0, "What is up, guys?", words=None)
    a = build_ass([plain], tmp_path / "a.ass").read_text(encoding="utf-8")
    b = build_ass([withw], tmp_path / "b.ass").read_text(encoding="utf-8")
    assert a == b
    assert a.count("Dialogue:") == 1


def test_karaoke_roi_ve_cu_khi_tu_khong_khop_text(tmp_path: Path):
    seg = TranscriptSegment(0.0, 2.0, "hello world", words=[Word(0.0, 1.0, "zzz")])
    assert len(_dialogues(build_ass([seg], tmp_path / "s.ass"))) == 1


def test_karaoke_tat_khi_ep_ngat_dong_theo_ky_tu(tmp_path: Path):
    seg = TranscriptSegment(0.0, 2.0, "What is up, guys?", words=_WORDS)
    out = build_ass([seg], tmp_path / "s.ass", max_chars_per_line=8)
    assert len(_dialogues(out)) == 1


def test_karaoke_khong_cho_dau_ngoac_gia_mao_tag(tmp_path: Path):
    seg = TranscriptSegment(0.0, 1.0, "a {\\b1}b", words=[Word(0.0, 0.5, "a"), Word(0.5, 1.0, "b")])
    body = _body(_dialogues(build_ass([seg], tmp_path / "s.ass"))[0])
    assert "\\{" in body          # ngoặc của người dùng đã bị thoát
    assert "{\\b1}" not in body   # không còn là khối override thật


def test_karaoke_khong_khop_tu_vao_giua_tu_khac(tmp_path: Path):
    """Đo trên dữ liệu Whisper thật: `find()` làm từ "I" khớp vào chữ i giữa
    "This", cho ra `And th[I]s all failed.` — chữ đúng, nhấn sai chỗ."""
    seg = TranscriptSegment(0.0, 2.0, "And this all failed.", words=[Word(0.0, 2.0, "I")])
    # "I" không tồn tại như một từ trọn vẹn -> phải rơi về cũ, không nhấn bừa
    lines = _dialogues(build_ass([seg], tmp_path / "s.ass"))
    assert len(lines) == 1
    assert "{\\c" not in _body(lines[0])


def test_karaoke_dau_nhay_khong_lam_lech_nhan(tmp_path: Path):
    """Whisper trả "it's" là MỘT từ. Nếu ranh giới từ bỏ qua dấu nháy thì "it"
    khớp vào giữa "it's" và mọi từ sau đó lệch theo."""
    seg = TranscriptSegment(
        0.0, 2.0, "it's fine",
        words=[Word(0.0, 1.0, "it's"), Word(1.0, 2.0, "fine")],
    )
    lines = _dialogues(build_ass([seg], tmp_path / "s.ass"))
    assert len(lines) == 2
    assert "{\\c&H3AFFE1&}it's{\\r}" in _body(lines[0])
    assert "{\\c&H3AFFE1&}fine{\\r}" in _body(lines[1])


def test_karaoke_chia_cum_khi_cau_qua_dai(tmp_path: Path):
    """Segment Whisper dài tới 12 giây / 25 từ. Render nguyên khối ra bức tường
    6 dòng che nửa khung dọc, và phần nhấn thành vô dụng vì mắt không tìm nổi từ
    đang chạy. Đo thật trên clip đầu tiên: 25 từ, 6 dòng."""
    n = 13
    words = [Word(i * 1.0, i * 1.0 + 1.0, f"w{i}") for i in range(n)]
    seg = TranscriptSegment(0.0, float(n), " ".join(w.text for w in words), words=words)
    lines = _dialogues(build_ass([seg], tmp_path / "s.ass"))
    assert len(lines) == n  # vẫn một sự kiện mỗi từ

    # mỗi sự kiện chỉ hiện cụm của nó, không phải cả câu
    khoi = {_body(ln).replace("{\\c&H3AFFE1&}", "").replace("{\\r}", "") for ln in lines}
    assert len(khoi) == 3                      # 13 từ -> 5+4+4
    assert all(len(k.split()) <= 5 for k in khoi)


def test_karaoke_chia_cum_deu_khong_de_lai_cum_le_loi(tmp_path: Path):
    from opencmo.steps.captions import _chunks
    # 13 từ: 5+4+4, KHÔNG phải 5+5+3
    assert [hi - lo + 1 for lo, hi in _chunks(13)] == [5, 4, 4]
    assert [hi - lo + 1 for lo, hi in _chunks(4)] == [4]
    assert [hi - lo + 1 for lo, hi in _chunks(6)] == [3, 3]


def test_karaoke_cum_giu_dau_cau(tmp_path: Path):
    words = [Word(i * 1.0, i + 1.0, t) for i, t in enumerate(["one", "two", "three", "four", "five", "six"])]
    seg = TranscriptSegment(0.0, 6.0, "one two three, four five six!", words=words)
    khoi = {
        _body(ln).replace("{\\c&H3AFFE1&}", "").replace("{\\r}", "")
        for ln in _dialogues(build_ass([seg], tmp_path / "s.ass"))
    }
    assert "one two three," in khoi   # dấu phẩy đi theo cụm trước
    assert "four five six!" in khoi
