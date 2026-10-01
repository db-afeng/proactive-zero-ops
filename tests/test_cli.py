import argparse
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from lineage_guard.bundle import BundleResource, ResourceChange
from lineage_guard.cli import assess
from lineage_guard.config import GuardConfig
from lineage_guard.lineage import LineageGraph
from lineage_guard.models import LineageEdge

SOURCE = "proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts"
OTHER = "proactive_zero_ops_catalog.proactive_zero_ops_bronze.collateral"
TARGET = "proactive_zero_ops_catalog.proactive_zero_ops_silver.loan_exposure"
BASE_SHA = "a" * 40
HEAD_SHA = "b" * 40


def arguments(tmp_path: Path) -> argparse.Namespace:
    return argparse.Namespace(
        repo=str(tmp_path),
        config="lineage_guard.yml",
        bundle_file="databricks.yml",
        target="dev",
        max_lineage_depth=None,
        base=BASE_SHA,
        head=HEAD_SHA,
        repository="db-afeng/proactive-zero-ops",
        pull_request_number=4,
        output=str(tmp_path / "assessment.json"),
        markdown_output=str(tmp_path / "assessment.md"),
        restricted_evidence_dir=str(tmp_path / "restricted"),
    )


class FakeChanges(SimpleNamespace):
    def restricted_evidence(self) -> dict[str, object]:
        return {"sensitive": "SENSITIVE_ASSET_METADATA"}


def changes(*tables: str) -> FakeChanges:
    empty_bundle = SimpleNamespace(
        configuration_changes=(),
        variable_changes=(),
        resource_changes=(),
        source_changes=(),
    )
    return FakeChanges(
        base_sha=BASE_SHA,
        head_sha=HEAD_SHA,
        complete=True,
        has_relevant_changes=bool(tables),
        changed_files=[f"src/{index}.sql" for index, _ in enumerate(tables)],
        affected_datasets=frozenset(tables),
        proposed_code_edges=(),
        meaningful_sql_changes=(),
        bundle_changes=empty_bundle,
        target="dev",
        issues=(),
        proposed=SimpleNamespace(documents=()),
    )


def patch_inputs(monkeypatch: pytest.MonkeyPatch, change_set: FakeChanges) -> None:
    monkeypatch.setattr("lineage_guard.cli.load_config", lambda _: GuardConfig())
    monkeypatch.setattr("lineage_guard.cli.collect_changes", lambda *_args, **_kwargs: change_set)


def public_result(tmp_path: Path) -> dict[str, object]:
    return json.loads((tmp_path / "assessment.json").read_text())


def restricted_result(tmp_path: Path) -> dict[str, object]:
    records = list((tmp_path / "restricted").glob("lgr_*.json"))
    assert len(records) == 1
    return json.loads(records[0].read_text())


def test_no_semantic_or_bundle_change_passes_without_databricks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    patch_inputs(monkeypatch, changes())
    exit_code = assess(arguments(tmp_path))
    assert exit_code == 0
    assert public_result(tmp_path)["outcome"] == "pass"
    restricted = restricted_result(tmp_path)
    assert restricted["schema_version"] == 3
    assert restricted["evidence"]["display_evidence"]["schema_version"] == 1
    assert restricted["source"] == {
        "provider": "github",
        "repository": "db-afeng/proactive-zero-ops",
        "pull_request_number": 4,
        "base_sha": BASE_SHA,
        "head_sha": HEAD_SHA,
    }


def test_unknown_resource_without_output_dataset_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    candidate = changes()
    candidate.has_relevant_changes = True
    candidate.bundle_changes.resource_changes = (
        ResourceChange(
            kind="added",
            before=None,
            after=BundleResource(
                resource_type="future_resources",
                key="new_resource",
                config={"name": "new-resource"},
                declaring_files=("resources/new_resource.yml",),
            ),
        ),
    )
    patch_inputs(monkeypatch, candidate)

    exit_code = assess(arguments(tmp_path))

    assert exit_code == 2
    assert public_result(tmp_path)["outcome"] == "error"
    assert "Relevant bundle changes did not resolve to any output dataset" in json.dumps(
        restricted_result(tmp_path)
    )


@pytest.mark.parametrize("message", ["authentication failed", "warehouse unavailable"])
def test_authentication_and_warehouse_failures_fail_closed_without_public_details(
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
    public = (tmp_path / "assessment.json").read_text()
    restricted = restricted_result(tmp_path)
    assert exit_code == 2
    assert json.loads(public)["outcome"] == "error"
    assert message not in public
    assert message in json.dumps(restricted)


def test_partial_missing_lineage_is_explicit_in_restricted_evidence_and_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    patch_inputs(monkeypatch, changes(SOURCE, OTHER))
    monkeypatch.setenv("DATABRICKS_WAREHOUSE_ID", "warehouse")
    monkeypatch.setattr("lineage_guard.cli.StatementExecutor", lambda **_: object())
    graph = LineageGraph([LineageEdge(source_table=SOURCE, target_table=TARGET, level="table")])
    repository = SimpleNamespace(downstream_graph=lambda *_args, **_kwargs: graph)
    monkeypatch.setattr("lineage_guard.cli.LineageRepository", lambda **_: repository)

    exit_code = assess(arguments(tmp_path))
    public = public_result(tmp_path)
    restricted = restricted_result(tmp_path)
    assert exit_code == 2
    assert public["outcome"] == "error"
    assert OTHER not in json.dumps(public)
    assert OTHER in json.dumps(restricted)


def test_public_outputs_have_identical_allowlisted_information(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    patch_inputs(monkeypatch, changes())
    assert assess(arguments(tmp_path)) == 0
    public = public_result(tmp_path)
    markdown = (tmp_path / "assessment.md").read_text()
    assert set(public) == {
        "schema_version",
        "assessment_reference",
        "outcome",
        "message",
    }
    assert str(public["assessment_reference"]) in markdown
    assert str(public["message"]) in markdown
    assert "SENSITIVE_ASSET_METADATA" not in markdown
