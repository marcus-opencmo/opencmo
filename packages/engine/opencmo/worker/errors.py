"""Phân loại lỗi engine thành thông báo an toàn, có hướng xử lý cho người dùng."""

from __future__ import annotations

import errno
import subprocess

import httpx
from pydantic import ValidationError
from yt_dlp.utils import DownloadError

from ..media.ffmpeg import FFmpegError

_GENERIC = (
    "We could not finish your clips. Try again. If it keeps failing, try another video."
)
_NETWORK = "The connection was interrupted. Try again, or upload the video file instead."
_BUSY = "The processing service is busy right now. Please wait a few minutes and try again."
_STORAGE = "Processing storage is temporarily full. Please try again later."
_SPEECH = (
    "Not enough clear speech was found. Try a spoken interview, podcast, or presentation."
)
_SELECTION = "We could not choose usable clips. Try selecting a time range or use another video."
_RENDER = "We could not export this clip. Try again, or upload another copy of the video."
_TOO_LONG = (
    "This video is too long to transcribe in one go. "
    "Select a time range under 90 minutes, or use a video that has captions."
)
_SOURCE = "We could not read this video. Upload a playable MP4 file or try a different video."


class UserMessageError(RuntimeError):
    """Lỗi mà câu chữ ĐÃ được viết sẵn bằng tiếng Anh cho người dùng.

    Mặc định của `processing_error` là nuốt nội dung lỗi và thay bằng một câu
    cố định — đúng, vì stderr của ffmpeg hay URL có proxy không được lên màn
    hình. Nhưng có những lỗi mà câu duy nhất hữu ích là câu ta tự viết ("video
    này lớn hơn hạn mức"), và một câu chung chung ở đó khiến người dùng thử lại
    mãi một thứ không bao giờ chạy được.
    """


def processing_error(exc: Exception, stage: str = "") -> str:
    """Chỉ trả câu cố định; không đưa URL, stderr, transcript hay secret lên UI."""
    if isinstance(exc, UserMessageError):
        return str(exc)
    message = str(exc).lower()
    if isinstance(exc, OSError) and exc.errno == errno.ENOSPC:
        return _STORAGE
    if isinstance(exc, FFmpegError):
        if "no space left on device" in message:
            return _STORAGE
        if any(text in message for text in (
            "moov atom not found", "invalid data found when processing input",
            "could not find codec parameters", "audio extraction failed",
        )):
            return _SOURCE
        return _RENDER
    if isinstance(exc, subprocess.TimeoutExpired):
        return "Video processing took too long. Try a shorter time range or another video."
    if isinstance(exc, (httpx.TransportError, TimeoutError, ConnectionError)):
        return _NETWORK
    # Anthropic bọc lỗi httpx vào lớp riêng (APITimeoutError ⊂ APIConnectionError);
    # so theo tên để không import SDK chỉ vì phân loại lỗi.
    if type(exc).__name__ in {"APITimeoutError", "APIConnectionError"}:
        return _NETWORK

    # SDK thường có status_code (Anthropic) hoặc code (Google); không phụ thuộc SDK.
    status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
    response = getattr(exc, "response", None)
    if response is not None:
        status = getattr(response, "status_code", status)
    if status in (429, 503):
        return _BUSY

    if isinstance(exc, DownloadError):
        # 402/407 từ proxy là lỗi tài khoản dịch vụ, không phải link của user.
        if any(text in message for text in (
            "tunnel connection failed: 402", "tunnel connection failed: 407",
        )):
            return (
                "Video link imports are temporarily unavailable. "
                "Upload the video file instead, or try again after the service is restored."
            )
        if any(text in message for text in (
            "private video", "members-only", "login required", "sign in to confirm",
            "not a bot", "age-restricted", "http error 403",
            # Vimeo từ 2026: "The web client only works when logged-in".
            "only works when logged-in", "account credentials",
        )):
            return (
                "The video provider blocked access. Use a public video link "
                "or upload the video file instead."
            )
        if any(text in message for text in (
            "video unavailable", "video is unavailable", "video has been removed",
            "video is not available", "does not exist",
            "http error 404", "not available in your country",
        )):
            return "This video is unavailable. Try a different link or upload the video file."
        if any(text in message for text in (
            "timed out", "timeout", "connection reset", "unable to connect",
        )):
            return _NETWORK
        if "http error 429" in message:
            return _BUSY
        return "We could not download this video. Try again or upload the video file instead."

    # Các chuỗi dưới đây là tiền tố cố định do engine tạo, không match từ khoá chung.
    if isinstance(exc, (ValueError, RuntimeError)):
        if message.startswith((
            "not enough clear speech was found to create useful clips.",
            "groq returned an empty transcript.",
        )):
            return _SPEECH
        if message.startswith((
            "the moments you picked fall outside this video.",
            "each selected moment must end after it starts.",
            "the model did not find any usable moments in this video.",
        )):
            return _SELECTION
        if message.startswith("gemini did not return the expected schema:"):
            return "We could not select clips this time. Try again or select a time range yourself."
        if message.startswith(("groq returned 429:", "groq returned 503:")):
            return _BUSY
        if message.startswith((
            "audio is too large to transcribe:", "groq returned 413:",
        )):
            return _TOO_LONG
        if message.startswith("no video stream found in "):
            return _SOURCE
    if isinstance(exc, ValidationError) and stage == "select":
        return "We could not select clips this time. Try again or select a time range yourself."
    if stage in {"probe", "download", "download_audio", "download_sections"}:
        return "We could not load this video. Try again or upload the video file instead."
    if stage == "render":
        return _RENDER
    return _GENERIC
