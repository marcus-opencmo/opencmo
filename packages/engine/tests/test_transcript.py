from opencmo.models import Transcript, TranscriptSegment
from opencmo.steps import transcribe
from opencmo.steps.download import _parse_vtt

VTT = """WEBVTT

00:00:01.000 --> 00:00:03.000
Xin chào các bạn

00:00:03.000 --> 00:00:05.000
Xin chào các bạn

00:00:05.000 --> 00:00:07.500
<c>Hôm nay</c> chúng ta nói về marketing
"""


def test_parse_vtt_extracts_segments():
    segments = _parse_vtt(VTT)
    assert len(segments) == 2  # dòng lặp bị gộp lại
    assert segments[0].text == "Xin chào các bạn"
    assert segments[0].start == 1.0


def test_parse_vtt_merges_duplicate_scrolling_lines():
    # Phụ đề tự động lặp dòng khi cuộn chữ. Dòng lặp phải KÉO DÀI đoạn trước
    # tới hết thời gian hiển thị thật (1.0 → 5.0), không tạo đoạn mới.
    merged = _parse_vtt(VTT)[0]
    assert merged.start == 1.0
    assert merged.end == 5.0


def test_parse_vtt_strips_inline_tags():
    assert "<c>" not in _parse_vtt(VTT)[1].text
    assert _parse_vtt(VTT)[1].text.startswith("Hôm nay")


# Đúng hình dạng phụ đề TỰ ĐỘNG của YouTube: cue settings nằm cuối dòng mốc thời
# gian, một dòng chỉ có dấu cách chèn giữa cue, và mỗi cue lặp lại dòng của cue
# trước (hiệu ứng cuộn). Cả ba đều từng lọt vào clip thật.
YOUTUBE_AUTO_VTT = """WEBVTT
Kind: captions
Language: en

00:00:00.160 --> 00:00:02.230 align:start position:0%

what<00:00:00.399><c> is</c><00:00:00.560><c> up</c><00:00:00.719><c> guys</c>

00:00:02.230 --> 00:00:02.240 align:start position:0%
what is up guys


00:00:02.240 --> 00:00:03.429 align:start position:0%
what is up guys
to<00:00:02.320><c> be</c><00:00:02.480><c> showing</c><00:00:02.720><c> you</c>
"""


def test_parse_vtt_drops_cue_settings():
    # "align:start position:0%" nằm sau mốc thời gian trên CÙNG một dòng. Cắt
    # ngay sau mốc thời gian thì nó thành chữ và bị burn lên clip.
    segments = _parse_vtt(YOUTUBE_AUTO_VTT)
    assert all("align:" not in s.text and "position:" not in s.text for s in segments)


def test_parse_vtt_keeps_first_line_of_each_scroll():
    # Dòng chỉ có một dấu cách KHÔNG được coi là ranh giới cue: nếu coi là ranh
    # giới thì "what is up guys" mất mốc thời gian thật (0.16) và chỉ được nhặt
    # lại ở cue chớp 10ms sau đó, thành đoạn dài 0 giây, phụ đề hiện sai nhịp.
    segments = _parse_vtt(YOUTUBE_AUTO_VTT)
    assert segments[0].text == "what is up guys"
    assert segments[0].start == 0.16
    assert all(s.end > s.start for s in segments)


def test_parse_vtt_dedupes_scrolling_lines_not_whole_cues():
    # Cue thứ ba mang lại dòng cũ + dòng mới. Chỉ dòng mới được giữ.
    segments = _parse_vtt(YOUTUBE_AUTO_VTT)
    assert [s.text for s in segments] == ["what is up guys", "to be showing you"]


def test_parse_srt_ignores_cue_numbers():
    srt = "1\n00:00:01,000 --> 00:00:02,000\nXin chào\n\n2\n00:00:03,000 --> 00:00:04,500\nThế giới\n"
    segments = _parse_vtt(srt)
    assert [s.text for s in segments] == ["Xin chào", "Thế giới"]
    assert segments[1].start == 3.0


def test_transcript_slice_rebases_to_zero():
    t = Transcript(
        segments=[
            TranscriptSegment(0.0, 5.0, "trước"),
            TranscriptSegment(10.0, 12.0, "trong"),
            TranscriptSegment(30.0, 32.0, "sau"),
        ]
    )
    sliced = t.slice(9.0, 20.0)

    assert len(sliced) == 1
    assert sliced[0].text == "trong"
    assert sliced[0].start == 1.0  # 10.0 - 9.0
    assert sliced[0].end == 3.0


def test_transcript_slice_clamps_overhanging_segments():
    t = Transcript(segments=[TranscriptSegment(5.0, 25.0, "dài")])
    sliced = t.slice(10.0, 20.0)
    assert sliced[0].start == 0.0
    assert sliced[0].end == 10.0


def test_base_opts_ignores_playlist_in_url():
    # Link `watch?v=…&list=RD…` (mix tự sinh) mà thiếu cờ này thì yt-dlp duyệt cả
    # playlist gần như vô tận — probe treo, job chết ngay bước đầu.
    from opencmo.config import Config
    from opencmo.steps.download import _base_opts

    assert _base_opts(Config())["noplaylist"] is True


def test_music_with_empty_speech_to_text_result_is_a_valid_empty_transcript(monkeypatch, tmp_path):
    """Nhạc không lời không phải lỗi transcription."""
    from opencmo.config import Config

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {"words": [], "language_code": "eng", "text": ""}

    monkeypatch.setattr(transcribe.httpx, "post", lambda *_args, **_kwargs: Response())
    audio = tmp_path / "music.m4a"
    audio.write_bytes(b"audio")

    transcript = transcribe.transcribe_audio(audio, Config(elevenlabs_api_key="test"))

    assert transcript.segments == []
    assert transcript.source == "scribe"
    assert transcript.language == "en"


def test_vtt_giai_ma_entity_xml_cua_youtube():
    """Nguồn phụ đề tự động của YouTube là XML: `>>` tới đây là `&gt;&gt;`.

    Không giải mã lại thì người xem đọc đúng chữ "&gt;&gt;" trên clip — đã hiện
    thật. Nó còn đi vào .srt, .txt và transcript mà LLM đọc để chọn khoảnh khắc.
    """
    vtt = (
        "WEBVTT\n\n"
        "00:00:00.000 --> 00:00:02.000 align:start position:0%\n"
        "&gt;&gt; I&#39;ve made $100,000\n\n"
        "00:00:02.000 --> 00:00:04.000\n"
        "profit &amp; growth\n"
    )

    segments = _parse_vtt(vtt)

    assert segments[0].text == ">> I've made $100,000"
    assert segments[1].text == "profit & growth"


def test_vtt_bo_tag_truoc_roi_moi_giai_ma():
    """Thứ tự quan trọng: `&lt;c&gt;` do tác giả cố ý viết KHÔNG được biến thành
    một thẻ rồi bị bộ lọc tag ăn mất."""
    vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<c>xin chào</c> &lt;c&gt;\n"

    segments = _parse_vtt(vtt)

    assert segments[0].text == "xin chào <c>"


def test_vtt_youtube_tu_dong_giu_moc_tung_tu():
    # Thiếu mốc từng từ thì cả dòng thành MỘT "từ" và preset phụ đề vẽ nguyên
    # dòng dài hơn khung 1080 (UAT production 29/09).
    segments = _parse_vtt(YOUTUBE_AUTO_VTT)
    words = segments[0].words
    assert [w.text for w in words] == ["what", "is", "up", "guys"]
    assert words[0].start == 0.16
    assert words[1].start == 0.399
    assert words[0].end == words[1].start
    assert words[-1].end == 2.23
    assert [w.text for w in segments[1].words] == ["to", "be", "showing", "you"]
    assert segments[1].words[0].start == 2.24


def test_vtt_khong_co_moc_thi_khong_bia_moc():
    assert all(s.words is None for s in _parse_vtt(VTT))


def test_chon_phu_de_nguoi_lam_truoc_ban_tu_dong(tmp_path):
    from opencmo.steps.download import _pick_subtitles

    for name in ["subs.en-orig.vtt", "subs.en.vtt"]:
        (tmp_path / name).write_text("WEBVTT\n")
    assert _pick_subtitles(tmp_path, "en")[0].name == "subs.en.vtt"
    (tmp_path / "subs.en.vtt").unlink()
    assert _pick_subtitles(tmp_path, "en")[0].name == "subs.en-orig.vtt"


def test_base_opts_bat_js_runtime_co_san():
    # yt-dlp mặc định chỉ dùng deno; máy dev và image Modal có Node chứ không có
    # deno. Thiếu runtime thì không giải được đề chữ ký của YouTube: đo 01/10,
    # tải đoạn 720p hỏng hẳn (ffmpeg exit 8), có Node thì ra 1280x720.
    import yt_dlp

    from opencmo.config import Config
    from opencmo.steps.download import _base_opts

    opts = _base_opts(Config())
    assert "node" in opts["js_runtimes"] and "deno" in opts["js_runtimes"]
    # Script giải đề đi kèm gói `yt-dlp-ejs` (extra `default`), không tải từ GitHub lúc chạy.
    import yt_dlp_ejs  # noqa: F401

    with yt_dlp.YoutubeDL(opts) as ydl:
        assert set(ydl.params["js_runtimes"]) >= {"node", "deno"}
