"""Output moderation: fal's NSFW classifier plus Claude, both must pass; failures never pass."""

from __future__ import annotations

import sys
import types

import httpx
import pytest

from opencmo.ai import moderation
from opencmo.ai.catalog import get_model
from opencmo.ai.providers.base import ProviderError


@pytest.fixture
def image(tmp_path):
    path = tmp_path / "result.png"
    path.write_bytes(b"\x89PNG fake")
    return path


@pytest.fixture(autouse=True)
def keys(monkeypatch):
    monkeypatch.setenv("FAL_KEY", "fal")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "claude")


def _nsfw(monkeypatch, status=200, flags=(False,), raises=False):
    seen = {}

    def post(url, **kwargs):
        seen.update(url=url, **kwargs)
        if raises:
            raise httpx.ConnectError("down")
        return httpx.Response(status, json={"has_nsfw_concepts": list(flags)}, request=httpx.Request("POST", url))

    monkeypatch.setattr(moderation.httpx, "post", post)
    return seen


def _claude(monkeypatch, allowed=True, stop="end_turn", error=None):
    seen = {}

    class APIStatusError(Exception):
        status_code = 400

    class RateLimitError(Exception):
        pass

    class Messages:
        def parse(self, **kwargs):
            seen.update(kwargs)
            if error:
                raise error(RateLimitError, APIStatusError)
            verdict = moderation._Verdict(allowed=allowed, category="none" if allowed else "real_person")
            return types.SimpleNamespace(stop_reason=stop, parsed_output=verdict)

    class Anthropic:
        def __init__(self, **_kwargs):
            self.messages = Messages()

    fake = types.SimpleNamespace(
        Anthropic=Anthropic,
        APIConnectionError=type("APIConnectionError", (Exception,), {}),
        RateLimitError=RateLimitError,
        InternalServerError=type("InternalServerError", (Exception,), {}),
        APIStatusError=APIStatusError,
    )
    monkeypatch.setitem(sys.modules, "anthropic", fake)
    return seen


def test_clean_image_passes_both_checks(monkeypatch, image):
    nsfw = _nsfw(monkeypatch)
    claude = _claude(monkeypatch)
    moderation.check_output(get_model("fal-nano-banana"), {"prompt": "a laptop"}, image)
    assert nsfw["url"] == moderation.NSFW_ENDPOINT
    assert nsfw["headers"] == {"Authorization": "Key fal"}
    assert nsfw["json"]["image_urls"][0].startswith("data:image/png;base64,")
    assert claude["system"] == moderation.POLICY
    assert claude["messages"][0]["content"][0]["type"] == "image"


@pytest.mark.parametrize("flags", [(True,), (), (False, False)])
def test_nsfw_flag_or_wrong_shape_blocks(monkeypatch, image, flags):
    _nsfw(monkeypatch, flags=flags)
    _claude(monkeypatch)
    with pytest.raises(ProviderError) as err:
        moderation.check_images([image])
    assert not err.value.retryable


def test_claude_block_or_refusal_blocks(monkeypatch, image):
    _nsfw(monkeypatch)
    _claude(monkeypatch, allowed=False)
    with pytest.raises(ProviderError, match="content policy"):
        moderation.check_images([image])
    _claude(monkeypatch, stop="refusal")
    with pytest.raises(ProviderError, match="content policy"):
        moderation.check_images([image])


def test_unreachable_checks_are_retryable_not_passed(monkeypatch, image):
    _nsfw(monkeypatch, raises=True)
    with pytest.raises(ProviderError) as err:
        moderation.check_images([image])
    assert err.value.retryable

    _nsfw(monkeypatch)
    _claude(monkeypatch, error=lambda rate, _status: rate("slow down"))
    with pytest.raises(ProviderError) as err:
        moderation.check_images([image])
    assert err.value.retryable


def test_client_error_from_a_check_blocks(monkeypatch, image):
    _nsfw(monkeypatch, status=422)
    with pytest.raises(ProviderError) as err:
        moderation.check_images([image])
    assert not err.value.retryable


def test_skipped_without_keys(monkeypatch, image):
    monkeypatch.delenv("FAL_KEY")
    monkeypatch.setattr(moderation.httpx, "post", lambda *_a, **_k: pytest.fail("no call without keys"))
    moderation.check_output(get_model("fal-nano-banana"), {"prompt": "x"}, image)
    assert not moderation.ready()
