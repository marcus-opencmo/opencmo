"""One default LLM provider for moment selection (OPENCMO_LLM_PROVIDER)."""

from __future__ import annotations

import pytest

from opencmo.config import Config


def _cfg(monkeypatch, **env: str) -> Config:
    for name in ("OPENCMO_LLM_PROVIDER", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    return Config()


def test_without_setting_the_existing_key_decides(monkeypatch):
    assert _cfg(monkeypatch, GEMINI_API_KEY="g").select_provider == "gemini"
    assert _cfg(monkeypatch, ANTHROPIC_API_KEY="a").select_provider == "anthropic"


def test_setting_wins_over_key_order(monkeypatch):
    cfg = _cfg(monkeypatch, OPENCMO_LLM_PROVIDER="Anthropic", GEMINI_API_KEY="g", ANTHROPIC_API_KEY="a")
    assert cfg.select_provider == "anthropic"
    assert cfg.resolved_select_model == "claude-haiku-4-5"


def test_setting_without_its_key_fails_clearly(monkeypatch):
    cfg = _cfg(monkeypatch, OPENCMO_LLM_PROVIDER="anthropic", GEMINI_API_KEY="g")
    with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY is missing"):
        cfg.validate_for_select()
