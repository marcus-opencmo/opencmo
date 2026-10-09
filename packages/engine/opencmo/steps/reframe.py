"""Xác định vùng cắt 9:16 từ video ngang, bằng cách bám mặt người.

Đây KHÔNG phải tính năng tùy chọn cho vui. Chạy thử trên TEDx talk cho thấy
cắt căn giữa làm hỏng hẳn clip khi người nói không đứng giữa sân khấu: một clip
ra kết quả người nói bị cắt nửa người ở mép trái, cả khung là phông nền. Cùng
đoạn đó, bám mặt đo được tâm x=0.37 — đủ để đưa người nói vào giữa khung.

Bốn quyết định quan trọng:

1. CHỈ detect ở 3–5 frame/giây, không phải từng frame.
   Mặt người không dịch chuyển nhanh hơn thế. Sample thưa rồi gộp lại giảm 90%
   khối lượng inference mà kết quả còn ổn định hơn (không giật khung).

2. Frame được trích ra thành ảnh JPEG NHỎ rồi đọc từng ảnh một.
   Không bao giờ nạp frame video vào RAM dưới dạng mảng. Xem ARCHITECTURE.md §2.

3. Dùng MediaPipe Tasks API, không dùng `mp.solutions`.
   MediaPipe 1.0 đã BỎ HẲN `mp.solutions.face_detection` — code viết theo API cũ
   chết với `AttributeError: module 'mediapipe' has no attribute 'solutions'`.
   Tasks API có từ 0.10 nên một đường code chạy được cho cả hai dòng phiên bản.

4. Gộp các lần detect bằng CỬA SỔ GIỮ ĐƯỢC NHIỀU MẶT NHẤT, không phải trung vị.
   Trung vị của một dãy hai cụm rơi vào giữa hai cụm — tức là vào chỗ không có
   ai. Đây là nguyên nhân của lỗi "clip chỉ thấy cái vai". Xem `_choose_center`.

MediaPipe vẫn là dependency tùy chọn: thiếu thì tự động rơi về căn giữa, vẫn ra
clip — chỉ là chất lượng khung hình kém hẳn với video quay rộng.
"""

from __future__ import annotations

import logging
import os
import statistics
import tempfile
import urllib.request
from bisect import bisect_left, bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from math import ceil, floor
from pathlib import Path

from ..media.ffmpeg import try_run

log = logging.getLogger(__name__)

# Model detect mặt của MediaPipe. Tasks API bắt buộc phải nạp file model — không
# có bản nhúng sẵn trong wheel như API `solutions` cũ.
_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
)
_MODEL_NAME = "blaze_face_short_range.tflite"


def _cache_dir() -> Path:
    root = os.getenv("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(root) / "opencmo"


def face_model_path() -> Path:
    """Đường dẫn tới file model, tải về nếu chưa có.

    `OPENCMO_FACE_MODEL` trỏ thẳng tới file có sẵn — dùng khi build image cho
    worker, để không phải tải model ở mỗi lần chạy nguội.
    """
    override = os.getenv("OPENCMO_FACE_MODEL")
    if override:
        return Path(override)

    target = _cache_dir() / _MODEL_NAME
    if target.exists():
        return target

    target.parent.mkdir(parents=True, exist_ok=True)
    log.info("Tải model bám mặt (~230KB) về %s", target)

    # Tên file tạm phải DUY NHẤT cho mỗi lần tải. Các clip render song song nên
    # nhiều luồng cùng gọi hàm này một lúc; dùng chung một file ".part" thì luồng
    # đầu tiên đổi tên xong, các luồng còn lại đổi tên một file không còn tồn tại
    # và im lặng rơi về cắt căn giữa.
    fd, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=".model-", suffix=".part")
    tmp = Path(tmp_name)
    try:
        # URL là hằng số trong file này, không nhận từ người dùng.
        with urllib.request.urlopen(_MODEL_URL, timeout=60) as resp, os.fdopen(fd, "wb") as fh:
            fh.write(resp.read())
        # replace() là thao tác nguyên tử và ghi đè được, nên luồng về sau ghi đè
        # kết quả giống hệt của luồng về trước — vô hại.
        tmp.replace(target)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return target


@dataclass(frozen=True)
class Face:
    """Một lần detect được mặt, mọi số chuẩn hoá theo khung hình (0–1).

    `w` là bề rộng hộp. Không giữ nó thì không phân biệt được "mặt nằm trong
    khung" với "mặt nằm ĐÚNG MÉP khung, mất một nửa" — hai thứ này khác nhau
    hoàn toàn trên clip nhưng giống hệt nhau nếu chỉ so tâm mặt với tâm khung.
    """

    frame: int
    x: float
    w: float
    area: float


@dataclass
class CropPlan:
    """Vị trí cắt theo chiều ngang, chuẩn hoá 0.0 (trái) → 1.0 (phải)."""

    x_center: float = 0.5
    tracked: bool = False
    samples: int = 0
    frames: int = 0
    # Tỉ lệ frame lấy mẫu mà mặt người THẬT SỰ nằm trong khung cắt cuối cùng.
    # Khác `hit_rate`: detect được mặt không có nghĩa là giữ được nó trên màn
    # hình. Đây mới là con số nói clip có xem được hay không.
    covered: int = 0

    @property
    def hit_rate(self) -> float:
        return self.samples / self.frames if self.frames else 0.0

    @property
    def coverage(self) -> float:
        return self.covered / self.frames if self.frames else 0.0


class FaceTrack(list[tuple[float, float, float]]):
    """Danh sách JSON-safe kèm dữ liệu tạm để giữ nguyên thuật toán crop cũ.

    Artifact chỉ lưu ba số ``time/x/area`` theo hợp đồng web. Trong cùng tiến
    trình, chiều rộng hộp mặt và tổng số frame vẫn được giữ riêng để
    ``plan_crop`` cho kết quả giống hệt trước khi tách bước lấy mẫu.
    """

    def __init__(
        self,
        samples: list[tuple[float, float, float]],
        *,
        faces: list[Face] | None = None,
        frame_count: int = 0,
        start: float = 0.0,
        sample_fps: float = 0.0,
    ) -> None:
        super().__init__(samples)
        self.faces = faces
        self.frame_count = frame_count
        # Cửa sổ đã lấy mẫu. Cần khi `plan_crop` dùng lại track cho một khoảng
        # HẸP HƠN: frame không có mặt nào không để lại mẫu, nên số frame của
        # khoảng con chỉ suy ra được từ gốc thời gian và nhịp lấy mẫu.
        self.start = start
        self.sample_fps = sample_fps

    def frames_in_range(self, start: float, end: float) -> int:
        """Số frame đã lấy mẫu rơi vào ``[start, end]``."""
        if self.sample_fps <= 0 or self.frame_count <= 0:
            return 0
        first = max(0, ceil((start - self.start) * self.sample_fps - 1e-6))
        last = min(self.frame_count - 1, floor((end - self.start) * self.sample_fps + 1e-6))
        return max(0, last - first + 1)


def _extract_frames(
    video: Path,
    workdir: Path,
    fps: float,
    *,
    start: float = 0.0,
    duration: float | None = None,
) -> list[Path]:
    """Trích frame thành JPEG nhỏ. Scale xuống 320px cho nhẹ — detect mặt
    không cần độ phân giải cao.

    `start`/`duration` giới hạn vào đúng cửa sổ của clip. Bắt buộc phải có khi
    nguồn là file local, vì lúc đó CẢ video được dùng làm section cho mọi clip —
    không giới hạn thì một video 9 phút bị lấy mẫu trọn ở 4fps (hơn 2000 frame),
    vừa chậm vừa cho trung vị của toàn video thay vì của đoạn đang cắt.
    """
    pattern = workdir / "f_%04d.jpg"
    window: list[str] = []
    if start > 0:
        # -ss TRƯỚC -i: input seeking. Xem ARCHITECTURE.md §4.
        window += ["-ss", f"{start:.3f}"]
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *window, "-i", str(video)]
    if duration is not None:
        args += ["-t", f"{duration:.3f}"]
    ok = try_run(
        [
            *args,
            "-vf", f"fps={fps},scale=320:-2",
            "-q:v", "5",
            str(pattern),
        ],
        timeout=180,
    )
    if not ok:
        return []
    return sorted(workdir.glob("f_*.jpg"))


def _detect_faces(frames: list[Path]) -> list[Face]:
    """Trả về MỌI mặt detect được trong mỗi frame, không chỉ mặt lớn nhất.

    Phiên bản trước chỉ giữ mặt lớn nhất mỗi frame với lý do "mặt lớn nhất là
    người đang nói". Điều đó đúng trong từng frame riêng lẻ nhưng sai khi xâu
    chuỗi cả clip: cảnh rộng chen giữa cận cảnh thì mặt lớn nhất nhảy từ người
    này sang người khác, và bước sau lấy trung vị của một dãy nhảy qua nhảy lại
    sẽ rơi vào khoảng TRỐNG giữa hai người. Giữ hết rồi để `_choose_center`
    quyết định thì thông tin còn nguyên để quyết định cho đúng.
    """
    try:
        import mediapipe as mp  # type: ignore
        from mediapipe.tasks import python as mp_python  # type: ignore
        from mediapipe.tasks.python import vision  # type: ignore
    except ImportError:
        log.info("Không có MediaPipe — dùng căn giữa. Cài thêm: pip install 'opencmo-engine[face]'")
        return []

    try:
        model = face_model_path()
    except Exception as exc:  # noqa: BLE001 - thiếu model thì fallback, không làm hỏng job
        log.warning("Không lấy được model bám mặt (%s) — dùng căn giữa.", exc)
        return []

    options = vision.FaceDetectorOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(model)),
        # Ngưỡng thấp hơn mặc định: cảnh quay sân khấu rộng thì mặt rất nhỏ trong
        # khung. Detect nhầm vài lần không hại — `_choose_center` tính điểm theo
        # diện tích mặt cộng dồn nên một đốm nhỏ lẻ loi không kéo nổi khung cắt.
        min_detection_confidence=0.3,
    )

    faces: list[Face] = []
    detector = vision.FaceDetector.create_from_options(options)
    try:
        for idx, frame_path in enumerate(frames):
            image = mp.Image.create_from_file(str(frame_path))
            result = detector.detect(image)
            for det in result.detections:
                box = det.bounding_box
                faces.append(
                    Face(
                        frame=idx,
                        x=(box.origin_x + box.width / 2) / image.width,
                        w=box.width / image.width,
                        area=(box.width * box.height) / (image.width * image.height),
                    )
                )
    finally:
        detector.close()

    return faces


def _tam_hop_le(face: Face, window: float) -> tuple[float, float]:
    """Khoảng tâm cắt mà CẢ hộp mặt nằm gọn trong khung.

    Mặt rộng hơn cả khung cắt thì không có khoảng nào — trả về khoảng rỗng,
    `_inside` sẽ luôn False.
    """
    margin = (window - face.w) / 2
    return face.x - margin, face.x + margin


def _inside(face: Face, center: float, window: float) -> bool:
    lo, hi = _tam_hop_le(face, window)
    return lo <= center <= hi


def _score(faces: list[Face], center: float, window: float) -> float:
    """Tổng diện tích mặt giữ được trên màn hình, MỖI FRAME GÓP MỘT MẶT.

    Chặn mỗi frame một mặt là có lý do: không chặn thì một cảnh khán giả hai
    mươi cái đầu lấn át hai mươi frame có người đang nói.
    """
    per_frame: dict[int, float] = {}
    for f in faces:
        if _inside(f, center, window) and f.area > per_frame.get(f.frame, 0.0):
            per_frame[f.frame] = f.area
    return sum(per_frame.values())


def _choose_center(faces: list[Face], window: float) -> float:
    """Chọn tâm cắt giữ được NHIỀU DIỆN TÍCH MẶT NGƯỜI NHẤT trên màn hình.

    Đây là chỗ bản cũ hỏng. Nó lấy trung vị của mọi lần detect, mà trung vị của
    một dãy hai cụm rơi vào giữa hai cụm — tức là vào chỗ KHÔNG có ai. Đo trên
    dãy mô phỏng: hai người ngồi phỏng vấn ở x=0.30 và x=0.70, cắt qua lại đều
    nhau, trung vị ra 0.500 và giữ được **0/100 frame** — đúng triệu chứng "chỉ
    thấy cái vai". Cảnh có khán giả rải rác giữ được 20%; người nói đi ngang
    khung giữ 36% và KHÔNG cách nào khá hơn bằng một khung tĩnh.

    Thay bằng một câu hỏi trả lời được: đặt cửa sổ 9:16 ở đâu thì cộng dồn được
    nhiều diện tích mặt nhất? Không có ngưỡng nào phải tự nghĩ — `window` là bề
    rộng thật của khung cắt, và "nằm trong khung" nghĩa là cả hộp mặt nằm gọn,
    không phải chỉ cái tâm.

    Điểm số đổi giá trị đúng tại các mút của khoảng hợp lệ, nên chỉ cần thử
    chừng đó vị trí là đủ phủ hết mọi cách đặt cửa sổ.

    Vẫn là MỘT vị trí tĩnh cho cả clip. Cảnh người nói di chuyển thật sự cần
    đường cắt động — xem TODO ở `plan_crop`.
    """
    xs = sorted(f.x for f in faces)
    # Mọi mặt đã lọt trong một cửa sổ thì không có gì phải chọn: trung vị là vị
    # trí cân đối nhất. Đây là đường thường gặp nhất (talking-head), và nó thoát
    # sớm trước vòng quét bên dưới.
    if xs[-1] - xs[0] <= window - max(f.w for f in faces):
        return statistics.median(xs)

    moc: set[float] = set()
    for f in faces:
        lo, hi = _tam_hop_le(f, window)
        # Làm tròn về 0.001 ≈ 2px trên nguồn 1080p. Mịn hơn thế thì không ai
        # nhìn ra, mà số ứng viên thì tăng theo số lần detect.
        moc.add(round(lo, 3))
        moc.add(round(hi, 3))

    ung_vien = sorted(moc)
    diem = [_score(faces, c, window) for c in ung_vien]
    best_score = max(diem)

    if best_score <= 0:
        # Không vị trí nào giữ trọn được mặt nào (mặt to hơn cả khung cắt, hoặc
        # sát mép khung hình). Trung vị vẫn là phương án ít tệ nhất.
        return statistics.median(xs)

    # Gom các ứng viên cùng điểm cao nhất thành từng DẢI LIỀN NHAU. Gom chung
    # hết rồi lấy khoảng giữa là sai, và sai đúng kiểu đang đi sửa: hai người
    # ngồi hai bên cho hai dải điểm bằng nhau, khoảng giữa của chúng rơi vào
    # chỗ trống ở giữa — quay lại đúng bài toán ban đầu.
    # Hai ứng viên liền nhau trong danh sách CHƯA CHẮC liền nhau trên trục: giữa
    # chúng có thể là cả một quãng điểm 0 mà không mút nào rơi vào. Điểm số là
    # hằng trên từng quãng giữa hai mút, nên hỏi đúng điểm giữa là đủ để biết.
    dai: list[tuple[float, float]] = []
    for i, c in enumerate(ung_vien):
        if diem[i] != best_score:
            continue
        lien_truoc = (
            dai
            and diem[i - 1] == best_score
            and _score(faces, (ung_vien[i - 1] + c) / 2, window) == best_score
        )
        if lien_truoc:
            dai[-1] = (dai[-1][0], c)
        else:
            dai.append((c, c))

    # Bằng điểm nghĩa là hai cách đặt khung giữ được lượng mặt như nhau — chọn
    # cách gần tâm khung hình hơn, vì khung lệch hẳn sang một bên trông gượng.
    lo, hi = min(dai, key=lambda d: abs((d[0] + d[1]) / 2 - 0.5))
    # Trong một dải, lấy khoảng giữa: vẫn giữ nguyên số mặt nhưng có biên an
    # toàn hai bên, thay vì dính vào đúng cái mút vừa dò ra.
    return (lo + hi) / 2


def _count_covered(faces: list[Face], center: float, window: float) -> int:
    """Đếm số frame có mặt nằm GỌN trong khung cắt cuối cùng.

    Kẹp tâm về trong lề giống hệt `_crop_rect` của render: mặt ở x=0.95 không
    bao giờ được đưa vào giữa khung, khung sẽ chạm mép phải và người đó nằm sát
    rìa. Không kẹp ở đây thì con số báo cáo đẹp hơn clip thật.
    """
    half = window / 2
    clamped = min(1.0 - half, max(half, center))
    return len({f.frame for f in faces if _inside(f, clamped, window)})


def crop_window(source_aspect: float, target_aspect: float = 9 / 16) -> float:
    """Bề rộng khung cắt 9:16, tính theo phần bề rộng nguồn (0–1).

    Con số này là thước đo của cả bước bám mặt: nguồn 16:9 cho 0.316, tức mặt
    người lệch quá **0.158** so với tâm cắt là ra ngoài khung. Nguồn 4:3 rộng
    tay hơn (0.422). Không suy ra từ tỉ lệ nguồn thì mọi ngưỡng đều là số tự
    nghĩ, và sai hẳn khi nguồn không phải 16:9.
    """
    if source_aspect <= target_aspect:
        # Nguồn đã hẹp hơn khung đích — render giữ nguyên bề ngang, cắt chiều cao.
        return 1.0
    return target_aspect / source_aspect


def face_track(
    video: Path,
    *,
    sample_fps: float = 4.0,
    start: float = 0.0,
    duration: float | None = None,
) -> list[tuple[float, float, float]]:
    """Lấy mẫu vị trí mặt một lần, với thời gian tuyệt đối của nguồn.

    Một timestamp có thể có nhiều mẫu khi frame có nhiều người. Danh sách giữ
    nguyên thứ tự frame nên có thể lưu thẳng thành JSON và truy vấn theo khoảng.
    """
    with tempfile.TemporaryDirectory(prefix="opencmo-frames-") as tmp:
        frames = _extract_frames(
            video, Path(tmp), sample_fps, start=start, duration=duration
        )
        if not frames:
            return FaceTrack([], frame_count=0, start=start, sample_fps=sample_fps)
        faces = _detect_faces(frames)

    ordered = sorted(faces, key=lambda face: face.frame)
    samples = [
        (start + face.frame / sample_fps, face.x, face.area)
        for face in ordered
    ]
    return FaceTrack(
        samples,
        faces=ordered,
        frame_count=len(frames),
        start=start,
        sample_fps=sample_fps,
    )


def _faces_for_range(
    track: list[tuple[float, float, float]], start: float, end: float
) -> list[Face]:
    lo = bisect_left(track, start, key=lambda sample: sample[0])
    hi = bisect_right(track, end, key=lambda sample: sample[0])
    if lo == hi:
        return []

    if isinstance(track, FaceTrack) and track.faces is not None:
        # Mỗi mẫu và Face cùng một vị trí; slice giữ cả nhiều khuôn mặt xuất
        # hiện tại cùng timestamp mà không phải quét lại toàn bộ track.
        return track.faces[lo:hi]

    # Artifact không giữ chiều rộng hộp. Căn bậc hai diện tích là xấp xỉ bảo
    # thủ cho hộp gần vuông; frame index theo timestamp để mỗi frame chỉ góp
    # một khuôn mặt vào điểm số.
    frame_by_time: dict[float, int] = {}
    faces: list[Face] = []
    for timestamp, x, area in track[lo:hi]:
        frame = frame_by_time.setdefault(timestamp, len(frame_by_time))
        faces.append(Face(frame=frame, x=x, w=min(1.0, area**0.5), area=area))
    return faces


def focus_for_range(
    track: list[tuple[float, float, float]],
    start: float,
    end: float,
    *,
    source_aspect: float = 16 / 9,
    target_aspect: float = 9 / 16,
) -> float:
    """Tính tâm crop cho một khoảng bằng tìm biên nhị phân trên face track."""
    return focus_for_ranges(
        track,
        [(start, end)],
        source_aspect=source_aspect,
        target_aspect=target_aspect,
    )


def focus_for_ranges(
    track: list[tuple[float, float, float]],
    ranges: Sequence[tuple[float, float]],
    *,
    source_aspect: float = 16 / 9,
    target_aspect: float = 9 / 16,
) -> float:
    """Tâm crop tính trên HỢP của nhiều khoảng, dùng cho revision có cuts.

    Tính trên cả `[source_start, source_end]` là sai khi người dùng đã cắt bỏ
    đoạn giữa: đúng cái bẫy ở quyết định số 4 phía trên — trung vị của hai cụm
    rơi vào khoảng trống giữa chúng, và khoảng trống đó chính là đoạn đã bị
    xoá. Chỉ những frame còn nằm trong bản ghép mới được góp vào tâm cắt.
    """
    if not track:
        return 0.5
    faces: list[Face] = []
    for start, end in ranges:
        if end > start:
            faces.extend(_faces_for_range(track, start, end))
    return _choose_center(faces, crop_window(source_aspect, target_aspect)) if faces else 0.5


# ------------------------------------------------- tâm khung động cho editor
#
# Editor không cắt bằng một tâm tĩnh như `plan_crop`: nó dựng keyframe `x` để
# khung bám người nói, và mark `reframe` để đổi khung về sau không mất chỗ người
# nói. Từ R4 dãy tâm đó tính ở ĐÂY, một lần lúc worker chuẩn bị master, bằng
# chính `_choose_center` mà pipeline dùng — editor chỉ đọc. Trước R4 nó là bản
# chép TypeScript (`lib/editor/focus.ts`) của cùng thuật toán.

#: Một mốc mỗi ngần này giây; clip dài hơn thì giãn nhịp thay vì cắt đuôi.
KEYFRAME_SECONDS = 2.0
#: Trần số mốc: người nói không đổi chỗ 100 lần trong một clip.
MAX_KEYFRAMES = 40
#: Hai tâm lệch dưới 1% bề ngang nguồn thì gộp: mắt không thấy, camera thì nhích.
FOCUS_EPSILON = 0.01
#: Lưới frame của editor; cú nhảy cảnh bám đúng lưới này.
EDITOR_FPS = 30


def _js_round(value: float, digits: int) -> float:
    """`Math.round(v·10ⁿ)/10ⁿ` của JS (làm tròn nửa lên), để mốc giây khớp từng
    chữ số với document editor vẫn sinh — `round()` của Python làm tròn về chẵn."""
    scale = 10**digits
    return floor(value * scale + 0.5) / scale


def focus_at(track: list, start: float, end: float, window: float) -> float:
    """Tâm khung cho `[start, end]` (giây video gốc), kẹp để cửa sổ không lòi ra mép."""
    faces = _faces_for_range(track, start, end)
    if not faces:
        return 0.5
    half = window / 2
    return min(max(_choose_center(faces, window), half), 1 - half)


def _cut_at(track: list, previous: float, focus: float, start: float, end: float) -> float:
    """Giây (video gốc) mà mặt nhảy từ `previous` sang `focus`: mẫu đầu tiên gần
    `focus` hơn, đứng sau mẫu cuối còn gần `previous`. Không thấy thì lấy cuối khoảng."""
    samples = [sample for sample in track if start <= sample[0] <= end]
    last_old = -1
    for index, sample in enumerate(samples):
        if abs(sample[1] - previous) < abs(sample[1] - focus):
            last_old = index
    for sample in samples[last_old + 1:]:
        if abs(sample[1] - focus) <= abs(sample[1] - previous):
            return sample[0]
    return end


def focus_points(
    track: list,
    window: float,
    offset: float,
    source_in: float,
    source_out: float,
) -> list[list[float]]:
    """Dãy `[giây master, tâm]` cho keyframe `x` và mark `reframe` của editor.

    `track` theo thời gian VIDEO GỐC; `source_in`/`source_out` theo giây của
    master (gốc 0 ở `offset`). Cú nhảy cảnh (tâm đổi quá nửa cửa sổ) ra HAI mốc
    sát nhau trên lưới frame, để camera cắt chứ không lia qua nền trống. Ít hơn
    hai mốc là một khung tĩnh viết dài dòng: trả rỗng.
    """
    span = source_out - source_in
    if span <= 0 or not track:
        return []
    step = max(KEYFRAME_SECONDS, span / MAX_KEYFRAMES)
    out: list[list[float]] = []
    previous: float | None = None
    steady = source_in
    at = source_in
    while at < source_out + 1e-6:
        time = min(at, source_out)
        at += step
        # Cửa sổ lấy mẫu trải về hai phía của mốc: tâm ở mốc `t` phản ánh đoạn
        # video quanh `t`, không phải đoạn sắp tới.
        middle = offset + time
        focus = focus_at(track, middle - step / 2, middle + step / 2, window)
        if previous is not None and abs(focus - previous) < FOCUS_EPSILON:
            steady = time
            continue
        if previous is not None and abs(focus - previous) > window / 2 and len(out) + 2 <= MAX_KEYFRAMES:
            last = out[-1][0]
            cut = _cut_at(track, previous, focus, offset + steady - step / 2, middle + step / 2) - offset
            clamped = min(max(cut, last + 2 / EDITOR_FPS), time)
            snapped = source_in + _js_round((clamped - source_in) * EDITOR_FPS, 0) / EDITOR_FPS
            out.append([_js_round(snapped - 1 / EDITOR_FPS, 3), previous])
            out.append([_js_round(snapped, 3), focus])
            previous = focus
            steady = time
            continue
        previous = focus
        steady = time
        out.append([_js_round(time, 2), focus])
        if len(out) >= MAX_KEYFRAMES:
            break
    return out if len(out) >= 2 else []


def editor_focus(
    track: list,
    *,
    source_width: int,
    source_height: int,
    frame_width: int,
    frame_height: int,
    offset: float,
    duration: float,
    source_start: float,
    source_end: float,
) -> dict[str, list[list[float]]]:
    """Hai dãy tâm mà bộ sinh project editor đọc (`masters[clip].focus`).

    - `frame`: cửa sổ của khung clip hiện tại → keyframe `x` của video.
    - `reframe`: cửa sổ mà mark `reframe` lưu để đổi khung về sau. Khung không
      cần trượt (16:9 trên nguồn 16:9) vẫn lấy mẫu bằng cửa sổ 9:16 — khung mà
      người dùng gần như chắc sẽ đổi sang.

    `source_in`/`source_out` tính y như bộ sinh project: giây của master, kẹp
    trong phần master thật sự có.
    """
    if not track or source_width <= 0 or source_height <= 0:
        return {"frame": [], "reframe": []}
    source_in = _js_round(min(max(source_start - offset, 0.0), duration), 2)
    source_out = _js_round(min(max(source_end - offset, source_in), duration), 2)
    source_aspect = source_width / source_height
    frame_aspect = frame_width / frame_height
    reframe_target = frame_aspect if frame_aspect < source_aspect else 9 / 16
    return {
        "frame": focus_points(track, crop_window(source_aspect, frame_aspect), offset, source_in, source_out),
        "reframe": focus_points(track, crop_window(source_aspect, reframe_target), offset, source_in, source_out),
    }


def plan_crop(
    video: Path,
    *,
    sample_fps: float = 4.0,
    enabled: bool = True,
    start: float = 0.0,
    duration: float | None = None,
    source_aspect: float = 16 / 9,
    target_aspect: float = 9 / 16,
    track: FaceTrack | None = None,
) -> CropPlan:
    """Tính vị trí cắt cho một clip.

    Phiên bản này dùng MỘT vị trí cắt tĩnh cho cả clip: vị trí đặt cửa sổ 9:16
    giữ được nhiều diện tích mặt người nhất (xem `_choose_center`). Với video
    talking-head — đúng tệp nội dung chính của công cụ này — người nói hầu như
    đứng yên, nên cắt tĩnh cho kết quả ổn định và không bị rung khung.

    TODO: đường cắt động (crop path nội suy theo thời gian) cho nội dung có
    người di chuyển nhiều. Cần dựng file sendcmd cho ffmpeg. `coverage` thấp
    trong khi `hit_rate` cao chính là dấu hiệu clip đó CẦN đường cắt động —
    detect được mặt suốt clip nhưng không một khung tĩnh nào giữ nổi.

    `start`/`duration` khoanh vùng lấy mẫu về đúng đoạn sắp cắt. Với nguồn URL
    thì section vốn đã ngắn nên chỉ là bỏ bớt phần đệm; với nguồn file local thì
    đây là điều kiện đúng/sai, vì cả video được dùng chung làm section.

    `track` là kết quả lấy mẫu đã có cho CÙNG section (thời gian tính theo
    section, không phải theo nguồn gốc): truyền vào thì bỏ hẳn bước lấy mẫu và
    chỉ cắt lấy phần rơi vào cửa sổ. Đường CLI không truyền gì nên hành vi cũ
    giữ nguyên.
    """
    if not enabled:
        return CropPlan()

    if track is None:
        track = face_track(
            video, sample_fps=sample_fps, start=start, duration=duration
        )
        faces = track.faces
        frame_count = track.frame_count
    else:
        # Worker web đã lấy mẫu đúng section này để lưu artifact `face_track`.
        # Lấy mẫu lại ở đây là chạy MediaPipe hai lần cho mỗi clip — phần đắt
        # nhất của bước render, và ngân sách 3 phút không dư chỗ cho nó.
        end = start + duration if duration is not None else float("inf")
        faces = _faces_for_range(track, start, end)
        frame_count = track.frames_in_range(start, end)

    if not faces:
        if frame_count == 0:
            return CropPlan()
        log.info("Không detect được mặt nào trong %d frame — cắt căn giữa.", frame_count)
        return CropPlan(samples=0, frames=frame_count)

    window = crop_window(source_aspect, target_aspect)
    x = _choose_center(faces, window)
    covered = _count_covered(faces, x, window)
    samples = len({f.frame for f in faces})

    log.info(
        "Bám mặt: %d/%d frame có mặt (%.0f%%), tâm cắt x=%.3f, "
        "giữ được mặt trong khung %d/%d frame (%.0f%%)",
        samples, frame_count, samples / frame_count * 100, x,
        covered, frame_count, covered / frame_count * 100,
    )
    # Lỗi tệ nhất của dự án này đều im lặng: file mp4 vẫn ra, vẫn mở được, chỉ
    # là người nói nằm ngoài khung. Detect được mặt mà không giữ được nó trên
    # màn hình thì phải nói to, vì không có cách nào sửa tự động ở đây — một
    # khung tĩnh không phục vụ nổi cảnh đó.
    if samples and covered < samples * 0.6:
        log.warning(
            "Khung tĩnh chỉ giữ được mặt ở %d/%d frame có mặt — clip này nhiều "
            "cỡ cảnh hoặc nhiều người, HÃY XEM LẠI trước khi đăng.",
            covered, samples,
        )

    return CropPlan(
        x_center=min(1.0, max(0.0, x)),
        tracked=True,
        samples=samples,
        frames=frame_count,
        covered=covered,
    )
