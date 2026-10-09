"""Storage: stream upload/download theo khối, copy, ký URL, xoá."""

from __future__ import annotations

import logging
import mimetypes
from pathlib import Path
from typing import Any

import httpx

from opencmo.backends import retry
from opencmo.backends.supabase.http import _JSON, _Http
from opencmo.backends.supabase.models import ObjectTooLargeError

log = logging.getLogger(__name__)

BUCKET = "clips"

# Bucket riêng cho file người dùng tự upload. Clip sống 7 ngày để người dùng
# tải; file nguồn xoá khi job done, job failed giữ tới hết hạn để còn thử lại.
SOURCES_BUCKET = "sources"

# Tiền tố đánh dấu "nguồn là file người dùng đã upload", nằm ngay trong cột
# `source_url` có sẵn. Phải TRÙNG với SOURCE_PREFIX ở apps/web/lib/upload.ts.
SOURCE_PREFIX = "storage://"

# Đọc theo khối 1MB. Cả file nguồn có thể tới hàng trăm MB, nên KHÔNG BAO GIỜ
# gọi `resp.content` ở đây — CLAUDE.md giữ RAM đỉnh dưới 2GB.
_CHUNK = 1024 * 1024


def _iter_file(path: Path, chunk_size: int | None = None) -> Any:
    """Sinh từng khối byte của một file — dùng làm `content=` streaming cho
    httpx thay vì `read_bytes()`. Gọi lại `_iter_file(...)` mỗi lần retry (mở
    lại file, không dùng chung một generator đã tiêu thụ dở)."""
    chunk_size = _CHUNK if chunk_size is None else chunk_size
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(chunk_size)
            if not chunk:
                return
            yield chunk


def _is_duplicate_conflict(resp: httpx.Response) -> bool:
    """409 luôn là "đã tồn tại" ở storage-api hiện tại; 400 chỉ tính khi body
    tự nói `error: "Duplicate"` — 400 khác (mime sai, tên bất hợp lệ...) không
    được coi là an toàn để bỏ qua."""
    if resp.status_code == 409:
        return True
    if resp.status_code != 400:
        return False
    try:
        body = resp.json()
    except ValueError:
        return False
    return isinstance(body, dict) and body.get("error") == "Duplicate"


class StorageMixin(_Http):
    # ------------------------------------------------------------- storage
    #
    # D2 ruling (d2-contract.md, "Storage keys"): MỌI upload dùng x-upsert:
    # false. Một request bị mất response rồi retry gặp "đã tồn tại" (409, hay
    # 400 mà body nói Duplicate) coi là THÀNH CÔNG chỉ khi object đã có trên
    # server đúng bằng kích thước file cục bộ — khác kích thước là dấu hiệu
    # ai đó khác đã ghi đè key này, ném lỗi thay vì âm thầm nhận nhầm.

    def upload_object(
        self, bucket: str, path: str, local_file: Path, *, content_type: str | None = None
    ) -> str:
        """Tải một file lên storage, stream theo khối — KHÔNG BAO GIỜ đọc cả
        file vào RAM (luật CLAUDE.md, RAM đỉnh mỗi job < 2GB)."""
        content_type = content_type or mimetypes.guess_type(local_file.name)[0] or (
            "application/octet-stream"
        )
        url = f"{self.url}/storage/v1/object/{bucket}/{path}"
        headers = {"Content-Type": content_type, "x-upsert": "false"}

        def send() -> httpx.Response:
            resp = self._client.request(
                "POST", url, content=_iter_file(local_file), headers=headers
            )
            if _is_duplicate_conflict(resp):
                info = self.object_info(bucket, path)
                local_size = local_file.stat().st_size
                if info is not None and info.get("size") == local_size:
                    # Cùng nội dung, chỉ là response lần trước bị mất giữa
                    # đường — coi như thành công, không ném PermanentError.
                    return httpx.Response(200)
                raise retry.PermanentError(
                    f"An object already exists at this path with different content: "
                    f"{bucket}/{path}",
                    resp.status_code,
                )
            return resp

        retry.call(send, idempotent=True, what=f"upload {bucket}/{path}", sleep=self._sleep)
        return path

    def replace_object(
        self, bucket: str, path: str, local_file: Path, *, content_type: str | None = None
    ) -> str:
        """Ghi bản xuất vào đúng object canonical của task (ghi đè nếu worker chạy lại).

        Tách khỏi `upload_object` để những bucket immutable khác không bao
        giờ vô tình được nới thành upsert.
        """
        content_type = content_type or mimetypes.guess_type(local_file.name)[0] or (
            "application/octet-stream"
        )
        url = f"{self.url}/storage/v1/object/{bucket}/{path}"
        headers = {"Content-Type": content_type, "x-upsert": "true"}

        def send() -> httpx.Response:
            return self._client.request(
                "POST", url, content=_iter_file(local_file), headers=headers
            )

        retry.call(send, idempotent=True, what=f"replace {bucket}/{path}", sleep=self._sleep)
        return path

    def download_object(
        self, bucket: str, path: str, dest: Path, *, max_bytes: int | None = None
    ) -> Path:
        """Tải object về đĩa, stream theo khối 1MB. Vượt `max_bytes` thì huỷ
        ngay và xoá phần đã tải dở — không để lại file rác nửa vời trên đĩa
        worker mà bước sau tưởng là file đầy đủ."""
        url = f"{self.url}/storage/v1/object/{bucket}/{path}"
        def send() -> httpx.Response:
            written = 0
            dest.unlink(missing_ok=True)
            try:
                with self._client.stream("GET", url) as resp:
                    if resp.status_code >= 400:
                        return httpx.Response(
                            resp.status_code,
                            headers=resp.headers,
                            content=resp.read(),
                        )
                    with dest.open("wb") as fh:
                        for chunk in resp.iter_bytes(_CHUNK):
                            if max_bytes is not None and written + len(chunk) > max_bytes:
                                raise ObjectTooLargeError(
                                    f"Object exceeds the {max_bytes} byte limit: {bucket}/{path}"
                                )
                            fh.write(chunk)
                            written += len(chunk)
                return httpx.Response(200)
            except BaseException:
                dest.unlink(missing_ok=True)
                raise

        retry.call(
            send,
            idempotent=True,
            what=f"download {bucket}/{path}",
            sleep=self._sleep,
        )
        return dest

    def object_info(self, bucket: str, path: str) -> dict[str, Any] | None:
        """Metadata (`size`, `content_type`, ...) của một object, hoặc None
        nếu không tồn tại. Dùng để kiểm "đã tải lên chưa" khi retry upload."""
        try:
            resp = self._send(
                "GET", f"/storage/v1/object/info/{bucket}/{path}", idempotent=True
            )
        except retry.PermanentError as exc:
            if exc.status == 404:
                return None
            raise
        return resp.json()

    def object_exists(self, bucket: str, path: str) -> bool:
        try:
            self._send("HEAD", f"/storage/v1/object/{bucket}/{path}", idempotent=True)
        except retry.PermanentError as exc:
            if exc.status == 404:
                return False
            raise
        return True

    def remove_objects(self, bucket: str, paths: list[str]) -> None:
        """Xoá nhiều object theo tên chính xác. RAISE khi thất bại — khác các
        wrapper cũ (`remove_source`, `delete_clip_objects`) vốn cố ý nuốt lỗi
        vì chạy trong nhánh dọn dẹp; hàm gốc này để bên gọi tự quyết định."""
        if not paths:
            return
        self._send(
            "DELETE",
            f"/storage/v1/object/{bucket}",
            idempotent=True,
            json={"prefixes": paths},
            headers=_JSON,
        )

    def copy_object(
        self, bucket: str, path: str, dest_bucket: str, dest_path: str
    ) -> None:
        """Nhân bản một object NGAY TRONG Storage — không byte nào qua worker.

        Dùng khi file người dùng đã nằm sẵn trong `sources` và ta cần nó ở
        `clips`: tải về rồi đẩy lên lại là trả tiền egress + ingress cho đúng
        một khối byte đã nằm sẵn ở đó.
        """
        self._send(
            "POST",
            "/storage/v1/object/copy",
            idempotent=True,
            json={
                "bucketId": bucket,
                "sourceKey": path,
                "destinationBucket": dest_bucket,
                "destinationKey": dest_path,
            },
            headers=_JSON,
        )

    def sign_object_url(self, bucket: str, path: str, expires_in: int = 3600) -> str:
        """URL tải có chữ ký, hết hạn sau `expires_in` giây.

        Để ffprobe/ffmpeg đọc TRỰC TIẾP qua HTTP thay vì tải cả file về đĩa:
        đọc metadata chỉ tốn phần header, và cắt 15 giây đầu chỉ tốn 15 giây
        dữ liệu — thay vì cả gigabyte.
        """
        resp = self._send(
            "POST",
            f"/storage/v1/object/sign/{bucket}/{path}",
            idempotent=True,
            json={"expiresIn": expires_in},
            headers=_JSON,
        )
        signed = resp.json().get("signedURL")
        if not signed:
            raise retry.PermanentError(f"Storage did not sign {bucket}/{path}", 500)
        return f"{self.url}/storage/v1{signed}"

    # --------------------------------------------------- legacy (giữ chữ ký)

    def download_source(self, path: str, dest: Path) -> Path:
        """Tải file nguồn người dùng đã upload về đĩa của worker.

        Đây là ngoại lệ CÓ CHỦ Ý với luật 3 của CLAUDE.md ("không bao giờ tải
        nguyên video gốc"). Luật đó sinh ra cho nguồn URL, nơi ta CHỌN được chỉ
        tải vài đoạn LLM đã chấm. Với file người dùng tự upload thì họ đã gửi ta
        toàn bộ rồi, và bước transcribe cần trọn vẹn audio — tức phải đọc hết
        file dù có streaming hay không. Tải một lần rồi dùng cho cả audio lẫn mọi
        section là ít việc nhất.
        """
        self.download_object(SOURCES_BUCKET, path, dest)
        if dest.stat().st_size == 0:
            raise RuntimeError(f"Uploaded source is empty: {path}")
        log.info("Đã tải nguồn upload: %s (%.1f MB)", path, dest.stat().st_size / 1e6)
        return dest

    def remove_source(self, path: str) -> None:
        """Xoá file nguồn khỏi bucket. Nuốt lỗi CÓ CHỦ Ý.

        Được gọi trong nhánh `finally` của worker, tức có thể chạy ngay sau một
        exception khác. Ném thêm lỗi ở đây sẽ che mất lỗi thật — mà file thừa
        còn có cron dọn rác nhặt sau.
        """
        try:
            self.remove_objects(SOURCES_BUCKET, [path])
            log.info("Đã xoá nguồn upload: %s", path)
        except Exception:
            log.warning("Không xoá được nguồn upload %s — để cron dọn", path, exc_info=True)

    def delete_clip_objects(self, paths: list[str]) -> None:
        """Xoá clip đã upload của một attempt không được ghi nhận. Nuốt lỗi như
        `remove_source`: đây là dọn dẹp, không được che lỗi chính."""
        if not paths:
            return
        try:
            self.remove_objects(BUCKET, paths)
            log.info("Đã xoá %d file clip của attempt bị bỏ", len(paths))
        except Exception:
            log.warning("Không xoá được %d file clip mồ côi", len(paths), exc_info=True)

    def upload(self, path: str, local_file: Path) -> str:
        """Tải một clip lên bucket `clips`, trả về đường dẫn trong bucket.

        Trước đây dùng `x-upsert: true`; D2 đổi toàn bộ upload sang
        `x-upsert: false` (xem docstring `upload_object`) — thư mục theo
        attempt (`storage_path(..., f"{attempt}/...")`, gọi ở modal_app.py) đã
        đủ tránh đụng độ giữa hai attempt, và retry vẫn an toàn nhờ kiểm size.
        """
        return self.upload_object(BUCKET, path, local_file)


def storage_path(user_id: str, job_id: str, filename: str) -> str:
    """Phải khớp với policy RLS ở 20260907162807_init.sql: segment đầu là user id."""
    return f"{user_id}/{job_id}/{filename}"
