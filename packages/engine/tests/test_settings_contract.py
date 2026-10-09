"""Hợp đồng settings: một bộ fixture, hai bản cài đặt.

Cùng những file JSON này được `apps/web/lib/settings-schema.check.ts` chạy lại ở
phía TypeScript. Đó là điểm của cả Phase này: luật settings sống ở MỘT chỗ
(`packages/contracts/revision-settings.schema.json`) và hai bản cài đặt được đo
bằng cùng một cái thước, thay vì trôi xa nhau vài tuần rồi mới lộ ra bằng một
preview render hai lần.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from opencmo.editing.models import (
    LEGACY_KEYS,
    RENDER_PROFILE_VERSION,
    SettingsError,
    canonical_json,
    parse_settings,
    settings_hash,
)

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "tests" / "contracts" / "settings"
SCHEMA = ROOT / "packages" / "contracts" / "revision-settings.schema.json"


def _load(folder: str) -> list[tuple[str, dict]]:
    files = sorted((FIXTURES / folder).glob("*.json"))
    assert files, f"không tìm thấy fixture nào trong {folder}"
    return [(path.stem, json.loads(path.read_text(encoding="utf-8"))) for path in files]


VALID = _load("valid")
INVALID = _load("invalid")
HASHES = _load("hash")


def test_schema_and_python_agree_on_the_render_profile():
    """Hai phía đọc CÙNG một khoá, nên không có đường nào để lệch phiên bản."""
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    assert schema["x-render-profile"] == RENDER_PROFILE_VERSION


def test_legacy_keys_are_accepted_and_dropped():
    """`caption_preset` (bỏ ở R4) còn nằm trong settings gốc đã lưu: phải đọc
    được, và không quay lại bản chuẩn hoá — nếu không hash của bản lưu lại sẽ lệch."""
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    assert frozenset(schema["x-legacy-keys"]) == LEGACY_KEYS
    old = {"source_start": 0.0, "source_end": 10.0, "caption_preset": "minimal"}
    assert "caption_preset" not in parse_settings(old, source_duration=30.0).to_dict()


def test_fixture_counts_cover_the_contract():
    # Ngưỡng của plan D1: ít nhất 6 ca hợp lệ và 15 ca không hợp lệ.
    assert len(VALID) >= 6
    assert len(INVALID) >= 15


@pytest.mark.parametrize("name,fixture", VALID, ids=[name for name, _ in VALID])
def test_valid_fixtures_parse(name: str, fixture: dict):
    parse_settings(fixture["settings"], source_duration=fixture["source_duration"])


@pytest.mark.parametrize("name,fixture", VALID, ids=[name for name, _ in VALID])
def test_valid_fixtures_have_a_stable_hash(name: str, fixture: dict):
    """Parse hai lần ra cùng hash, và parse lại bản đã lưu cũng ra cùng hash.

    Ca thứ hai mới là ca thật: bản đã lưu đi qua `to_dict()` nên có đủ khoá mặc
    định, còn bản client gửi thì không. Hai bên phải trùng hash, nếu không thì
    mở một clip lên rồi bấm Save mà không sửa gì cũng đẻ ra một revision mới.
    """
    first = parse_settings(fixture["settings"], source_duration=fixture["source_duration"]).to_dict()
    again = parse_settings(first, source_duration=fixture["source_duration"]).to_dict()
    assert settings_hash(first) == settings_hash(again)


@pytest.mark.parametrize("name,fixture", VALID, ids=[name for name, _ in VALID])
def test_valid_fixtures_match_the_typescript_canonical_json(name: str, fixture: dict):
    """Khoá `canonical` tuỳ chọn: chỉ fixture nào từng lệch hai bên mới cần.

    "Parse lại ổn định" ở trên chỉ so một bên với chính nó, nên nó mù với thứ
    kiểu `settings-schema.ts` cắt lề `texts[].text` mà Python thì không — cùng
    input, hai chuỗi canonical, hai `settings_hash`.
    """
    if "canonical" not in fixture:
        pytest.skip("fixture không khai báo canonical")
    parsed = parse_settings(fixture["settings"], source_duration=fixture["source_duration"])
    assert canonical_json(parsed.to_dict()) == fixture["canonical"]


@pytest.mark.parametrize("name,fixture", INVALID, ids=[name for name, _ in INVALID])
def test_invalid_fixtures_are_rejected_with_the_exact_message(name: str, fixture: dict):
    """Message phải TRÙNG CHỮ, không chỉ "có ném lỗi".

    Chuỗi này hiện thẳng lên màn hình người dùng, và bản zod phía web bị giữ ở
    đúng chuỗi đó — nên đổi lời ở một phía là làm đỏ test ở cả hai.
    """
    with pytest.raises(SettingsError) as caught:
        parse_settings(fixture["settings"], source_duration=fixture["source_duration"])
    assert str(caught.value) == fixture["error"]


@pytest.mark.parametrize("name,fixture", HASHES, ids=[name for name, _ in HASHES])
def test_hash_fixtures_match(name: str, fixture: dict):
    assert fixture["render_profile"] == RENDER_PROFILE_VERSION
    payload = {"render_profile": RENDER_PROFILE_VERSION, "settings": fixture["settings"]}
    assert canonical_json(payload) == fixture["canonical"]
    assert settings_hash(fixture["settings"]) == fixture["expected_hash"]


def test_canonical_json_sorts_keys_and_normalises_numbers():
    assert canonical_json({"b": 1, "a": 2.0}) == '{"a":2,"b":1}'
    assert canonical_json([0.1 + 0.2]) == "[0.30000000000000004]"
    assert canonical_json({"x": None, "y": True}) == '{"x":null,"y":true}'


def test_canonical_json_sorts_keys_by_utf16_code_units():
    """Emoji là cặp thay thế trong UTF-16 nên nó đứng TRƯỚC U+FFFD.

    `sorted()` trần của Python xếp ngược lại. Không có ca này thì lỗi chỉ lộ ra
    khi có người đặt emoji làm khoá — và lúc đó nó là một hash lệch im lặng.
    """
    assert canonical_json({"\U0001F600": 1, "�": 2}) == '{"\U0001F600":1,"�":2}'


def test_hash_changes_when_the_render_profile_changes(monkeypatch):
    settings = {"source_start": 0, "source_end": 20}
    before = settings_hash(settings)
    monkeypatch.setattr("opencmo.editing.models.RENDER_PROFILE_VERSION", 99)
    assert settings_hash(settings) != before
