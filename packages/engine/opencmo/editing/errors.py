"""Small render-error classifiers shared by cloud workers."""

from __future__ import annotations

import errno

from opencmo.media.ffmpeg import FFmpegError


def out_of_disk(exc: BaseException) -> bool:
    """Recognize ENOSPC from Python writes and from ffmpeg stderr."""
    if isinstance(exc, OSError) and exc.errno == errno.ENOSPC:
        return True
    return isinstance(exc, FFmpegError) and "No space left on device" in str(exc)

