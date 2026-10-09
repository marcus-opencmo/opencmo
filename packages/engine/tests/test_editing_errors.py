import errno

from opencmo.editing.errors import out_of_disk
from opencmo.media.ffmpeg import FFmpegError


def test_out_of_disk_recognizes_python_and_ffmpeg_failures():
    assert out_of_disk(OSError(errno.ENOSPC, "No space left on device"))
    assert out_of_disk(FFmpegError("No space left on device"))
    assert not out_of_disk(OSError(errno.EIO, "I/O error"))

