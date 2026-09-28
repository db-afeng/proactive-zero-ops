from pathlib import Path

import pytest
from pydantic import ValidationError

from lineage_guard.config import GuardConfig, load_config


def test_repository_config_is_minimal_and_has_no_dataset_mapping() -> None:
    config = load_config(Path("lineage_guard.yml"))

    assert config == GuardConfig.model_validate(
        {"version": 1, "settings": {"max_lineage_depth": 5}}
    )
    assert "datasets" not in config.__class__.model_fields


def test_config_is_optional_and_uses_safe_operational_defaults(tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist.yml"

    assert load_config() == GuardConfig()
    assert load_config(missing) == GuardConfig()
    assert GuardConfig().settings.max_lineage_depth == 5


@pytest.mark.parametrize("depth", [0, 21])
def test_config_rejects_unsafe_lineage_depth(depth: int) -> None:
    with pytest.raises(ValidationError):
        GuardConfig.model_validate({"version": 1, "settings": {"max_lineage_depth": depth}})


@pytest.mark.parametrize(
    "untrusted_setting",
    [
        {"datasets": {"src/example.sql": {"table": "main.s.t"}}},
        {"settings": {"block_confidence": 0.1}},
        {"settings": {"governed_roots": ["src"]}},
        {"settings": {"lineage_lookback_days": 365}},
    ],
)
def test_config_rejects_mapping_enforcement_and_disclosure_controls(
    untrusted_setting: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        GuardConfig.model_validate({"version": 1, **untrusted_setting})
