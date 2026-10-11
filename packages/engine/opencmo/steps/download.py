"""Tải nguồn bằng yt-dlp.

Chiến lược cốt lõi — xem ARCHITECTURE.md §3:
    KHÔNG BAO GIỜ tải nguyên video gốc.
    1. probe metadata (vài KB)
    2. thử lấy phụ đề có sẵn (vài KB, miễn phí)
    3. nếu không có → chỉ tải audio (~40MB thay vì ~1GB)
    4. sau khi LLM chọn xong → chỉ tải đúng các đoạn cần (~50MB)

Với video 45 phút, cách này biến ~1GB thành ~90MB. Đây là tối ưu lớn nhất
của toàn bộ pipeline: nó cắt cùng lúc chi phí proxy, băng thông, dung lượng
đĩa và thời gian chờ.
"""

from __future__ import annotations

import html
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ..config import Config, fresh_proxy_session
from ..media.ffmpeg import extract_audio
from ..media.probe import probe_file
from ..models import Moment, SourceInfo, Transcript, TranscriptSegment, Word
from .transcribe import TRANSCRIBE_MAX_BYTES

log = logging.getLogger(__name__)

_TIMESTAMP = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})"
)
_TAGS = re.compile(r"<[^>]+>")
# Mốc giữa dòng của phụ đề tự động YouTube: `what<00:00:00.399><c> is</c>` —
# mỗi mốc là giây bắt đầu của từ ngay sau nó.
_INLINE = re.compile(r"<(\d+):(\d{2}):(\d{2})\.(\d{3})>")


def _inline_words(raw: str, start: float, end: float) -> list[Word] | None:
    """Mốc từng từ của một dòng YouTube tự động; None nếu dòng không mang mốc.

    Thiếu bước này thì cả dòng thành MỘT "từ": editor không nhấn được từng từ,
    không cắt được "uh", và preset phụ đề vẽ nguyên dòng dài hơn khung 1080
    (UAT production 29/09).
    """
    parts = _INLINE.split(raw)
    if len(parts) < 5:
        return None
    # parts = [chữ0, h, m, s, ms, chữ1, h, m, s, ms, chữ2, …]
    starts = [start]
    texts = [parts[0]]
    for i in range(1, len(parts), 5):
        h, m, sec, ms = (int(g) for g in parts[i : i + 4])
        starts.append(h * 3600 + m * 60 + sec + ms / 1000)
        texts.append(parts[i + 4])
    words: list[Word] = []
    for index, chunk in enumerate(texts):
        text = html.unescape(_TAGS.sub("", chunk)).strip()
        if not text:
            continue
        word_start = starts[index]
        word_end = starts[index + 1] if index + 1 < len(starts) else end
        words.append(Word(start=word_start, end=max(word_start, word_end), text=text))
    return words or None


_SOCKET_TIMEOUT = 30


def _base_opts(cfg: Config) -> dict:
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        # Link copy từ trình duyệt hay kèm `&list=RD…&start_radio=1` (mix tự sinh).
        # Không có cờ này yt-dlp duyệt CẢ playlist — với mix thì gần như vô tận,
        # probe treo quá 60s. Người dùng dán link một video là muốn một video.
        "noplaylist": True,
        # Không có trần này, một luồng tắc giữa chừng làm yt-dlp chờ mãi. Heartbeat
        # chạy ở thread riêng vẫn gia hạn lease, nên job nằm `running` vô hạn —
        # local không có `timeout=1800` của Modal che hộ.
        "socket_timeout": _SOCKET_TIMEOUT,
        # YouTube bắt giải đề chữ ký bằng JS. Mặc định yt-dlp chỉ thử deno, mà
        # máy dev lẫn image Modal chỉ có Node (exporter cần Node ≥ 22). Thiếu
        # runtime thì đoạn 720p+ tải hỏng hẳn (ffmpeg exit 8), video cũ chỉ có
        # 240p thì lọt qua — nên lỗi trông như "nguồn mờ". Script giải đề nằm
        # trong gói `yt-dlp-ejs` (extra `default`), không tải từ GitHub lúc chạy.
        "js_runtimes": {"deno": {}, "node": {}},
    }
    if cfg.proxy:
        opts["proxy"] = cfg.proxy
    if cfg.cookies_file:
        opts["cookiefile"] = cfg.cookies_file
    return opts


def probe(url: str, cfg: Config) -> SourceInfo:
    """Lấy metadata mà không tải bất cứ byte media nào."""
    import yt_dlp

    with yt_dlp.YoutubeDL({**_base_opts(cfg), "skip_download": True}) as ydl:
        info = ydl.extract_info(url, download=False)

    subs = {**(info.get("subtitles") or {}), **(info.get("automatic_captions") or {})}
    return SourceInfo(
        url=url,
        title=info.get("title") or "untitled",
        duration=float(info.get("duration") or 0.0),
        uploader=info.get("uploader") or "",
        has_subtitles=bool(subs),
        extractor=info.get("extractor") or "",
    )


def _cue_blocks(text: str) -> list[tuple[re.Match[str], list[str]]]:
    """Tách file VTT/SRT thành các cue: (mốc thời gian đã khớp, các dòng chữ).

    Mọi thứ sau mốc thời gian TRÊN CÙNG DÒNG đó là cue settings, không phải chữ
    (ví dụ `align:start position:0%`), nên bị bỏ.
    """
    blocks: list[tuple[re.Match[str], list[str]]] = []
    lines = text.splitlines()

    for i, line in enumerate(lines):
        match = _TIMESTAMP.search(line)
        if match:
            blocks.append((match, []))
            continue
        stripped = line.strip()
        if not stripped or not blocks:
            continue
        # SRT đánh số thứ tự cue trên một dòng riêng ngay TRƯỚC mốc thời gian.
        # Không bỏ thì con số đó dính vào cuối cue liền trước thành chữ.
        if stripped.isdigit() and _next_line_is_timestamp(lines, i + 1):
            continue
        blocks[-1][1].append(line)

    return blocks


def _next_line_is_timestamp(lines: list[str], index: int) -> bool:
    for line in lines[index:]:
        if not line.strip():
            continue
        return _TIMESTAMP.search(line) is not None
    return False


def _parse_vtt(text: str) -> list[TranscriptSegment]:
    """Parser VTT/SRT tối giản, đủ dùng cho việc định vị khoảnh khắc.

    Hai chỗ phải xử lý riêng cho phụ đề TỰ ĐỘNG của YouTube — đây là nguồn
    transcript hay gặp nhất, và cả hai lỗi đều burn thẳng vào clip:

    1. Dòng mốc thời gian còn kèm cue settings:
           00:00:00.160 --> 00:00:02.230 align:start position:0%
       Cắt ngay sau mốc thời gian thì "align:start position:0%" thành nội dung
       phụ đề. Nó đã hiện thật trên clip. Nên phải bỏ trọn dòng mốc thời gian.

    2. Phụ đề chạy kiểu cuộn: mỗi cue lặp lại dòng cuối của cue trước rồi mới
       thêm dòng mới. Chỉ so cả cue với cả cue trước (bản cũ) thì không bắt được
       — phải khử trùng lặp theo TỪNG DÒNG.

    3. Chữ bị escape kiểu XML. Nguồn của YouTube là XML, nên dấu đổi người nói
       `>>` tới đây dưới dạng `&gt;&gt;`, và `&` thành `&amp;`. Không giải mã
       lại thì người xem đọc đúng chữ "&gt;&gt;" trên màn hình — đã hiện thật
       trên clip. Nó còn đi vào .srt, .txt và cả transcript mà LLM đọc để chọn
       khoảnh khắc.

       Giải mã SAU khi bỏ tag, không phải trước: `&lt;c&gt;` mà tác giả cố ý
       viết sẽ thành `<c>` và bị bộ lọc tag ăn mất.
    """
    segments: list[TranscriptSegment] = []
    seen_lines: list[str] = []

    # Cắt cue theo DÒNG MỐC THỜI GIAN, không theo dòng trống. Dòng trống là ranh
    # giới cue theo chuẩn, nhưng YouTube chèn những dòng chỉ có đúng một dấu cách
    # vào GIỮA cue; tách theo dòng trống thì phần chữ của cue đó rơi ra thành một
    # khối không có mốc thời gian và bị bỏ luôn — chữ dòng đầu mỗi lượt cuộn mất
    # trắng, chỉ được nhặt lại ở cue kế tiếp nên hiện sai nhịp.
    for block in _cue_blocks(text):
        match, raw_lines = block
        h1, m1, s1, ms1, h2, m2, s2, ms2 = (int(g) for g in match.groups())
        start = h1 * 3600 + m1 * 60 + s1 + ms1 / 1000
        end = h2 * 3600 + m2 * 60 + s2 + ms2 / 1000

        fresh: list[str] = []
        fresh_raw: list[str] = []
        for raw in raw_lines:
            line = html.unescape(_TAGS.sub("", raw)).strip()
            if not line:
                continue
            # So với vài dòng gần nhất: cue cuộn lặp lại dòng trước liền kề, nhưng
            # cue "chớp" 10ms xen giữa có thể đẩy dòng lặp ra xa hơn một bậc.
            if line in seen_lines[-2:]:
                continue
            fresh.append(line)
            fresh_raw.append(raw)
            seen_lines.append(line)

        content = " ".join(fresh).strip()
        # Chỉ nhận mốc từng từ khi cue có đúng một dòng mới mang mốc — dạng của
        # YouTube tự động. Phụ đề người làm không có mốc: giữ cách cũ.
        words = _inline_words(fresh_raw[0], start, end) if len(fresh_raw) == 1 else None
        if not content:
            # Cue không mang chữ mới (rất nhiều trong phụ đề cuộn): kéo dài đoạn
            # trước cho khớp thời gian thay vì sinh ra một đoạn rỗng.
            if segments:
                segments[-1].end = max(segments[-1].end, end)
            continue

        segments.append(TranscriptSegment(start=start, end=end, text=content, words=words))

    return segments


def _pick_subtitles(workdir: Path, lang: str) -> list[Path]:
    """File phụ đề theo thứ tự ưu tiên: người làm trước, tự động sau.

    yt-dlp ghi phụ đề người làm vào `subs.<lang>.vtt` khi có (chỉ khi không có
    mới dùng bản tự động cho tên đó), còn `<lang>-orig` luôn là bản nhận dạng
    tự động. `sorted()` xếp `subs.en-orig.vtt` TRƯỚC `subs.en.vtt` vì `-` < `.`,
    nên clip TED có phụ đề chuẩn từng bị burn bản tự động: chữ thường, "uh",
    sai tên riêng (UAT production 29/09).
    """
    files = sorted(workdir.glob("subs*.vtt"))
    preferred = [f"subs.{lang}.vtt", "subs.en.vtt", f"subs.{lang}-orig.vtt", "subs.en-orig.vtt"]
    rank = {name: index for index, name in reversed(list(enumerate(preferred)))}
    return sorted(files, key=lambda path: (rank.get(path.name, len(preferred)), path.name))


def fetch_subtitles(url: str, cfg: Config, workdir: Path, lang: str = "en") -> Transcript | None:
    """Thử lấy phụ đề có sẵn. Được thì bỏ hẳn bước Whisper — nhanh hơn và miễn phí."""
    import yt_dlp

    opts = {
        **_base_opts(cfg),
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": [lang, f"{lang}-orig", "en"],
        "subtitlesformat": "vtt",
        "outtmpl": str(workdir / "subs.%(ext)s"),
    }

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
    except Exception as exc:  # noqa: BLE001 - phụ đề là tùy chọn, thiếu thì đi tiếp
        log.debug("Không lấy được phụ đề: %s", exc)
        return None

    files = _pick_subtitles(workdir, lang)
    if not files:
        return None

    segments = _parse_vtt(files[0].read_text(encoding="utf-8", errors="replace"))
    if len(segments) < 5:
        log.debug("Phụ đề quá ngắn (%d đoạn), bỏ qua.", len(segments))
        return None

    log.info("Dùng phụ đề có sẵn: %d đoạn (bỏ qua Whisper)", len(segments))
    return Transcript(segments=segments, language=lang, source="subs")


def download_audio(url: str, cfg: Config, workdir: Path) -> Path:
    """Tải luồng audio gốc; quá trần upload thì hạ về mono 16kHz bằng `extract_audio`.

    Trước đây luồng m4a 128k stereo đi thẳng tới Groq: video 54 phút ra ~52MB,
    quá trần 25MB, và người dùng chỉ thấy lỗi chung. Hạ bằng cùng lệnh với nhánh
    local để hai đường không lệch nhau.
    """
    import yt_dlp

    opts = {
        **_base_opts(cfg),
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "outtmpl": str(workdir / "audio_src.%(ext)s"),
    }

    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])

    candidates = [p for p in workdir.glob("audio_src.*") if p.suffix != ".part"]
    if not candidates:
        raise RuntimeError("Audio download failed: no output file.")
    raw = candidates[0]
    # Luồng gốc đã lọt trần thì gửi thẳng: hạ về mono tốn ~23s cho 54 phút
    # (đo trên sandbox 4 lõi), không đáng trả cho video ngắn.
    if raw.suffix == ".m4a" and raw.stat().st_size <= TRANSCRIBE_MAX_BYTES:
        return raw
    try:
        return extract_audio(raw, workdir / "audio.m4a")
    finally:
        raw.unlink(missing_ok=True)


# Đệm hai đầu mỗi đoạn để bù sai lệch keyframe. Bước render cắt chính xác lại sau.
SECTION_PAD = 1.0

# Chọn định dạng cho bước tải đoạn. Ba ràng buộc, mỗi cái vì một lý do khác nhau:
#
#   protocol^=https  — BẮT BUỘC. YouTube trả cả bản HLS (m3u8, ví dụ itag 616
#       "Premium") lẫn bản DASH tải qua https. `bestvideo` hay chấm phải bản HLS
#       vì bitrate cao hơn, nhưng cắt theo khoảng thời gian trên playlist HLS thì
#       ffmpeg ra ĐÚNG 0 FRAME video — file đầu ra chỉ còn tiếng, và lỗi chỉ lộ
#       ra ở bước render sau đó ("không tìm thấy luồng video").
#   vcodec^=avc1     — H.264 thay vì VP9/AV1: decode nhẹ hơn nhiều ở bước cắt lại,
#       và chắc chắn có decode phần cứng.
#   height<=1080     — đầu ra là 1080x1920, nguồn cao hơn chỉ tốn băng thông.
#
# Các nhánh sau dấu '/' là mức lùi dần khi nguồn không có đủ định dạng.
SECTION_FORMAT = (
    "bestvideo[height<=1080][vcodec^=avc1][protocol^=https]"
    "+bestaudio[protocol^=https][ext=m4a]"
    "/bestvideo[height<=1080][protocol^=https]+bestaudio[protocol^=https]"
    "/best[height<=1080][protocol^=https]"
    "/best[height<=1080]"
    "/best"
)


# Lần thử cho MỖI đoạn. Proxy sticky của IPRoyal có lúc rơi IP giữa chừng: link
# googlevideo đã ký theo IP cũ trả 403, ffmpeg thoát mã 1, lần trích xuất lại dính
# "Sign in to confirm you're not a bot". Job hỏng SAU khi đã trả tiền LLM chọn
# khoảnh khắc; user bấm Retry thì qua (UAT production 29/09). Thử lại ngay với
# session mới (IP mới) rẻ hơn nhiều so với bắt user làm lại cả job.
SECTION_ATTEMPTS = 3

# Lỗi đáng thử lại: mạng, IP bị chặn, ffmpeg đứt. Video riêng tư/đã xoá thì không.
_RETRYABLE = re.compile(
    r"ffmpeg exited|HTTP Error (403|429|5\d\d)|not a bot|timed out|Connection|"
    r"Unable to download|Read timed out|IncompleteRead|Tunnel connection failed",
    re.IGNORECASE,
)


def _retryable(message: str) -> bool:
    return bool(_RETRYABLE.search(message)) and "402" not in message and "407" not in message


def _download_one_section(
    url: str, index: int, moment: Moment, cfg: Config, workdir: Path
) -> tuple[Path, float]:
    import yt_dlp
    from yt_dlp.utils import download_range_func

    start = max(0.0, moment.start - SECTION_PAD)
    lead_in = moment.start - start
    end = moment.end + SECTION_PAD
    out = workdir / f"section_{index:02d}.mp4"

    opts = {
        **_base_opts(cfg),
        "format": SECTION_FORMAT,
        "outtmpl": str(workdir / f"section_{index:02d}.%(ext)s"),
        "download_ranges": download_range_func(None, [(start, end)]),
        "force_keyframes_at_cuts": True,
        "merge_output_format": "mp4",
    }

    for attempt in range(SECTION_ATTEMPTS):
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])
            break
        except yt_dlp.utils.DownloadError as exc:
            if attempt + 1 >= SECTION_ATTEMPTS or not _retryable(str(exc)):
                raise
            log.warning(
                "Tải đoạn %d lỗi (%s), thử lại với session proxy mới", index, str(exc)[:160]
            )
            for leftover in workdir.glob(f"section_{index:02d}.*"):
                leftover.unlink(missing_ok=True)
            opts = {**opts, "proxy": fresh_proxy_session(opts.get("proxy"))}

    if not out.exists():
        found = [p for p in sorted(workdir.glob(f"section_{index:02d}.*")) if p.suffix != ".part"]
        if not found:
            raise RuntimeError(
                f"Failed to download segment {index} "
                f"({moment.start:.1f}s–{moment.end:.1f}s)"
            )
        out = found[0]

    # Kiểm ngay tại đây thay vì để bước render vấp phải. Đoạn tải về có thể có
    # file, đúng dung lượng, mà bên trong không có frame video nào — xem ghi chú
    # ở SECTION_FORMAT. Bắt sớm thì thông báo mới chỉ đúng chỗ hỏng.
    info = probe_file(str(out))
    if info.width == 0 or info.height == 0:
        raise RuntimeError(
            f"Segment {index} downloaded with no video frames "
            f"({moment.start:.1f}s–{moment.end:.1f}s). Usually the source only offers "
            "HLS — try updating yt-dlp."
        )

    return out, lead_in


def download_sections(
    url: str, moments: list[Moment], cfg: Config, workdir: Path
) -> list[tuple[Path, float]]:
    """Chỉ tải đúng các đoạn video đã chọn.

    Mỗi khoảnh khắc tải riêng một lần để ánh xạ đầu ra rõ ràng.

    Chạy SONG SONG. Đo trên video phỏng vấn 54 phút, 5 clip: tải tuần tự mất
    139.8s trên tổng 197.8s — 71% thời gian của cả pipeline, và là thứ duy nhất
    đẩy job vượt ngân sách 3 phút ở ARCHITECTURE.md §2. Bước này phần lớn là chờ
    mạng cộng một lượt encode lại của ffmpeg (yt-dlp cần `force_keyframes_at_cuts`
    để cắt đúng chỗ), nên chạy song song ăn ngay.

    Dùng chung hạn mức `max_parallel` với bước render vì cùng một lý do: mỗi tiến
    trình ffmpeg khoảng 400MB, đây là cái chốt giữ RAM.

    Trả về danh sách (đường_dẫn, lead_in) — `lead_in` là số giây thừa ở đầu file
    do phần đệm, để bước render biết cắt từ đâu.
    """
    workers = max(1, min(cfg.max_parallel, len(moments)))
    log.info("Tải %d đoạn, %d luồng song song", len(moments), workers)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(
            pool.map(
                lambda pair: _download_one_section(url, pair[0], pair[1], cfg, workdir),
                enumerate(moments),
            )
        )


def download_full(url: str, cfg: Config, workdir: Path) -> Path:
    """Tải NGUYÊN video, không cắt, không encode lại.

    Dùng cho chế độ "Don't clip": người dùng chỉ muốn cầm file về. Không
    `download_ranges` nên yt-dlp không phải encode lại để cắt đúng keyframe —
    bước này thuần chờ mạng, nằm ngoài ngân sách RAM/thời gian của pipeline
    clip (ARCHITECTURE.md §2).

    Dùng lại `SECTION_FORMAT`: ràng buộc `protocol^=https` vẫn bắt buộc vì cùng
    một lý do, luồng HLS của YouTube cho ra file không có frame video nào.
    """
    import yt_dlp

    out = workdir / "full.mp4"
    opts = {
        **_base_opts(cfg),
        "format": SECTION_FORMAT,
        "outtmpl": str(workdir / "full.%(ext)s"),
        "merge_output_format": "mp4",
    }

    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])

    if not out.exists():
        found = [p for p in sorted(workdir.glob("full.*")) if p.suffix != ".part"]
        if not found:
            raise RuntimeError("Failed to download this video.")
        out = found[0]

    # Cùng cái bẫy của `_download_one_section`: file có, dung lượng đúng, bên
    # trong không có frame video nào. Bắt ở đây thì lỗi chỉ đúng chỗ hỏng.
    info = probe_file(str(out))
    if info.width == 0 or info.height == 0:
        raise RuntimeError(
            "This video downloaded with no video frames. Usually the source only "
            "offers HLS — try updating yt-dlp."
        )

    return out
