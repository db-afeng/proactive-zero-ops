import argparse
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from lineage_guard.cli import assess
from lineage_guard.config import load_config
from lineage_guard.lineage import LineageGraph
from lineage_guard.models import LineageEdge

SOURCE = "proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts"
OTHER = "proactive_zero_ops_catalog.proactive_zero_ops_bronze.collateral"
TARGET = "proactive_zero_ops_catalog.proactive_zero_ops_silver.loan_exposure"


def arguments(tmp_path: Path) -> argparse.Namespace:
    return argparse.Namespace(
        repo=str(tmp_path),
        config="lineage_guard.yml",
        base="base",
        head="head",
        output=str(tmp_path / "assessment.json"),
        markdown_output=str(tmp_path / "assessment.md"),
    )


def changes(*tables: str) -> SimpleNamespace:
    datasets = [
        SimpleNamespace(
            path=f"src/{index}.sql",
            table=table,
            diff="changed",
            base_sql="SELECT 1",
            head_sql="SELECT 2",
        )
        for index, table in enumerate(tables)
    ]
    return SimpleNamespace(
        changed_files=[dataset.path for dataset in datasets],
        datasets=datasets,
        head_sha="head",
    )


def patch_inputs(monkeypatch: pytest.MonkeyPatch, change_set: SimpleNamespace) -> None:
    config = load_config(Path("lineage_guard.yml"))
    monkeypatch.setattr("lineage_guard.cli.load_config", lambda _: config)
    monkeypatch.setattr("lineage_guard.cli.collect_changes", lambda *_: change_set)


def test_no_governed_change_passes_without_databricks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    patch_inputs(monkeypatch, changes())
    exit_code = assess(arguments(tmp_path))
    result = json.loads((tmp_path / "assessment.json").read_text())
    assert exit_code == 0
    assert result["status"] == "pass"


@pytest.mark.parametrize("message", ["authentication failed", "warehouse unavailable"])
def test_authentication_and_warehouse_failures_fail_closed(
    message: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_inputs(monkeypatch, changes(SOURCE))
    monkeypatch.setenv("DATABRICKS_WAREHOUSE_ID", "warehouse")

    def fail_executor(*_: object, **__: object) -> None:
        raise RuntimeError(message)

    monkeypatch.setattr("lineage_guard.cli.StatementExecutor", fail_executor)
    exit_code = assess(arguments(tmp_path))
    result = json.loads((tmp_path / "assessment.json").read_text())
    assert exit_code == 2
    assert result["status"] == "error"
    assert message in result["error"]


def test_partial_missing_lineage_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    patch_inputs(monkeypatch, changes(SOURCE, OTHER))
    monkeypatch.setenv("DATABRICKS_WAREHOUSE_ID", "warehouse")
    monkeypatch.setattr("lineage_guard.cli.StatementExecutor", lambda **_: object())
    graph = LineageGraph([LineageEdge(source_table=SOURCE, target_table=TARGET, level="table")])
    repository = SimpleNamespace(downstream_graph=lambda *_args, **_kwargs: graph)
    monkeypatch.setattr("lineage_guard.cli.LineageRepository", lambda **_: repository)

    exit_code = assess(arguments(tmp_path))
    result = json.loads((tmp_path / "assessment.json").read_text())
    assert exit_code == 2
    assert result["status"] == "error"
    assert OTHER in result["error"]
