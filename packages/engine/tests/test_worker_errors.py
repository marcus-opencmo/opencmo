"""Thông báo lỗi phải hữu ích nhưng không tiết lộ dữ liệu nội bộ."""

import errno
import subprocess

import httpx
import pytest
from yt_dlp.utils import DownloadError

from opencmo.media.ffmpeg import FFmpegError
from opencmo.worker.errors import processing_error


@pytest.mark.parametrize(('exc', 'expected'), [
    (DownloadError('Private video https://secret.test/token'), 'public video link'),
    (DownloadError("Sign in to confirm you’re not a bot"), 'upload the video file'),
    (DownloadError('Video unavailable'), 'different link'),
    # Đúng câu yt-dlp trả trên production (UAT 29/09): trước đây rơi về câu chung.
    (DownloadError('ERROR: [youtube] zzzzzzzzzzz: This video is unavailable'), 'different link'),
    (DownloadError('ERROR: [vimeo] 1: The web client only works when logged-in. Use --cookies'),
     'upload the video file'),
    (ValueError('Not enough clear speech was found to create useful clips. '
                'Try a spoken interview, podcast, or presentation.'), 'clear speech'),
    (RuntimeError('Groq returned an empty transcript.'), 'clear speech'),
    (ValueError('The moments you picked fall outside this video.'), 'time range'),
    (ValueError('Each selected moment must end after it starts.'), 'time range'),
    (RuntimeError('The model did not find any usable moments in this video.'), 'time range'),
    (RuntimeError('Gemini did not return the expected schema: SECRET'), 'Try again'),
    (RuntimeError('Groq returned 429: SECRET'), 'busy'),
    (RuntimeError('Groq returned 413: SECRET'), 'time range'),
    (RuntimeError('Audio is too large to transcribe: 52000000 bytes.'), 'time range'),
    (type('APITimeoutError', (Exception,), {})('SECRET'), 'connection'),
    (httpx.ReadTimeout('https://secret.test'), 'connection'),
    (subprocess.TimeoutExpired(['ffmpeg', '/secret'], 30), 'too long'),
    (OSError(errno.ENOSPC, '/secret'), 'storage'),
    (FFmpegError('No space left on device /secret'), 'storage'),
    (FFmpegError('moov atom not found /secret'), 'read this video'),
    (FFmpegError('Unknown encoder SECRET'), 'export'),
])
def test_classifies_known_failures(exc, expected):
    message = processing_error(exc)
    assert expected in message
    assert 'SECRET' not in message
    assert '/secret' not in message
    assert 'https://' not in message


def test_http_status_is_read_from_response():
    response = httpx.Response(429, request=httpx.Request('GET', 'https://secret.test'))
    assert 'busy' in processing_error(httpx.HTTPStatusError(
        'SECRET', request=response.request, response=response,
    ))


@pytest.mark.parametrize('text', [
    'SECRET private video quota timeout /internal/path',
    'Customer transcript says not enough clear speech',
    'Bearer SECRET https://secret.test',
])
def test_unknown_exceptions_never_pass_through_or_match_loose_keywords(text):
    message = processing_error(RuntimeError(text))
    assert message == 'We could not finish your clips. Try again. If it keeps failing, try another video.'


def test_network_error_wrapped_by_download_is_safe():
    error = DownloadError('Unable to download webpage: connection timed out https://secret.test')
    assert 'connection' in processing_error(error)


def test_stage_fallback_is_bounded():
    assert 'upload' in processing_error(RuntimeError('SECRET'), 'download')
    assert 'export' in processing_error(RuntimeError('SECRET'), 'render')
    assert 'SECRET' not in processing_error(RuntimeError('SECRET'), 'SECRET')


@pytest.mark.parametrize('detail', [
    "Unable to connect to proxy: Tunnel connection failed: 402 Payment Required",
    "ProxyError: Tunnel connection failed: 407 Proxy Authentication Required",
])
def test_proxy_account_failure_requires_service_recovery_not_user_retry(detail):
    message = processing_error(DownloadError(detail + ' https://user:SECRET@proxy.test'), 'probe')
    assert message == (
        'Video link imports are temporarily unavailable. '
        'Upload the video file instead, or try again after the service is restored.'
    )
    assert 'SECRET' not in message


def test_video_payment_error_is_not_misclassified_as_proxy_outage():
    assert 'link imports' not in processing_error(DownloadError('HTTP Error 402: Payment Required'))
