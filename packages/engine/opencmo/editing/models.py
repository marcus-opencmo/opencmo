"""Hợp đồng dữ liệu chỉnh sửa clip.

Mọi mốc thời gian trong revision tính theo VIDEO NGUỒN, không theo clip: trim
lại thì phần sửa chữ vẫn đúng chỗ mà không phải dời, và artifact AI gốc
(moment, transcript) không bao giờ bị ghi đè. Revision bất biến; export chỉ
nhận revision đã lưu.

JSON mẫu dùng chung với web nằm ở `tests/contracts/clipping/`; kiểu TypeScript
tương ứng ở `apps/web/lib/clipping-types.ts`.

Message của `SettingsError` là tiếng Anh vì API local trả thẳng về UI.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any

from ..models import Transcript, TranscriptSegment, Word

ARTIFACT_VERSION = 1
# Tăng khi cách render đổi mà settings không đổi (font, bitrate…): export cũ và
# mới của cùng một revision khi đó không còn là cùng một file.
#
# 2 -> 3: `settings_hash` chuyển sang JSON chuẩn hoá theo RFC 8785 (JCS). Hash
# của mọi revision cũ vì thế đổi — đó là lý do phải tăng số này, nếu không thì
# một export cũ và một export mới cùng mang một hash mà nội dung khác nhau.
#
# 3 -> 4: đường editor bắt đầu đóng watermark (`editing/render.py` trước đây bỏ
# qua `cfg.watermark`). Cùng một revision giờ ra file khác trước.
#
# Từ R1 (07/10/2026) không còn export theo settings: `clips.settings` chỉ là
# settings gốc mà bộ sinh project editor đọc, nên tăng số này chỉ đổi hash đã
# lưu, không làm hỏng bản xuất nào.
RENDER_PROFILE_VERSION = 4

ASPECTS = ("9:16", "1:1", "16:9")
LAYOUTS = ("fill", "fit", "manual")

MIN_CLIP_SECONDS = 1.0
# Shorts tối đa 3 phút; clip dài hơn từ podcast hiếm khi còn là "clip".
MAX_CLIP_SECONDS = 180.0
MAX_HEADLINE = 120
MAX_EDIT_TEXT = 500
MAX_EDITS = 2000
# Lớp chữ tự do. Trần thấp có chủ ý: đây là clip dọc dài tối đa 3 phút, không
# phải một trình dựng motion graphics. Mỗi lớp còn tốn một dòng `Style:` trong
# file .ass.
MAX_TEXTS = 10

# Khoá đã bỏ nhưng còn nằm trong `clips.settings` đã lưu (ghi một lần, không sửa):
# nhận rồi bỏ qua, để dữ liệu cũ không chết ở "Unknown clip setting".
# `caption_preset` (R4): kiểu phụ đề chọn trong editor; pipeline đốt một kiểu cố định.
LEGACY_KEYS = frozenset({"caption_preset"})

_KEYS = frozenset(
    {
        "source_start",
        "source_end",
        "aspect",
        "layout",
        "focus_x",
        "captions",
        "headline",
        "texts",
        "text_edits",
        "cuts", "broll", "caption_style", "headline_style",
    }
)
_EDIT_KEYS = frozenset({"start", "end", "text"})
_TEXT_KEYS = frozenset({"text", "start", "end", "style"})
# B-roll trỏ tới asset bằng ID. Web dùng uuid của `media_assets`; bản local dùng
# tên file trong thư mục media của workspace. Chấp nhận cả hai hình dạng — cùng
# một revision phải đọc được ở cả hai nơi — nhưng KHÔNG chấp nhận gì khác: dấu
# `/`, `..` hay một URL lọt vào đây là một đường dẫn tuỳ ý do client chọn.
_ASSET_ID = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    r"|[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+"
)
# Nới cho sai số làm tròn của ffprobe/LLM ở mốc cuối video.
_END_SLACK = 0.001


class SettingsError(ValueError):
    """Draft không hợp lệ."""


@dataclass(frozen=True)
class TextEdit:
    start: float
    end: float
    text: str


@dataclass(frozen=True)
class RevisionSettings:
    source_start: float
    source_end: float
    aspect: str = "9:16"
    layout: str = "fill"
    focus_x: float | None = None
    captions: bool = True
    # Đường CŨ: một dòng tiêu đề cố định 0–3 giây. Giữ lại vĩnh viễn vì
    # `clips.settings` ghi một lần — bỏ khoá này khỏi allowlist là mọi clip đã
    # lưu chết ở `parse_settings` với "Unknown clip setting: headline.".
    headline: str = ""
    # Đường MỚI: N lớp chữ, mỗi lớp có khoảng thời gian và style riêng.
    texts: tuple[dict, ...] = ()
    text_edits: tuple[TextEdit, ...] = ()
    cuts: tuple[dict, ...] = ()
    broll: tuple[dict, ...] = ()
    caption_style: dict | None = None
    headline_style: dict | None = None

    @property
    def duration(self) -> float:
        return sum(c["end"] - c["start"] for c in self.cuts) if self.cuts else self.source_end - self.source_start

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["text_edits"] = [asdict(edit) for edit in self.text_edits]
        # Rỗng thì BỎ HẲN khoá, không phát `[]`. Đây là điều kiện để revision cũ
        # giữ nguyên canonical JSON — và giữ nguyên hash — sau khi thêm `texts`.
        for key in ("texts", "cuts", "broll"):
            if value[key]:
                value[key] = list(value[key])
            else:
                del value[key]
        for key in ("caption_style", "headline_style"):
            if value[key] is None:
                del value[key]
        return value


HEADLINE_SECONDS = 3.0
# Cỡ tiêu đề trên khung 1080×1920 — khớp `Style: Headline` cũ của kiểu phụ đề đốt duy nhất.
HEADLINE_SIZE = 94
# Khung tham chiếu của cỡ chữ: `_text_layer_style` nhân lại theo cạnh dài thật.
HEADLINE_FRAME_HEIGHT = 1920
# Bề rộng vùng chữ trên khung 9:16, sau hai lề 8% của `_text_layer_style`.
HEADLINE_TEXT_WIDTH = 1080 * (1 - 2 * 0.08)
HEADLINE_LINE_HEIGHT = 1.15
# Mép trên tối thiểu, tính theo chiều cao khung.
HEADLINE_TOP = 0.06
# Tâm dọc mặc định: tiêu đề ngắn giữ đúng chỗ cũ, chỉ tiêu đề dài mới bị đẩy xuống.
HEADLINE_Y = 0.12


def _headline_y(text: str, size: int) -> float:
    """Tâm dọc của khối tiêu đề, đủ thấp để dòng đầu không rơi khỏi mép trên.

    Lớp chữ neo TÂM (`\\an5\\pos`), nên khối càng nhiều dòng càng mọc NGƯỢC lên
    trên. Hook do LLM viết dài tới `MAX_HEADLINE` ký tự: đo thật trên khung
    1080×1920, một hook 76 ký tự xuống 5 dòng và neo cố định ở `y=0.12` cắt mất
    dòng đầu khỏi khung — file vẫn ra, vẫn mở được, chỉ là thiếu chữ. Đúng kiểu
    lỗi im lặng mà `CLAUDE.md` bắt phải mở ảnh ra mới thấy.

    Số dòng phải ƯỚC LƯỢNG vì chỉ libass mới biết bề rộng chữ thật lúc render.
    Vùng chữ rộng `width·(1 - 2·0.08)` theo lề ở `_text_layer_style`, và DejaVu
    Sans đậm chiếm ~0.54·size mỗi ký tự. Ước thừa thì tiêu đề chỉ nằm thấp hơn
    cần thiết vài chục pixel; ước thiếu thì chữ bay khỏi khung — nên làm tròn LÊN.

    Tiêu đề dài trông vẫn nặng nề; đó là việc của prompt trong `steps/select.py`,
    không phải của hàm này. Ở đây chỉ lo chữ nằm TRONG khung.
    """
    per_line = max(1.0, HEADLINE_TEXT_WIDTH / (0.54 * size))
    lines = math.ceil(len(text) / per_line)
    block = lines * HEADLINE_LINE_HEIGHT * size
    return round(max(HEADLINE_Y, HEADLINE_TOP + block / 2 / HEADLINE_FRAME_HEIGHT), 4)


def clip_headline(hook: str, *, duration: float) -> tuple[dict, ...]:
    """Hook do LLM viết thành lớp chữ mở đầu clip.

    MỘT nguồn duy nhất cho hai chỗ phải nói cùng một thứ: `steps/render.py` burn
    nó vào clip giao khách, và `default_settings` đặt nó vào revision đầu tiên.
    Lệch nhau thì mở editor ra thấy khung khác clip vừa tải về — và không có
    cách nào để người dùng biết bên nào đúng.

    Cỡ chữ khớp `Style: Headline` cũ (`captions.py`): `max(w,h)·font_ratio·1.1`
    trên khung 1080×1920.
    """
    text = " ".join(str(hook or "").split())[:MAX_HEADLINE]
    if not text:
        return ()
    end = min(HEADLINE_SECONDS, duration)
    if end < 0.1:
        return ()
    size = HEADLINE_SIZE
    return (
        {
            "text": text,
            "start": 0.0,
            "end": end,
            "style": {
                "font": "DejaVu Sans",
                "size": size,
                "color": "#ffffff",
                "bold": True,
                "x": 0.5,
                "y": _headline_y(text, size),
            },
        },
    )


def default_settings(
    start: float,
    end: float,
    *,
    aspect: str = "9:16",
    layout: str = "fill",
    focus_x: float | None = None,
    captions: bool = True,
    hook: str = "",
) -> RevisionSettings:
    """Revision đầu tiên của clip: đúng khoảnh khắc và ĐÚNG khung đã render.

    Mặc định ở đây không phải "đẹp nhất" mà là "giống hệt file vừa giao". Mở
    editor ra thấy khung khác clip vừa tải về là người dùng mất lòng tin vào cả
    hai — và không có cách nào để họ biết bên nào đúng.
    """
    return RevisionSettings(
        source_start=float(start),
        source_end=float(end),
        aspect=aspect,
        layout=layout,
        focus_x=focus_x,
        captions=captions,
        texts=clip_headline(hook, duration=float(end) - float(start)),
    )


def _is_number(value: Any) -> bool:
    # bool là int trong Python; `True` không phải một mốc thời gian.
    return (
        not isinstance(value, bool)
        and isinstance(value, int | float)
        and math.isfinite(value)
    )


def _time(value: Any) -> float:
    if not _is_number(value):
        raise SettingsError("Clip times must be finite numbers.")
    return float(value)


def _text(value: Any, limit: int, message: str) -> str:
    if not isinstance(value, str) or len(value) > limit:
        raise SettingsError(message)
    # Ký tự điều khiển phá cú pháp file .ass và không có nghĩa trên màn hình.
    if any(unicodedata.category(ch) == "Cc" for ch in value):
        raise SettingsError("Text cannot contain control characters.")
    return value


def _choice(value: Any, allowed: tuple[str, ...], message: str) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise SettingsError(message)
    return value


def parse_settings(raw: Any, *, source_duration: float) -> RevisionSettings:
    """Kiểm và chuẩn hoá settings do client gửi.

    Khoá lạ bị từ chối thay vì bỏ qua: không có đường nào để client lén đưa
    đường dẫn file hay URL vào revision.
    """
    if not isinstance(raw, dict):
        raise SettingsError("Clip settings must be an object.")
    raw = {key: value for key, value in raw.items() if key not in LEGACY_KEYS}
    unknown = sorted(set(raw) - _KEYS)
    if unknown:
        raise SettingsError(f"Unknown clip setting: {str(unknown[0])[:40]}.")

    start = _time(raw.get("source_start"))
    end = _time(raw.get("source_end"))
    if not 0 <= start < end <= source_duration + _END_SLACK:
        raise SettingsError("Clip start and end must be inside the source video.")
    if not MIN_CLIP_SECONDS <= end - start <= MAX_CLIP_SECONDS:
        raise SettingsError("Clips must be between 1 and 180 seconds long.")

    aspect = _choice(raw.get("aspect", "9:16"), ASPECTS, "Unsupported aspect ratio.")
    layout = _choice(raw.get("layout", "fill"), LAYOUTS, "Unsupported frame layout.")

    focus_x = raw.get("focus_x")
    if focus_x is not None and not (_is_number(focus_x) and 0 <= focus_x <= 1):
        raise SettingsError("The focus point must be inside the frame.")
    if layout == "manual" and focus_x is None:
        raise SettingsError("Pick a focus point for manual framing.")

    captions = raw.get("captions", True)
    if not isinstance(captions, bool):
        raise SettingsError("Captions must be on or off.")
    headline = _text(
        raw.get("headline", ""), MAX_HEADLINE, "Keep the headline under 120 characters."
    )

    edits_raw = raw.get("text_edits", [])
    if not isinstance(edits_raw, list) or len(edits_raw) > MAX_EDITS:
        raise SettingsError("Too many caption edits.")
    edits = []
    for item in edits_raw:
        if not isinstance(item, dict) or set(item) != _EDIT_KEYS:
            raise SettingsError("Each caption edit needs a start, an end and text.")
        edit_start, edit_end = _time(item["start"]), _time(item["end"])
        if not 0 <= edit_start < edit_end <= source_duration + _END_SLACK:
            raise SettingsError("Each caption edit must be inside the source video.")
        text = _text(item["text"], MAX_EDIT_TEXT, "Keep each caption edit under 500 characters.")
        edits.append(TextEdit(edit_start, edit_end, text))

    cuts = raw.get("cuts", [])
    if not isinstance(cuts, list) or len(cuts) > 40:
        raise SettingsError("Use at most 40 video sections.")
    for cut in cuts:
        if not isinstance(cut, dict) or set(cut) != {"start", "end"}:
            raise SettingsError("Each section needs a start and end.")
        if not start <= _time(cut["start"]) < _time(cut["end"]) <= end:
            raise SettingsError("Sections must stay inside the clip source range.")
        if cut["end"] - cut["start"] < 0.1:
            raise SettingsError("Each section must last at least 0.1 seconds.")
    duration = sum(c["end"] - c["start"] for c in cuts) if cuts else end - start
    if not 1 <= duration <= 180:
        raise SettingsError("The timeline must be between 1 and 180 seconds long.")

    texts_raw = raw.get("texts", [])
    if not isinstance(texts_raw, list) or len(texts_raw) > MAX_TEXTS:
        raise SettingsError("Use at most 10 text layers.")
    # Hai đường cùng lúc thì không biết đường nào thắng — và người dùng sẽ thấy
    # chữ hiện hai lần. UI mới chỉ ghi `texts`; `headline` chỉ tới từ revision cũ.
    if texts_raw and headline:
        raise SettingsError("Use either a headline or text layers, not both.")
    texts = []
    for item in texts_raw:
        if not isinstance(item, dict) or set(item) != _TEXT_KEYS:
            raise SettingsError("Invalid text layer.")
        # `.strip()` KHÔNG phải chuyện thẩm mỹ: `settings-schema.ts` cắt lề rồi
        # mới lưu, nên bỏ nó ở đây là hai bên ra hai chuỗi canonical JSON khác
        # nhau cho cùng một input — tức hai `settings_hash` khác nhau, đúng thứ
        # `tests/contracts/settings/` sinh ra để chặn. Trần 120 vẫn đo trên
        # chuỗi GỐC, giống bên kia.
        body = _text(item["text"], MAX_HEADLINE, "Keep each text under 120 characters.").strip()
        if not body:
            raise SettingsError("A text layer cannot be empty.")
        # Tên riêng, KHÔNG dùng lại `start`/`end`: hai biến đó đang giữ
        # `source_start`/`source_end` của cả clip, và đè lên chúng ở đây làm clip
        # bị cắt về đúng độ dài lớp chữ. Đã xảy ra thật, và 370 test vẫn xanh —
        # chỉ render ra file rồi mở xem mới thấy.
        text_start = _time(item["start"])
        text_end = _time(item["end"])
        # Mốc tính trên TIMELINE (sau khi cắt ghép), không phải trên video nguồn
        # — người dùng đặt chữ ở giây thứ mấy của clip, không phải của bản gốc.
        if (
            not (0 <= text_start < text_end)
            or text_end - text_start < 0.1
            or text_end > duration + 0.001
        ):
            raise SettingsError("Text must stay inside the timeline.")
        # Style bắt buộc: xem `TextLayer` ở captions.py. Không có nhánh "chưa
        # chỉnh style" thì preview và file không thể neo chữ khác nhau.
        texts.append(
            {
                "text": body,
                "start": text_start,
                "end": text_end,
                "style": parse_text_style(item["style"], required=True),
            }
        )

    broll = raw.get("broll", [])
    if not isinstance(broll, list) or len(broll) > 20:
        raise SettingsError("Use at most 20 B-roll sections.")
    for item in broll:
        if not isinstance(item, dict) or set(item) != {"asset_id", "at", "start", "end"}:
            raise SettingsError("Invalid B-roll section.")
        if not isinstance(item["asset_id"], str) or not _ASSET_ID.fullmatch(item["asset_id"]):
            raise SettingsError("Invalid media ID.")
        a, b, at = _time(item["start"]), _time(item["end"]), _time(item["at"])
        if not 0 <= a < b or b - a < 0.1 or not 0 <= at < at + b - a <= duration + 0.001:
            raise SettingsError("B-roll must stay inside the timeline.")

    return RevisionSettings(
        source_start=start,
        source_end=end,
        aspect=aspect,
        layout=layout,
        focus_x=None if focus_x is None else float(focus_x),
        captions=captions,
        headline=headline,
        # KHÔNG sort: thứ tự lớp chữ là thứ tự vẽ. `text_edits` sort được vì hai
        # edit khác thứ tự cho cùng một kết quả; hai lớp chữ thì không.
        texts=tuple(texts),
        text_edits=tuple(sorted(edits, key=lambda e: (e.start, e.end))),
        cuts=tuple(cuts), broll=tuple(broll),
        caption_style=parse_text_style(raw.get("caption_style")),
        headline_style=parse_text_style(raw.get("headline_style")),
    )


def parse_text_style(raw: Any, *, required: bool = False) -> dict | None:
    if raw is None:
        if required:
            raise SettingsError("Text style needs font, size, color, bold and position.")
        return None
    if not isinstance(raw, dict) or set(raw) != {"font", "size", "color", "bold", "x", "y"}:
        raise SettingsError("Text style needs font, size, color, bold and position.")
    if raw["font"] not in ("DejaVu Sans", "DejaVu Serif", "DejaVu Sans Mono"):
        raise SettingsError("Choose a supported font.")
    if not _is_number(raw["size"]) or not 24 <= raw["size"] <= 160:
        raise SettingsError("Font size must be between 24 and 160.")
    if not isinstance(raw["bold"], bool) or not isinstance(raw["color"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", raw["color"]):
        raise SettingsError("Choose a valid text color and weight.")
    if any(not _is_number(raw[k]) or not 0.08 <= raw[k] <= 0.92 for k in ("x", "y")):
        raise SettingsError("Keep text inside the canvas safe area.")
    return dict(raw)


def _js_number(value: float) -> str:
    """Số theo đúng `Number::toString` của ECMAScript (RFC 8785 §3.2.2.3).

    Vì sao không dùng `repr()`: Python in `2.0` còn JavaScript in `2`, và hai
    ngôn ngữ đổi sang ký hiệu mũ ở hai ngưỡng khác nhau (Python từ 1e16, JS từ
    1e21). Hai phía sẽ ra hai chuỗi khác nhau cho cùng một con số, hai hash khác
    nhau, và việc khử trùng preview/export mất tác dụng.
    """
    if isinstance(value, bool) or not _is_number(value):
        raise SettingsError("Clip settings contain a value that cannot be saved.")
    number = float(value)
    if number == 0:
        return "0"  # JSON không phân biệt 0 và -0; JS in cả hai là "0".

    sign = "-" if number < 0 else ""
    text = repr(abs(number))

    if "e" in text:
        mantissa, _, exponent = text.partition("e")
        power = int(exponent)
    else:
        mantissa, power = text, 0
    whole, _, fraction = mantissa.partition(".")

    raw = whole + fraction
    stripped = raw.lstrip("0")
    # n: vị trí dấu phẩy so với chuỗi chữ số có nghĩa; s: chữ số có nghĩa.
    n = len(whole) + power - (len(raw) - len(stripped))
    s = stripped.rstrip("0") or "0"
    k = len(s)

    if k <= n <= 21:
        return sign + s + "0" * (n - k)
    if 0 < n <= 21:
        return sign + s[:n] + "." + s[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * -n + s
    exponent_part = f"e{'+' if n - 1 >= 0 else '-'}{abs(n - 1)}"
    return sign + (s if k == 1 else s[0] + "." + s[1:]) + exponent_part


def canonical_json(value: Any) -> str:
    """JSON chuẩn hoá theo RFC 8785 (JCS) — đầu vào của hàm băm.

    Khoá sắp theo đơn vị mã UTF-16 chứ không theo điểm mã: một emoji (U+1F600)
    là cặp thay thế trong UTF-16 nên nó đứng TRƯỚC U+FFFD ở JavaScript, còn
    `sorted()` của Python lại xếp sau. Khác biệt đó chỉ lộ ra khi có người đặt
    emoji làm khoá — tức là đúng lúc không ai còn nhớ tới nó nữa.
    """
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int | float):
        return _js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: str(kv[0]).encode("utf-16-be"))
        return "{" + ",".join(
            json.dumps(str(key), ensure_ascii=False, separators=(",", ":"))
            + ":"
            + canonical_json(item)
            for key, item in items
        ) + "}"
    raise SettingsError("Clip settings contain a value that cannot be saved.")


def settings_hash(settings: dict[str, Any]) -> str:
    payload = canonical_json(
        {"render_profile": RENDER_PROFILE_VERSION, "settings": settings}
    )
    return hashlib.sha256(payload.encode()).hexdigest()


# ------------------------------------------------------------- transcript


def transcript_to_dict(transcript: Transcript) -> dict[str, Any]:
    return {
        "version": ARTIFACT_VERSION,
        "language": transcript.language,
        "source": transcript.source,
        "segments": [asdict(segment) for segment in transcript.segments],
    }


def transcript_from_dict(data: dict[str, Any]) -> Transcript:
    if data.get("version") != ARTIFACT_VERSION:
        raise ValueError(f"Unsupported transcript artifact version: {data.get('version')!r}")
    return Transcript(
        segments=[
            TranscriptSegment(
                start=float(segment["start"]),
                end=float(segment["end"]),
                text=segment["text"],
                words=[
                    Word(start=float(w["start"]), end=float(w["end"]), text=w["text"])
                    for w in segment["words"]
                ]
                if segment.get("words")
                else None,
            )
            for segment in data["segments"]
        ],
        language=data.get("language") or "en",
        source=data.get("source") or "whisper",
    )


def _respace_words(text: str, start: float, end: float) -> list[Word]:
    """Rải chữ thay thế lên khoảng [start, end), chia theo độ dài từng từ.

    Chia theo số ký tự chứ không chia đều: "a" và "extraordinary" không chiếm
    cùng một khoảng thời gian khi nói, và phụ đề nhấn theo từ trông sai ngay khi
    một từ dài loé lên rồi tắt.
    """
    parts = text.split()
    if not parts:
        return []
    if len(parts) == 1 or end <= start:
        return [Word(start, end, parts[0] if len(parts) == 1 else text)]
    total = sum(len(p) for p in parts)
    words: list[Word] = []
    at = start
    for i, part in enumerate(parts):
        # Từ cuối kết thúc đúng `end` để không tích luỹ sai số dấu phẩy động.
        stop = end if i == len(parts) - 1 else at + (end - start) * len(part) / total
        words.append(Word(at, stop, part))
        at = stop
    return words


def apply_text_edits(transcript: Transcript, edits: Sequence[TextEdit]) -> Transcript:
    """Áp phần sửa chữ lên bản sao transcript; transcript gốc giữ nguyên.

    Một edit thay mọi từ có TÂM nằm trong [start, end); chữ rỗng là xoá. Xét theo
    tâm chứ không theo giao nhau để một từ vắt qua ranh giới không bị hai edit
    cùng nhận.

    Chữ thay thế được CHIA LẠI thành từng từ trên đúng khoảng thời gian cũ. Bản
    trước gộp tất cả thành MỘT từ trải dài, và hệ quả không hiển nhiên: preset
    `bold` nhấn từng từ dựa vào mốc của từng từ, nên đúng cụm nào người dùng sửa
    chữ thì cụm đó mất hiệu ứng nhấn trong file mp4. Sửa một lỗi chính tả không
    được phép làm phụ đề xấu đi.

    Mốc của từ mới là ước lượng theo độ dài chữ — ta không biết người nói thật
    sự phát âm câu mới trong bao lâu. Đó vẫn tốt hơn nhiều so với một từ duy
    nhất dài bằng cả cụm.
    """
    segments: list[TranscriptSegment] = []
    for segment in transcript.segments:
        current = segment
        if segment.words:
            words = list(segment.words)
            for edit in edits:
                hits = [
                    i for i, w in enumerate(words) if edit.start <= (w.start + w.end) / 2 < edit.end
                ]
                if not hits:
                    continue
                first, last = hits[0], hits[-1]
                words[first : last + 1] = _respace_words(
                    edit.text.strip(), words[first].start, words[last].end
                )
            if words != segment.words:
                current = TranscriptSegment(
                    segment.start, segment.end, " ".join(w.text for w in words), words or None
                )
        else:
            middle = (segment.start + segment.end) / 2
            edit = next((e for e in edits if e.start <= middle < e.end), None)
            if edit is not None:
                current = TranscriptSegment(segment.start, segment.end, edit.text.strip(), None)
        if current.text.strip():
            segments.append(current)
    return Transcript(segments=segments, language=transcript.language, source=transcript.source)


def clip_segments(transcript: Transcript, settings: RevisionSettings) -> list[TranscriptSegment]:
    """Phụ đề của một revision, mốc thời gian đã dời về gốc 0 của clip."""
    edited = apply_text_edits(transcript, settings.text_edits)
    if not settings.cuts:
        return edited.slice(settings.source_start, settings.source_end)
    result = []
    offset = 0.0
    # Split liền nhau không làm một từ vắt ranh giới bị lặp trong SRT/TXT.
    joined = []
    for cut in settings.cuts:
        if joined and abs(joined[-1]["end"] - cut["start"]) < 0.00001:
            joined[-1]["end"] = cut["end"]
        else:
            joined.append(dict(cut))
    for cut in joined:
        for seg in edited.slice(cut["start"], cut["end"]):
            words = [Word(w.start + offset, w.end + offset, w.text) for w in seg.words] if seg.words else None
            result.append(TranscriptSegment(
                seg.start + offset, seg.end + offset,
                " ".join(w.text for w in words) if words else seg.text, words,
            ))
        offset += cut["end"] - cut["start"]
    return result
