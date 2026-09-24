from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from lineage_guard.config import GuardConfig, load_config


def test_repository_config_loads() -> None:
    config = load_config(Path("lineage_guard.yml"))
    assert config.version == 1
    assert config.datasets["src/credit_risk/transformations/bronze/loan_accounts.sql"].table == (
        "proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts"
    )
    assert len(config.datasets) == 12


def test_config_rejects_non_fqn() -> None:
    raw = yaml.safe_load(Path("lineage_guard.yml").read_text())
    raw["datasets"]["src/example.sql"] = {"table": "not-a-table", "layer": "bronze"}
    with pytest.raises(ValidationError):
        GuardConfig.model_validate(raw)


def test_config_rejects_duplicate_dataset_mappings() -> None:
    raw = yaml.safe_load(Path("lineage_guard.yml").read_text())
    raw["datasets"]["src/duplicate.sql"] = raw["datasets"][
        "src/credit_risk/transformations/bronze/loan_accounts.sql"
    ]
    with pytest.raises(ValidationError):
        GuardConfig.model_validate(raw)
