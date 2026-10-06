from types import SimpleNamespace

import pytest
from sqlglot import exp, parse_one

from lineage_guard.lineage import (
    LineageGraph,
    LineageQueryError,
    LineageRepository,
    StatementExecutor,
)
from lineage_guard.models import EvidenceOrigin, LineageEdge


def edge(source: str, target: str, level: str = "table") -> LineageEdge:
    return LineageEdge(source_table=source, target_table=target, level=level)


def test_graph_validates_every_hop() -> None:
    graph = LineageGraph(
        [
            edge("main.bronze.accounts", "main.silver.exposure"),
            edge("main.silver.exposure", "main.gold.expected_loss"),
        ]
    )
    assert graph.has_path(
        ["main.bronze.accounts", "main.silver.exposure", "main.gold.expected_loss"]
    )
    assert not graph.has_path(["main.bronze.accounts", "main.gold.expected_loss"])


def test_graph_deduplicates_edges_and_enumerates_verified_paths() -> None:
    first = edge("main.bronze.accounts", "main.silver.exposure")
    graph = LineageGraph(
        [
            first,
            first,
            edge("main.silver.exposure", "main.gold.expected_loss"),
        ]
    )
    assert len(graph.edges) == 2
    assert graph.source_tables() == {"main.bronze.accounts", "main.silver.exposure"}
    assert graph.paths_from({"main.bronze.accounts"}, max_depth=5) == [
        ["main.bronze.accounts", "main.silver.exposure"],
        ["main.bronze.accounts", "main.silver.exposure", "main.gold.expected_loss"],
    ]


def test_code_and_observed_dependency_evidence_remain_distinct() -> None:
    observed = edge("main.bronze.accounts", "main.silver.exposure")
    proposed = observed.model_copy(update={"origin": EvidenceOrigin.PROPOSED_CODE})
    graph = LineageGraph([observed, proposed])

    assert len(graph.edges) == 2
    assert graph.path_evidence([observed.source_table, observed.target_table])[0]["origins"] == [
        "observed_lineage",
        "proposed_code",
    ]


class FakeExecutor:
    workspace_id = 7474645195281143

    def __init__(self) -> None:
        self.calls: list[str] = []

    def query(self, statement: str) -> list[list[str | None]]:
        self.calls.append(statement)
        if "column_lineage" in statement and "main.bronze.accounts" in statement:
            return [
                [
                    "main.bronze.accounts",
                    "balance",
                    "main.silver.exposure",
                    "ead",
                    "2026-09-24 00:00:00",
                ]
            ]
        if "table_lineage" in statement and "main.silver.exposure" in statement:
            return [
                [
                    "main.silver.exposure",
                    "main.gold.expected_loss",
                    "MATERIALIZED_VIEW",
                    "2026-09-24 00:00:00",
                ]
            ]
        return []


def test_repository_walks_breadth_first() -> None:
    executor = FakeExecutor()
    repository = LineageRepository(executor=executor, lookback_days=30)  # type: ignore[arg-type]
    graph = repository.downstream_graph({"main.bronze.accounts"}, max_depth=5)
    assert graph.has_path(
        ["main.bronze.accounts", "main.silver.exposure", "main.gold.expected_loss"]
    )
    assert any("event_date >=" in call for call in executor.calls)
    assert len(graph.edges) == 2


class EntityExecutor:
    workspace_id = 7474645195281143

    def query(self, statement: str) -> list[list[str | None]]:
        if "table_lineage" in statement:
            return [
                [
                    "main.gold.expected_loss",
                    "databricks://dashboard/abc-123",
                    "DASHBOARD",
                    "DASHBOARD",
                    "abc-123",
                    "run-1",
                    "owner@example.com",
                    "2026-09-28 00:00:00",
                ]
            ]
        return []


def test_repository_includes_external_entity_consumers_without_traversing_them() -> None:
    repository = LineageRepository(executor=EntityExecutor(), lookback_days=30)  # type: ignore[arg-type]
    graph = repository.downstream_graph({"main.gold.expected_loss"}, max_depth=5)

    edge = graph.edges[0]
    assert edge.target_table == "databricks://dashboard/abc-123"
    assert edge.entity_id == "abc-123"
    assert edge.created_by == "owner@example.com"


@pytest.mark.parametrize("lineage_table", ["column_lineage", "table_lineage"])
def test_repository_excludes_other_workspace_evidence_for_the_same_dataset(
    lineage_table: str,
) -> None:
    active_workspace_id = 7474645195281143
    old_workspace_id = 7474650525906616
    source = "main.bronze.accounts"
    current_target = (
        "main.silver.current_exposure"
        if lineage_table == "column_lineage"
        else "databricks://dashboard/current-report"
    )
    old_target = (
        "main.silver.old_exposure"
        if lineage_table == "column_lineage"
        else "databricks://dashboard/old-report"
    )
    queried_tables: set[str] = set()
    identity_calls = 0

    def get_workspace_id() -> int:
        nonlocal identity_calls
        identity_calls += 1
        return active_workspace_id

    def execute_statement(*, statement: str, **_: object) -> SimpleNamespace:
        query = parse_one(statement, read="databricks")
        table = next(query.find_all(exp.Table)).name
        queried_tables.add(table)
        workspace_condition = next(
            (
                item
                for item in query.args["where"].find_all(exp.EQ)
                if isinstance(item.this, exp.Column) and item.this.name == "workspace_id"
            ),
            None,
        )
        workspace_filter = (
            int(workspace_condition.expression.this) if workspace_condition is not None else None
        )
        rows = []
        if table == lineage_table:
            for workspace_id, target in (
                (old_workspace_id, old_target),
                (active_workspace_id, current_target),
            ):
                if workspace_filter is not None and workspace_id != workspace_filter:
                    continue
                if table == "column_lineage":
                    rows.append([source, "balance", target, "ead", "2026-10-06 00:00:00"])
                else:
                    rows.append(
                        [
                            source,
                            target,
                            "DASHBOARD",
                            "DASHBOARD",
                            target.rsplit("/", 1)[-1],
                            "run-1",
                            "owner@example.com",
                            "2026-10-06 00:00:00",
                        ]
                    )
        return SimpleNamespace(
            status=SimpleNamespace(state="SUCCEEDED"),
            result=SimpleNamespace(data_array=rows),
        )

    workspace = SimpleNamespace(
        get_workspace_id=get_workspace_id,
        statement_execution=SimpleNamespace(execute_statement=execute_statement),
    )
    executor = StatementExecutor(warehouse_id="new-warehouse", workspace_client=workspace)
    graph = LineageRepository(executor=executor).downstream_graph({source}, max_depth=1)

    assert queried_tables == {"column_lineage", "table_lineage"}
    assert graph.downstream_tables() == {current_target}
    assert not graph.has_path([source, old_target])
    assert identity_calls == 1


@pytest.mark.parametrize("workspace_id", [None, 0, -1, True, "1 OR 1=1", 2**63])
def test_repository_rejects_invalid_authenticated_workspace_identity(workspace_id: object) -> None:
    workspace = SimpleNamespace(get_workspace_id=lambda: workspace_id)
    executor = StatementExecutor(warehouse_id="warehouse", workspace_client=workspace)

    with pytest.raises(LineageQueryError, match="authenticated workspace ID"):
        LineageRepository(executor=executor)


def test_repository_fails_closed_when_workspace_identity_is_unavailable() -> None:
    def get_workspace_id() -> int:
        raise RuntimeError("workspace identity lookup failed")

    workspace = SimpleNamespace(get_workspace_id=get_workspace_id)
    executor = StatementExecutor(warehouse_id="warehouse", workspace_client=workspace)

    with pytest.raises(RuntimeError, match="workspace identity lookup failed"):
        LineageRepository(executor=executor)


def test_statement_executor_retries_transient_lineage_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    def execute_statement(**_: object) -> SimpleNamespace:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("The request failed due to an unexpected condition.")
        return SimpleNamespace(
            status=SimpleNamespace(state="SUCCEEDED"),
            result=SimpleNamespace(data_array=[["main.bronze.accounts"]]),
        )

    monkeypatch.setattr("lineage_guard.lineage.time.sleep", lambda _: None)
    workspace = SimpleNamespace(
        statement_execution=SimpleNamespace(execute_statement=execute_statement)
    )
    executor = StatementExecutor(warehouse_id="warehouse", workspace_client=workspace)

    assert executor.query("SELECT 1") == [["main.bronze.accounts"]]
    assert calls == 2
