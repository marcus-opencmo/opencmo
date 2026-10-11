"""Moment selection runs on Claude."""

from __future__ import annotations

import pytest

from opencmo.config import Config


def _cfg(monkeypatch, **env: str) -> Config:
    for name in ("ANTHROPIC_API_KEY", "OPENCMO_SELECT_MODEL"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    return Config()


def test_default_model_is_haiku(monkeypatch):
    assert _cfg(monkeypatch, ANTHROPIC_API_KEY="a").resolved_select_model == "claude-haiku-4-5"


def test_model_can_be_overridden(monkeypatch):
    cfg = _cfg(monkeypatch, ANTHROPIC_API_KEY="a", OPENCMO_SELECT_MODEL="claude-sonnet-5-5")
    assert cfg.resolved_select_model == "claude-sonnet-5-5"


def test_missing_key_fails_clearly(monkeypatch):
    with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
        _cfg(monkeypatch).validate_for_select()
