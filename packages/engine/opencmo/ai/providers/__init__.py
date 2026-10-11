"""Adapter provider sinh media. Đổi provider = một adapter + một dòng catalog."""

from __future__ import annotations

import os

from opencmo.ai.catalog import AiModel, SpecError
from opencmo.ai.providers.base import NOT_SET_UP, ProviderAdapter, ProviderError, Result
from opencmo.ai.providers.elevenlabs import ElevenLabsProvider
from opencmo.ai.providers.fake import FakeProvider
from opencmo.ai.providers.fal import FalProvider
from opencmo.ai.providers.three import ThreeLocalProvider, ThreeModalProvider

__all__ = ["ProviderAdapter", "ProviderError", "Result", "adapter_for"]


def fake_allowed() -> bool:
    """Model giả chỉ chạy khi được bật rõ ràng — không bao giờ là mặc định.

    Trên production một model giả lọt qua catalog nghĩa là người dùng trả
    credit cho một khung màu; chặn ở cả route lẫn worker.
    """
    return os.environ.get("OPENCMO_AI_FAKE") == "1"


def adapter_for(model: AiModel) -> ProviderAdapter:
    if model.provider == "fake":
        if not fake_allowed():
            raise SpecError("This model is not available.")
        return FakeProvider()
    if model.provider == "elevenlabs":
        key = os.environ.get("ELEVENLABS_API_KEY", "")
        if not key:
            raise SpecError(NOT_SET_UP)
        return ElevenLabsProvider(key)
    if model.provider == "fal":
        key = os.environ.get("FAL_KEY", "")
        if not key:
            raise SpecError(NOT_SET_UP)
        return FalProvider(key)
    if model.provider == "opencmo-3d":
        # Renderer của chính mình: không khoá, chỉ cần biết chạy ở đâu. Thiếu
        # cả hai thì model giả (khi được bật) vẽ khung màu thay cho cảnh 3D.
        mode = os.environ.get("OPENCMO_3D", "")
        if mode == "modal":
            return ThreeModalProvider()
        if mode == "local":
            return ThreeLocalProvider()
        if fake_allowed():
            return FakeProvider()
        raise SpecError(NOT_SET_UP)
    raise SpecError("This model is not available.")
